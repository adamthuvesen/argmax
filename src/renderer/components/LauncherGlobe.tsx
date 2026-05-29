/**
 * LauncherGlobe — an animated, rotating dot-Earth backdrop for the new-session
 * launcher, built on `three-globe` (the WebGL globe-visualization library that
 * powers globe.gl). three-globe renders the dark orb, the lat/long graticules,
 * the dotted continents (hex-polygons drawn as dots), and the atmosphere glow;
 * we add a slow spin, a drifting "plexus" network around it, and theme-aware
 * colors.
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
import { useEffect, useRef, useState, type JSX } from "react";
import * as THREE from "three";
import ThreeGlobe from "three-globe";
import landPolygons from "../lib/landPolygons.json";
import { subscribeToThemeChange } from "../lib/theme.js";

type ThemeAttr = "light" | "dark" | "purple";

function readThemeAttr(): ThemeAttr {
  if (typeof document === "undefined") return "dark";
  const attr = document.documentElement.getAttribute("data-theme");
  return attr === "light" || attr === "purple" ? attr : "dark";
}

interface Palette {
  orb: number;
  orbOpacity: number;
  dots: string;
  graticule: number;
  graticuleOpacity: number;
  network: number;
  accent: number;
  networkOpacity: number;
  additive: boolean;
}

function paletteFor(theme: ThemeAttr): Palette {
  switch (theme) {
    case "purple":
      return {
        orb: 0x000000,
        orbOpacity: 0.985,
        dots: "#f3f4f6",
        graticule: 0x9ca3af,
        graticuleOpacity: 0.06,
        network: 0xd1d5db,
        accent: 0xe5e7eb,
        networkOpacity: 0.34,
        additive: true
      };
    case "light":
      return {
        orb: 0x000000,
        orbOpacity: 0.99,
        dots: "#f3f4f6",
        graticule: 0x9ca3af,
        graticuleOpacity: 0.06,
        network: 0xd1d5db,
        accent: 0xe5e7eb,
        networkOpacity: 0.22,
        additive: false
      };
    default: // dark
      return {
        orb: 0x000000,
        orbOpacity: 0.98,
        dots: "#f3f4f6",
        graticule: 0x9ca3af,
        graticuleOpacity: 0.06,
        network: 0xd1d5db,
        accent: 0xe5e7eb,
        networkOpacity: 0.26,
        additive: true
      };
  }
}

// three-globe uses a globe radius of 100 world units.
const FOV = 32;
const CAMERA_Z = 410;
const SPIN_PER_SEC = (2 * Math.PI) / 130; // one full turn ≈ 130s
const NETWORK_NODES = 42;
const NETWORK_LINK_DIST = 84;

/** Recolor three-globe's internal line materials post-build. */
function tuneGlobeMaterials(globe: ThreeGlobe, palette: Palette): void {
  globe.traverse((obj) => {
    if (!(obj instanceof THREE.LineSegments)) return;
    const materials = (Array.isArray(obj.material) ? obj.material : [obj.material]) as THREE.Material[];
    for (const line of materials) {
      if (line instanceof THREE.LineBasicMaterial) {
        line.color.setHex(palette.graticule);
        line.transparent = true;
        line.opacity = palette.graticuleOpacity;
      }
    }
  });
}

