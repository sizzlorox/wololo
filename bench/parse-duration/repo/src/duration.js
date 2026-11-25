const UNITS = { s: 1000, m: 60_000 };

/** Parse "90s" or "5m" into milliseconds. */
export function parseDuration(text) {
  const m = /^(\d+)([sm])$/.exec(text);
  return m ? Number(m[1]) * UNITS[m[2]] : NaN;
}
