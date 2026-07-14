import fs from "node:fs";
import path from "node:path";

/**
 * Recursively removes orphaned `*.tmp` files left under `root`. These are
 * partial cache writes abandoned by a hard process crash (SIGKILL, power loss)
 * between opening the temp file and the atomic rename into place. In-stream
 * failures are already cleaned up by the download handlers; this sweep only
 * catches the crash case. Missing storage dir is a no-op.
 *
 * Returns the number of files removed.
 */
export async function cleanupTempFiles(root: string): Promise<number> {
  let removed = 0;

  async function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      // Directory doesn't exist yet (fresh install) or isn't readable.
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".tmp")) {
        try {
          await fs.promises.unlink(full);
          removed++;
        } catch {
          // Best-effort: another process may have removed it, or it's locked.
        }
      }
    }
  }

  await walk(root);
  return removed;
}