export function LauncherGlobe({ enabled }: { enabled: boolean }): JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [theme, setTheme] = useState<ThemeAttr>(() => readThemeAttr());

  // The subscribe callback's resolved arg collapses purple → dark, so re-read the
  // raw attribute to tell the three apart.
  useEffect(() => subscribeToThemeChange(() => setTheme(readThemeAttr())), []);

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

    const palette = paletteFor(theme);
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

    // --- The globe (three-globe): dark orb + graticules + dotted continents + glow. ---
    const globe = new ThreeGlobe({ animateIn: false })
      .showGlobe(true)
      .showGraticules(true)
      .showAtmosphere(false)
      .hexPolygonsData(landPolygons as object[])
      .hexPolygonResolution(3)
      .hexPolygonMargin(0.62)
      .hexPolygonUseDots(true)
      .hexPolygonAltitude(0.012)
      .hexPolygonColor(() => palette.dots);

    const orbMaterial = new THREE.MeshPhongMaterial({
      color: palette.orb,
      transparent: true,
      opacity: palette.orbOpacity,
      shininess: 6
    });
    orbMaterial.depthWrite = true; // occlude the far-hemisphere dots
    globe.globeMaterial(orbMaterial);
    tuneGlobeMaterials(globe, palette);

    const tilt = new THREE.Group();
    tilt.rotation.z = 0.36;
    tilt.rotation.x = -0.12;
    tilt.position.set(38, 18, 0);
    tilt.scale.setScalar(0.82);
    tilt.add(globe);
    globe.rotation.y = -0.5;
    scene.add(tilt);

    // --- Plexus network: many short faint links, drifting slowly. ---
    let halfH = Math.tan((FOV * Math.PI) / 360) * CAMERA_Z;
    let halfW = halfH * (w / h);
    const nx = new Float32Array(NETWORK_NODES);
    const ny = new Float32Array(NETWORK_NODES);
    const nz = new Float32Array(NETWORK_NODES);
    const nvx = new Float32Array(NETWORK_NODES);
    const nvy = new Float32Array(NETWORK_NODES);
    const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
    for (let i = 0; i < NETWORK_NODES; i += 1) {
      nx[i] = rnd(-halfW * 1.15, halfW * 1.15);
      ny[i] = rnd(-halfH * 1.15, halfH * 1.15);
      nz[i] = rnd(-70, 170);
      nvx[i] = rnd(-7, 7);
      nvy[i] = rnd(-7, 7);
    }
    const nodePos = new Float32Array(NETWORK_NODES * 3);
    const nodeColors = new Float32Array(NETWORK_NODES * 3);
    const baseNode = new THREE.Color(palette.network);
    const accentNode = new THREE.Color(palette.accent);
    for (let i = 0; i < NETWORK_NODES; i += 1) {
      const c = i % 18 === 0 ? accentNode : baseNode;
      nodeColors[i * 3] = c.r;
      nodeColors[i * 3 + 1] = c.g;
      nodeColors[i * 3 + 2] = c.b;
    }
    const nodeGeo = new THREE.BufferGeometry();
    nodeGeo.setAttribute("position", new THREE.BufferAttribute(nodePos, 3));
    nodeGeo.setAttribute("color", new THREE.BufferAttribute(nodeColors, 3));
    const nodeMat = new THREE.PointsMaterial({
      size: 1.7 * pixelRatio,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: Math.min(1, palette.networkOpacity * 1.35),
      depthTest: false,
      depthWrite: false,
      blending: palette.additive ? THREE.AdditiveBlending : THREE.NormalBlending
    });
    scene.add(new THREE.Points(nodeGeo, nodeMat));

    const maxSeg = (NETWORK_NODES * (NETWORK_NODES - 1)) / 2;
    const linkPos = new Float32Array(maxSeg * 2 * 3);
    const linkCol = new Float32Array(maxSeg * 2 * 3);
    const linkGeo = new THREE.BufferGeometry();
    linkGeo.setAttribute("position", new THREE.BufferAttribute(linkPos, 3));
    linkGeo.setAttribute("color", new THREE.BufferAttribute(linkCol, 3));
    const linkMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.78,
      depthTest: false,
      depthWrite: false,
      blending: palette.additive ? THREE.AdditiveBlending : THREE.NormalBlending
    });
    scene.add(new THREE.LineSegments(linkGeo, linkMat));

    const updateNetwork = (dt: number): void => {
      for (let i = 0; i < NETWORK_NODES; i += 1) {
        nx[i] += nvx[i] * dt;
        ny[i] += nvy[i] * dt;
        if (nx[i] < -halfW * 1.2 || nx[i] > halfW * 1.2) nvx[i] *= -1;
        if (ny[i] < -halfH * 1.2 || ny[i] > halfH * 1.2) nvy[i] *= -1;
        nodePos[i * 3] = nx[i];
        nodePos[i * 3 + 1] = ny[i];
        nodePos[i * 3 + 2] = nz[i];
      }
      nodeGeo.attributes.position.needsUpdate = true;

      let v = 0;
      for (let i = 0; i < NETWORK_NODES; i += 1) {
        for (let j = i + 1; j < NETWORK_NODES; j += 1) {
          const dx = nx[i] - nx[j];
          const dy = ny[i] - ny[j];
          const dz = nz[i] - nz[j];
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist > NETWORK_LINK_DIST) continue;
          const a = (1 - dist / NETWORK_LINK_DIST) * palette.networkOpacity;
          linkPos[v * 3] = nx[i];
          linkPos[v * 3 + 1] = ny[i];
          linkPos[v * 3 + 2] = nz[i];
          linkPos[(v + 1) * 3] = nx[j];
          linkPos[(v + 1) * 3 + 1] = ny[j];
          linkPos[(v + 1) * 3 + 2] = nz[j];
          for (const k of [v, v + 1]) {
            linkCol[k * 3] = baseNode.r * a;
            linkCol[k * 3 + 1] = baseNode.g * a;
            linkCol[k * 3 + 2] = baseNode.b * a;
          }
          v += 2;
        }
      }
      linkGeo.setDrawRange(0, v);
      linkGeo.attributes.position.needsUpdate = true;
      linkGeo.attributes.color.needsUpdate = true;
    };

    // --- Render loop / lifecycle. ---
    const reduceMotion =
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;

    let raf = 0;
    let last = 0;
    let running = false;

    const renderOnce = (): void => {
      updateNetwork(0);
      renderer.render(scene, camera);
    };

    const frame = (now: number): void => {
      if (!running) return;
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
      last = now;
      globe.rotation.y += SPIN_PER_SEC * dt;
      updateNetwork(dt);
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
        halfH = Math.tan((FOV * Math.PI) / 360) * CAMERA_Z;
        halfW = halfH * (w / h);
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
      renderer.dispose();
    };
  }, [enabled, theme]);

  if (!enabled) return null;
  return (
    <>
      <canvas ref={canvasRef} className="launcher-globe" aria-hidden="true" />
      <div className="launcher-globe-scrim" aria-hidden="true" />
    </>
  );
}

export default LauncherGlobe;
