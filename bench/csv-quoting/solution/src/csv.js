/** @param {unknown} v */
const field = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** Rows (arrays of values) to RFC 4180 CSV text. */
export function toCsv(rows) {
  return rows.map((row) => row.map(field).join(',')).join('\r\n');
}
