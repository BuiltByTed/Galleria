/**
 * Tracked filesystem renames with LIFO rollback.
 * Used by album rename so a mid-sequence fs failure can reverse prior moves.
 */

import fs from 'fs';
import { error } from './logger.js';

/** One successful FS rename (old path → new path). */
export type RenamedPath = { from: string; to: string };

/**
 * Reverse successful renames in reverse order (best-effort).
 * Safe to call with an empty list. Logs and continues if a reverse fails.
 */
export function rollbackRenamedPaths(renamedPaths: RenamedPath[]): void {
  for (let i = renamedPaths.length - 1; i >= 0; i--) {
    const { from, to } = renamedPaths[i];
    try {
      if (fs.existsSync(to)) {
        fs.renameSync(to, from);
      }
    } catch (rollbackErr) {
      error(`[AlbumManagement] Failed to roll back rename ${to} → ${from}:`, rollbackErr);
    }
  }
}
