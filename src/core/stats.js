// The one median (rule: one-way-helpers).

/** Median of numbers; the mean of the middle two for an even count; 0 when empty. @param {number[]} xs */
export function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
