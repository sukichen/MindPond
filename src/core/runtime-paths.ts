/** Runtime data belongs to the user, not a globally installed npm directory. */
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';

export function defaultDatabasePath(legacyPath?: string): string {
  if (process.env.MEMORY_DB_PATH) return path.resolve(process.env.MEMORY_DB_PATH);
  if (process.env.MINDPOND_DATA_DIR) return path.resolve(process.env.MINDPOND_DATA_DIR, 'mindpond.db');
  // Existing installations retain their database until the operator explicitly migrates it.
  if (legacyPath && existsSync(legacyPath)) return legacyPath;
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'mindpond', 'mindpond.db');
}

export function defaultModelDirectory(legacyPath: string): string {
  if (process.env.EMBEDDING_MODEL_DIR) return path.resolve(process.env.EMBEDDING_MODEL_DIR);
  if (existsSync(legacyPath)) return legacyPath;
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'mindpond', 'models');
}
