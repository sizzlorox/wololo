import { existsSync, readFileSync, rmSync } from 'node:fs';
import { ensureDir } from '../../core/files.js';
import { git, gitOut } from '../../core/git.js';
import { recordEvent, statePath } from '../../core/state.js';
import { runGate } from '../gate/command.js';
import { loadRubric, runScore } from '../score/command.js';

/** Good enough: stop climbing. ponytail: fixed; make it a setting if repos need a different bar */
const TARGET = 0.95;

/**
 * @param {string} bin @param {string} goal @param {string} base
 * @param {{ id: string, question?: string }[]} questions @param {string} path
 */
export function judgePrompt(bin, goal, base, questions, path) {
  return [
    'You are the judge in an autopilot loop. Do not change any file and do not commit.',
    '',
    'Score this step\'s change against each question, from 0 to 1. Be strict: 1 means demonstrably yes. Run and use what was built as much as you need to judge.',
    '',
    'Step:',
    goal,
    '',
    `The change: \`git diff ${base}\` (commits since ${base.slice(0, 12)} plus the working tree).`,
    '',
    'Questions:',
    ...questions.map((q) => `- ${q.id}: ${q.question ?? q.id}`),
    '',
    `Write ${path} as JSON: {"scores": {"${questions[0]?.id ?? 'id'}": 0.7}, "notes": {"${questions[0]?.id ?? 'id'}": "exactly what is missing for a 1"}}`,
    `(Gate command, if you want it: ${bin} gate)`,
  ].join('\n');
}

/** @param {string} bin @param {string} goal @param {{ id: string, question?: string, note: string }} c */
export function improverPrompt(bin, goal, c) {
  return [
    'You are the improver in an autopilot loop. This step works and passes the gate. Make it better on one point only.',
    '',
    'Step:',
    goal,
    '',
    `Criterion: ${c.id}${c.question ? `: ${c.question}` : ''}`,
    `What the judge says is missing: ${c.note || '(no note)'}`,
    '',
    `Change only what this needs; no new features. Keep \`${bin} gate\` green. Commit when done.`,
  ].join('\n');
}

/**
 * Hill-climb a landed-ready step against the rubric: a judge scores the judgment criteria, an
 * improver works on the weakest one, and the change is kept only when the gate stays green and the
 * score goes up. Stops at the target, after `rounds`, or at the first round without a gain.
 * @param {import('../../core/types.js').Ctx} ctx
 * @param {{ goal: string, base: string, rounds: number, title: string, spawn: (role: string, prompt: string) => Promise<unknown>, log: (msg: string) => void }} o
 * @returns {Promise<{ from: number, to: number, kept: number } | undefined>}
 */
export async function hillClimb(ctx, o) {
  if (o.rounds <= 0) return undefined;
  const { root, config } = ctx;
  let rubric;
  try {
    rubric = loadRubric(root);
  } catch {
    return undefined;
  }
  if (!rubric.criteria.length) return undefined;
  const questions = rubric.criteria.filter((c) => c.type === 'judgment');
  const path = statePath(root, 'judge.json');
  /** @returns {Promise<{ scores: Record<string, number>, notes: Record<string, string> }>} */
  const judge = async () => {
    if (!questions.length) return { scores: {}, notes: {} };
    ensureDir(statePath(root));
    rmSync(path, { force: true });
    await o.spawn('judge', judgePrompt(config.bin, o.goal, o.base, questions, path));
    try {
      const j = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
      const scores = Object.fromEntries(Object.entries(j.scores ?? {}).filter(([k, v]) => questions.some((q) => q.id === k) && typeof v === 'number').map(([k, v]) => [k, Math.max(0, Math.min(1, /** @type {number} */ (v)))]));
      return { scores, notes: j.notes ?? {} };
    } catch {
      return { scores: {}, notes: {} };
    }
  };
  /** Everything as it is now, committed: what a round is undone to. */
  const checkpoint = (/** @type {string} */ what) => {
    git(root, ['add', '-A', '--', '.', ':(exclude).wololo/state']);
    git(root, ['commit', '-q', '--no-verify', '-m', `${o.title} (autopilot: ${what})`]);
    return gitOut(root, ['rev-parse', 'HEAD']);
  };
  const undo = (/** @type {string} */ sha) => {
    git(root, ['reset', '-q', '--hard', sha]);
    git(root, ['clean', '-fdq']); // .wololo/state is gitignored: clean leaves it
  };

  let verdict = await judge();
  let score = await runScore(ctx, { judge: verdict.scores, record: false });
  const from = score.total;
  let kept = 0;
  for (let round = 1; round <= o.rounds; round++) {
    if (score.total >= TARGET) {
      o.log(`hill-climb: score ${score.total} reached ${TARGET}`);
      break;
    }
    const weakest = score.weakest;
    if (!weakest) break;
    o.log(`hill-climb round ${round}: score ${score.total}, weakest ${weakest.id} (${weakest.score}) → improver`);
    const before = checkpoint(`before hill-climb round ${round}`);
    await o.spawn('improver', improverPrompt(config.bin, o.goal, { id: weakest.id, question: weakest.question, note: verdict.notes[weakest.id] ?? weakest.note }));
    const gate = await runGate(ctx);
    if (!gate.ok) {
      undo(before);
      o.log(`hill-climb round ${round}: the improvement broke the gate; undone, stopping`);
      break;
    }
    const nextVerdict = await judge();
    const next = await runScore(ctx, { judge: nextVerdict.scores, record: false });
    if (next.total <= score.total) {
      undo(before);
      o.log(`hill-climb round ${round}: no gain (${score.total} → ${next.total}); undone, stopping`);
      break;
    }
    o.log(`hill-climb round ${round}: kept (${score.total} → ${next.total})`);
    checkpoint(`hill-climb round ${round}: ${weakest.id} ${score.total} → ${next.total}`);
    verdict = nextVerdict;
    score = next;
    kept++;
  }
  recordEvent(root, { type: 'climb', ok: true, from, to: score.total, kept });
  return { from, to: score.total, kept };
}
