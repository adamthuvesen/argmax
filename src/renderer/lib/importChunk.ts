// Marker in sessionStorage, like the Sidebar's boot markers: scoped to the tab
// and cleared when it closes. It bounds recovery to one reload, so a chunk that
// is broken rather than stale still reaches the error boundary.
const RELOAD_MARKER_KEY = "argmax.chunk.reloaded";

function hasReloaded(): boolean {
  try {
    return window.sessionStorage.getItem(RELOAD_MARKER_KEY) === "1";
  } catch {
    // SecurityError in private mode: treat it as "already tried" so a missing
    // marker cannot turn into a reload loop.
    return true;
  }
}

function markReloaded(written: boolean): void {
  try {
    if (written) window.sessionStorage.setItem(RELOAD_MARKER_KEY, "1");
    else window.sessionStorage.removeItem(RELOAD_MARKER_KEY);
  } catch {
    // See hasReloaded — nothing to do, the next failure just gives up sooner.
  }
}

/**
 * Load a lazily split chunk, reloading the page once when it has gone missing.
 *
 * The bundle a paired phone holds outlives the one the bridge serves: rebuild
 * the renderer and the hashed chunk the live page asks for is no longer on
 * disk. Reloading picks up the current shell, which is the only way that page
 * can reach the new hashes.
 */
export async function importChunk<T>(load: () => Promise<T>): Promise<T> {
  try {
    const chunk = await load();
    markReloaded(false);
    return chunk;
  } catch (error) {
    if (typeof window === "undefined" || hasReloaded()) throw error;
    markReloaded(true);
    window.location.reload();
    // Stay pending rather than resolve: the reload is asynchronous, and the
    // caller would otherwise render against the bundle that just failed.
    return new Promise<T>(() => undefined);
  }
}
