import { fileURLToPath } from 'node:url';

/** Absolute path inside the package's templates/ directory. */
/** @param {...string} parts */
export function templatePath(...parts) {
  return fileURLToPath(new URL(`../../templates/${parts.join('/')}`, import.meta.url));
}
