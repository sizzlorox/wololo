/**
 * Numbers from start to end inclusive, stepping by step (default 1). Negative steps count down.
 * @param {number} start @param {number} end @param {number} [step]
 */
export function range(start, end, step = 1) {
  if (step === 0) throw new RangeError('step must not be 0');
  const out = [];
  for (let i = start; step > 0 ? i <= end : i >= end; i += step) out.push(i);
  return out;
}
