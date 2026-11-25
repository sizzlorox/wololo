// Heuristics for tautological tests: tests that cannot fail, so they verify nothing.

const SAME_SIDES = [
  /expect\(\s*([^()]+?)\s*\)\s*\.(?:toBe|toEqual|toStrictEqual)\(\s*\1\s*\)/,
  /assert(?:Equals?|\.equal|\.strictEqual|\.deepEqual|\.deepStrictEqual|Equal|_eq!?)\s*\(\s*([^,()]+?)\s*,\s*\1\s*[,)]/,
  /\bassert\s+([\w.]+)\s*==\s*\1\s*$/,
  /\bif\s+([\w.]+)\s*!=\s*\1\s*\{/,
];

const LITERAL_SUBJECT = [
  /expect\(\s*(?:true|false|null|undefined|-?\d+(?:\.\d+)?|'[^']*'|"[^"]*")\s*\)\s*\./,
  /\bassert(?:\.ok)?\(\s*(?:true|1)\s*\)/,
  /\bassertTrue\(\s*(?:true|True)\s*\)/,
  /^\s*assert\s+(?:True|1|not\s+False)\s*(?:#.*)?$/,
  /\bassert!\(\s*true\s*\)/,
];

const TEST_DECL = /\b(?:it|test)\s*\(|\bdef\s+test_|\bfunc\s+Test\w*\(|#\[test\]/;
const ASSERTION = /\b(?:expect|assert\w*|should|t\.(?:Error|Errorf|Fatal|Fatalf|Fail)|require\.\w+|check\w*|verify\w*|snapshot)\b|assert(?:_eq)?!/;

/**
 * @param {string} content
 * @returns {{ line: number, reason: string }[]}
 */
export function findTautologies(content) {
  /** @type {{ line: number, reason: string }[]} */
  const out = [];
  const lines = content.split('\n');
  lines.forEach((text, i) => {
    if (SAME_SIDES.some((re) => re.test(text))) out.push({ line: i + 1, reason: 'asserts a value equals itself' });
    else if (LITERAL_SUBJECT.some((re) => re.test(text)))
      out.push({ line: i + 1, reason: 'asserts on a literal, so the code under test never runs' });
  });
  if (TEST_DECL.test(content) && !ASSERTION.test(content)) out.push({ line: 1, reason: 'declares tests but contains no assertions' });
  return out;
}
