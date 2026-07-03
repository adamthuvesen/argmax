/**
 * LauncherGlobe — an animated, rotating dot-Earth backdrop for the new-session
 * launcher, built on `three-globe` (the WebGL globe-visualization library that
 * powers globe.gl). three-globe renders the dark orb, the lat/long graticules,
 * the dotted continents (hex-polygons drawn as dots), and the atmosphere glow;
 * we add a slow spin and orbital telemetry around it.
 *
 * Design constraints (see CLAUDE.md / styling.md):
 * - Renders only when `enabled` (the user pref) is on. Mounts behind the
 *   launcher surface and never takes pointer events.
 * - The orb stays dark in every theme so the glow always reads against it — on a
 *   light page it looks like a dark globe object, not invisible additive glow.
 * - Respects `prefers-reduced-motion` (one static frame, no RAF loop), pauses
 *   when the document is hidden, and disposes all WebGL resources on unmount.
 *
 * The glowing earth itself comes from a vetted library rather than hand-rolled
 * geometry; only the surrounding network + lifecycle glue live here.
 */
import { useEffect, useRef, type JSX } from "react";
import * as THREE from "three";
import ThreeGlobe from "three-globe";
import landPolygons from "../lib/landPolygons.json";

interface Palette {
  orb: number;
  orbOpacity: number;
  dots: string; // glowing land dots
  graticule: number;
  graticuleOpacity: number;
  orbit: number; // orbital rings + signal arcs
  orbitGlow: number; // satellites
  orbitOpacity: number;
  atmInner: number; // atmosphere core — a bright rim hugging the silhouette
  atmOuter: number; // atmosphere halo — wider, cooler violet bloom
  star: number; // starfield particles
}

// One cosmic palette for every app theme: the globe always sits in its own pocket
// of space (see .launcher-globe-space), so its look stays theme-independent.
function paletteFor(): Palette {
  return {
    orb: 0x000000,
    orbOpacity: 0.4,
    dots: "#ffffff",
    graticule: 0xffffff,
    graticuleOpacity: 0.05,
    orbit: 0xcccccc,
    orbitGlow: 0xffffff,
    orbitOpacity: 0.6,
    atmInner: 0xffffff, // crisp bright rim hugging the silhouette
    atmOuter: 0xffffff, // tight white bloom just outside (kept white, not grey)
    star: 0xffffff
  };
}

// three-globe uses a globe radius of 100 world units.
const FOV = 32;
const CAMERA_Z = 410;
const SPIN_PER_SEC = (2 * Math.PI) / 130; // one full turn ≈ 130s

// Orbital telemetry around the globe. Radii are in three-globe units (globe
// radius = 100); rx/ry orient each orbital plane, phases place satellites on it.
const ORBITS = [
  { radius: 111, rx: 0.66, ry: 0.2, speed: 0.17, phases: [0, 0.52] },
  { radius: 121, rx: -0.8, ry: 0.5, speed: -0.11, phases: [0.28, 0.7] },
  { radius: 133, rx: 0.34, ry: -0.6, speed: 0.08, phases: [0.74] }
];
const ARC_COUNT = 14;
// Signal hubs (lat, lng) — recognizable cities so arcs trace plausible routes.
const ARC_HUBS: ReadonlyArray<readonly [number, number]> = [
  [37.77, -122.42], [40.71, -74.0], [51.5, -0.12], [59.33, 18.07],
  [52.52, 13.4], [6.52, 3.38], [-1.29, 36.82], [-23.55, -46.63],
  [35.68, 139.69], [1.35, 103.82], [-33.87, 151.21], [12.97, 77.59], [25.2, 55.27]
];

interface ArcDatum {
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  dashLen: number;
  dashGap: number;
  initGap: number;
  time: number;
}

/** `0xRRGGBB` + alpha → a `rgba()` string for three-globe color accessors. */
function rgba(hex: number, a: number): string {
  return `rgba(${(hex >> 16) & 255}, ${(hex >> 8) & 255}, ${hex & 255}, ${a})`;
}

