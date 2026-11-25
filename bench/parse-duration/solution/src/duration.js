const UNITS = [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]];

/** Parse "1d2h30m" (units in descending order, each at most once) into milliseconds. */
export function parseDuration(text) {
  const re = /(\d+)([dhms])/y;
  let total = 0;
  let last = -1;
  let i = 0;
  while (i < text.length) {
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m) throw new RangeError(`malformed duration: ${JSON.stringify(text)}`);
    const rank = UNITS.findIndex(([u]) => u === m[2]);
    if (rank <= last) throw new RangeError(`units out of order or repeated: ${JSON.stringify(text)}`);
    last = rank;
    total += Number(m[1]) * UNITS[rank][1];
    i = re.lastIndex;
  }
  if (last === -1) throw new RangeError('empty duration');
  return total;
}
