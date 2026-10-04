import type { ChatChipEnvironment } from "../components/composerEditor/extensions.js";
import type { ChatDirectoryEntry } from "../state/chatDirectory.js";

/**
 * How the prompt editor looks a chat up and opens one. Rebuilt whenever the
 * directory changes, which is what redraws a chip whose chat was just renamed
 * or archived.
 */
export function chatChipEnvironmentFor(
  directory: readonly ChatDirectoryEntry[],
  open: (sessionId: string) => boolean
): ChatChipEnvironment {
  const bySession = new Map(directory.map((entry) => [entry.sessionId, entry]));
  return {
    resolve: (sessionId) => {
      const entry = bySession.get(sessionId);
      return entry ? { title: entry.title } : null;
    },
    open: (sessionId) => {
      open(sessionId);
    }
  };
}