/** Soft radial sprite used for satellites (white core → transparent), tinted per theme. */
function makeDotTexture(): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.55, "rgba(255,255,255,0.96)");
  g.addColorStop(0.82, "rgba(255,255,255,0.38)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.Texture(c);
  t.needsUpdate = true;
  return t;
}

/**
 * Fresnel atmosphere shell: a sphere whose backside lights up where the view
 * grazes its silhouette, giving the globe a luminous rim. Layer two (a sharp
 * inner rim + a wide soft halo) for the cyan→violet bloom in the references.
 */
function makeAtmosphere(radius: number, color: number, power: number, intensity: number): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uPower: { value: power },
      uIntensity: { value: intensity }
    },
    vertexShader: `
      varying vec3 vN;
      varying vec3 vView;
      void main() {
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uPower;
      uniform float uIntensity;
      varying vec3 vN;
      varying vec3 vView;
      void main() {
        float f = pow(1.0 - abs(dot(vN, vView)), uPower);
        gl_FragColor = vec4(uColor * uIntensity * f, f);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    depthWrite: false
  });
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 48), mat);
}

/** A drifting field of glowing motes around the globe (the reference particle haze). */
function makeStarfield(count: number, color: number): THREE.Points {
  const pos = new Float32Array(count * 3);
  const alpha = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    // Random point in a spherical shell around the globe.
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const r = 118 + Math.random() * 190;
    const s = Math.sqrt(1 - u * u);
    pos[i * 3] = Math.cos(th) * s * r;
    pos[i * 3 + 1] = Math.sin(th) * s * r;
    pos[i * 3 + 2] = u * r;
    alpha[i] = 0.25 + Math.random() * 0.75;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1));
  const mat = new THREE.PointsMaterial({
    color,
    size: 1.7,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  return new THREE.Points(geo, mat);
}

/** Recolor three-globe's internal line materials post-build. */
function tuneGlobeMaterials(globe: ThreeGlobe, palette: Palette): void {
  globe.traverse((obj) => {
    // Graticule grid lines.
    if (obj instanceof THREE.LineSegments) {
      const materials = (Array.isArray(obj.material) ? obj.material : [obj.material]) as THREE.Material[];
      for (const line of materials) {
        if (line instanceof THREE.LineBasicMaterial) {
          line.color.setHex(palette.graticule);
          line.transparent = true;
          line.opacity = palette.graticuleOpacity;
        }
      }
      return;
    }

    // Land dots. three-globe renders each dot as an outward-facing disc with a
    // lit MeshLambertMaterial, so the directional key light carves a day/night
    // terminator across the globe and the dark hemisphere's dots sink into the
    // black orb (central/southern Africa "looks like water"). Drive them with
    // emissive so they stay uniformly bright regardless of facing.
    if ((obj as { __globeObjType?: string }).__globeObjType === "hexPolygon" && obj instanceof THREE.Mesh) {
      const materials = (Array.isArray(obj.material) ? obj.material : [obj.material]) as THREE.Material[];
      for (const mat of materials) {
        if (mat instanceof THREE.MeshLambertMaterial) {
          mat.emissive.set(palette.dots);
          mat.emissiveIntensity = 1;
          mat.color.set(0x000000); // kill diffuse so the key light can't shade the dots
          // Additive so the dots glow on the dark globe and the dense limb blooms.
          mat.blending = THREE.AdditiveBlending;
          mat.transparent = true;
          mat.depthWrite = false;
        }
      }
    }
  });
}

export function LauncherGlobe({ enabled }: { enabled: boolean }): JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    } catch {
      return; // No WebGL (jsdom / headless) — leave the canvas blank.
    }

    const palette = paletteFor();
    const pixelRatio = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2);
    renderer.setPixelRatio(pixelRatio);
    renderer.setClearColor(0x000000, 0);

    const sizeOf = (): { w: number; h: number } => {
      const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 820;
      const h = canvas.clientHeight || canvas.parentElement?.clientHeight || 600;
      return { w: Math.max(1, w), h: Math.max(1, h) };
    };
    let { w, h } = sizeOf();
    renderer.setSize(w, h, false);

    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 1.7));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
    keyLight.position.set(-1, 0.4, 0.8);
    scene.add(keyLight);

    const camera = new THREE.PerspectiveCamera(FOV, w / h, 1, 2000);
    camera.position.set(0, 0, CAMERA_Z);

    // --- The globe (three-globe). No solid orb: the dots float as a glowing
    // shell over the dark pocket, with the custom fresnel atmosphere giving the
    // rim. graticules add faint structure. ---
    const globe = new ThreeGlobe({ animateIn: false })
      .showGlobe(false)
      .showGraticules(true)
      .showAtmosphere(false)
      .hexPolygonsData(landPolygons as object[])
      // Res 3 spaces the dots apart for a clean halftone read (now that the
      // degenerate-polygon bug is fixed, res 3 covers all land with no holes);
      // margin 0.32 keeps each dot chunky. dotResolution 6 keeps discs cheap.
      .hexPolygonResolution(3)
      .hexPolygonMargin(0.32)
      .hexPolygonDotResolution(6)
      .hexPolygonUseDots(true)
      .hexPolygonAltitude(0.012)
      .hexPolygonColor(() => palette.dots);

    tuneGlobeMaterials(globe, palette);

    const tilt = new THREE.Group();
    tilt.rotation.z = 0.36;
    tilt.rotation.x = -0.12;
    // Offset up-and-right of the composer as a smaller object in space.
    tilt.position.set(46, 28, 0);
    tilt.scale.setScalar(0.63);
    tilt.add(globe);
    globe.rotation.y = -0.5;
    scene.add(tilt);

    // --- Atmosphere: a sharp inner rim (cyan) + a wide soft halo (violet) for the
    // cyan→violet bloom. Parented to `tilt` so they stay centered on the globe. ---
    tilt.add(makeAtmosphere(101.5, palette.atmInner, 6.8, 2.6)); // sharp bright edge on the silhouette
    tilt.add(makeAtmosphere(107, palette.atmOuter, 3.6, 0.5)); // tight bloom just outside it

    // --- Starfield: a slowly drifting haze of glowing motes around the globe. ---
    const starGroup = new THREE.Group();
    starGroup.add(makeStarfield(520, palette.star));
    tilt.add(starGroup);

    // --- Orbital telemetry. The launcher Earth reads as a live command center:
    // signal arcs trace routes between hub cities, and satellites track tilted
    // orbits that duck behind the globe. Replaces the old drifting corner plexus. ---
    const reduceMotion =
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    const still = !!reduceMotion?.matches;
    const blend = THREE.AdditiveBlending;
    const rnd = (a: number, b: number): number => a + Math.random() * (b - a);

    // Signal arcs across the surface — three-globe's vetted, self-animating arc
    // layer (flowing dashes between hub cities).
    const arcs: ArcDatum[] = [];
    for (let i = 0; i < ARC_COUNT; i += 1) {
      const a = Math.floor(Math.random() * ARC_HUBS.length);
      let b = Math.floor(Math.random() * ARC_HUBS.length);
      if (b === a) b = (b + 1) % ARC_HUBS.length;
      arcs.push({
        startLat: ARC_HUBS[a][0],
        startLng: ARC_HUBS[a][1],
        endLat: ARC_HUBS[b][0],
        endLng: ARC_HUBS[b][1],
        dashLen: rnd(0.25, 0.55),
        dashGap: rnd(0.6, 1.8),
        initGap: rnd(0, 3),
        time: rnd(4200, 9000)
      });
    }
    globe
      .arcsData(arcs)
      .arcStartLat((d) => (d as ArcDatum).startLat)
      .arcStartLng((d) => (d as ArcDatum).startLng)
      .arcEndLat((d) => (d as ArcDatum).endLat)
      .arcEndLng((d) => (d as ArcDatum).endLng)
      .arcColor(() => [
        rgba(palette.orbit, 0),
        rgba(palette.orbit, palette.orbitOpacity),
        rgba(palette.orbit, 0)
      ])
      .arcAltitudeAutoScale(0.45)
      .arcDashLength((d) => (d as ArcDatum).dashLen)
      .arcDashGap((d) => (d as ArcDatum).dashGap)
      .arcDashInitialGap((d) => (d as ArcDatum).initGap)
      .arcDashAnimateTime((d) => (still ? 0 : (d as ArcDatum).time));

    // Satellites on tilted orbits. Parented to `tilt` (not `globe`) so they keep
    // their own cadence rather than riding the Earth's daily spin. Each orbit is
    // a static tilt plane + a spinning child carrying a dashed ring and its dots.
    const dotTex = makeDotTexture();
    const orbitRoot = new THREE.Group();
    tilt.add(orbitRoot);
    const spinners: Array<{ spin: THREE.Group; speed: number }> = [];
    for (const o of ORBITS) {
      const plane = new THREE.Group();
      plane.rotation.x = o.rx;
      plane.rotation.y = o.ry;
      orbitRoot.add(plane);
      const spin = new THREE.Group();
      plane.add(spin);

      const segs = 168;
      const ringPos = new Float32Array((segs + 1) * 3);
      for (let i = 0; i <= segs; i += 1) {
        const a = (i / segs) * Math.PI * 2;
        ringPos[i * 3] = Math.cos(a) * o.radius;
        ringPos[i * 3 + 1] = Math.sin(a) * o.radius;
        ringPos[i * 3 + 2] = 0;
      }
      const ringGeo = new THREE.BufferGeometry();
      ringGeo.setAttribute("position", new THREE.BufferAttribute(ringPos, 3));
      const ring = new THREE.Line(
        ringGeo,
        new THREE.LineDashedMaterial({
          color: palette.orbit,
          transparent: true,
          opacity: palette.orbitOpacity * 0.8,
          dashSize: 1.6,
          gapSize: 2.8,
          depthWrite: false,
          blending: blend
        })
      );
      ring.computeLineDistances(); // required for the dashed (dotted-orbit) look
      spin.add(ring);

      for (const ph of o.phases) {
        const a = ph * Math.PI * 2;
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: dotTex ?? undefined,
            color: palette.orbitGlow,
            transparent: true,
            opacity: 0.95,
            depthWrite: false,
            blending: blend
          })
        );
        sprite.position.set(Math.cos(a) * o.radius, Math.sin(a) * o.radius, 0);
        sprite.scale.setScalar(3.6);
        spin.add(sprite);
      }
      spinners.push({ spin, speed: o.speed });
    }

    const updateOrbits = (dt: number): void => {
      for (const s of spinners) s.spin.rotation.z += s.speed * dt;
      starGroup.rotation.y += 0.012 * dt;
      starGroup.rotation.x += 0.004 * dt;
    };

    // --- Render loop / lifecycle. ---

    let raf = 0;
    let last = 0;
    let running = false;

    const renderOnce = (): void => {
      updateOrbits(0);
      renderer.render(scene, camera);
    };

    const frame = (now: number): void => {
      if (!running) return;
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
      last = now;
      globe.rotation.y += SPIN_PER_SEC * dt;
      updateOrbits(dt);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };

    const start = (): void => {
      if (running) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(frame);
    };
    const stop = (): void => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    if (reduceMotion?.matches) {
      renderOnce();
    } else {
      start();
    }

    const onVisibility = (): void => {
      if (reduceMotion?.matches) return;
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const onMotionChange = (): void => {
      if (reduceMotion?.matches) {
        stop();
        renderOnce();
      } else {
        start();
      }
    };
    reduceMotion?.addEventListener("change", onMotionChange);

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => {
        const next = sizeOf();
        w = next.w;
        h = next.h;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        if (!running) renderOnce();
      });
      ro.observe(canvas);
    }

    return () => {
      stop();
      ro?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      reduceMotion?.removeEventListener("change", onMotionChange);
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const mat = mesh.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose?.();
      });
      dotTex?.dispose();
      renderer.dispose();
    };
  }, [enabled]);

  if (!enabled) return null;
  return (
    <>
      <div className="launcher-globe-space" aria-hidden="true" />
      <canvas ref={canvasRef} className="launcher-globe" aria-hidden="true" />
      <div className="launcher-globe-scrim" aria-hidden="true" />
    </>
  );
}

export default LauncherGlobe;
