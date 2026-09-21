import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitizeForLog } from './sanitize.js';

export function getLogDir(): string {
  const dir = process.env.AUTOPILOT_LOG_DIR?.trim();
  return dir && dir.length > 0 ? dir : 'logs';
}

export async function appendJsonl(fileName: string, record: unknown): Promise<void> {
  const dir = getLogDir();
  await mkdir(dir, { recursive: true });
  const sanitized = sanitizeForLog(record);
  const line = `${JSON.stringify(sanitized)}\n`;
  await appendFile(join(dir, fileName), line, 'utf8');
}
