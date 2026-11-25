import { existsSync, renameSync, rmSync, statSync } from 'node:fs';

/** Generations kept beside the live file: log.1 (newest) … log.N (oldest). */
export const KEEP = 3;

/**
 * Rotate a log once it passes `maxBytes`: log → log.1 → log.2 → … → log.KEEP, the oldest dropped.
 * Nothing is trimmed; history stays readable in the numbered files. Never throws.
 * @param {string} file
 * @param {number} maxBytes
 * @returns {number} bytes dropped with the oldest generation (0 if it did not rotate)
 */
export function rotate(file, maxBytes) {
  try {
    if (!existsSync(file) || statSync(file).size <= maxBytes) return 0;
    const oldest = `${file}.${KEEP}`;
    const dropped = existsSync(oldest) ? statSync(oldest).size : 0;
    rmSync(oldest, { force: true });
    for (let i = KEEP - 1; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    renameSync(file, `${file}.1`);
    return dropped;
  } catch {
    return 0; // a log held open on Windows: rotate next time
  }
}
