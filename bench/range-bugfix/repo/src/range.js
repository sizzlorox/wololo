/**
 * Numbers from start to end inclusive, stepping by step (default 1). Negative steps count down.
 * @param {number} start @param {number} end @param {number} [step]
 */
export function range(start, end, step = 1) {
  const out = [];
  for (let i = start; i < end; i += step) out.push(i);
  return out;
}
