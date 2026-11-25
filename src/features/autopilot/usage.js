import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeText } from '../../core/files.js';
import { readEvents, statePath } from '../../core/state.js';

/**
 * Token accounting for agent runs. Each run is recorded as one `agent` event in events.jsonl;
 * `summarize` turns those into the numbers the TUI shows.
 *
 * @typedef {object} TurnUsage  one model turn, as the agent's stream reports it
 * @property {number} input       uncached prompt tokens
 * @property {number} output
 * @property {number} cacheRead   prompt tokens served from the cache
 * @property {number} cacheWrite  prompt tokens written to the cache
 * @property {number} [cost]      USD, when the harness prices it
 * @property {number} [inputCost]
 * @property {number} [cacheReadCost]
 * @property {string} [id]        claude repeats a message's usage per content block: dedupe by id
 * @property {boolean} [final]    claude's closing `result` line: authoritative totals, not a turn
 *
 * @typedef {object} RunUsage
 * @property {number} turns
 * @property {number} input
 * @property {number} output
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number} cost
 * @property {number} [saved]     USD the cache saved, when the harness prices input and cache reads
 * @property {number[]} contexts  prompt size of each turn (everything sent, cached or not)
 */

const sent = (/** @type {TurnUsage} */ u) => u.input + u.cacheRead + u.cacheWrite;

/** Sum one agent run's turns. */
export function meter() {
  /** @type {Map<string, TurnUsage>} */
  const turns = new Map();
  /** @type {TurnUsage | undefined} */
  let final;
  let n = 0;
  return {
    /** @param {TurnUsage | undefined} u */
    add(u) {
      if (!u) return;
      if (u.final) final = u;
      else turns.set(u.id ?? `#${n++}`, u);
    },
    /** @returns {RunUsage} */
    summary() {
      const list = [...turns.values()];
      /** @param {'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cost' | 'inputCost' | 'cacheReadCost'} k */
      const sum = (k) => list.reduce((a, u) => a + (u[k] ?? 0), 0);
      const t = final ?? { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), cost: sum('cost') };
      const input = sum('input');
      const cacheRead = sum('cacheRead');
      // What the cache reads would have cost as plain input, minus what they did cost.
      const saved = input && cacheRead && sum('inputCost') ? cacheRead * (sum('inputCost') / input) - sum('cacheReadCost') : undefined;
      return { turns: list.length, input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, cost: t.cost ?? 0, ...(saved && saved > 0 ? { saved } : {}), contexts: list.map(sent) };
    },
  };
}

/** @param {number[]} xs */
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * @typedef {RunUsage & { type: 'agent', role: string, ts: string, promptChars: number }} AgentEvent
 * @param {any[]} events  events.jsonl, any types
 */
export function summarize(events) {
  /** @type {AgentEvent[]} */
  const runs = events.filter((e) => e?.type === 'agent');
  const zero = () => ({ runs: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, saved: 0 });
  const total = zero();
  /** @type {Map<string, ReturnType<typeof zero>>} */
  const roles = new Map();
  for (const r of runs) {
    const role = r.role.split(' (')[0];
    for (const into of [total, roles.get(role) ?? roles.set(role, zero()).get(role)]) {
      if (!into) continue;
      into.runs++;
      into.turns += r.turns;
      into.input += r.input;
      into.output += r.output;
      into.cacheRead += r.cacheRead;
      into.cacheWrite += r.cacheWrite;
      into.cost += r.cost;
      into.saved += r.saved ?? 0;
    }
  }
  const contexts = runs.flatMap((r) => r.contexts ?? []);
  const prompt = total.input + total.cacheRead + total.cacheWrite;
  return {
    runs: runs.length,
    total,
    roles: [...roles].map(([role, u]) => ({ role, ...u })).sort((a, b) => b.input + b.cacheRead - (a.input + a.cacheRead)),
    hitRate: prompt ? total.cacheRead / prompt : 0,
    medianContext: median(contexts),
    maxContext: contexts.length ? Math.max(...contexts) : 0,
    medianPromptChars: median(runs.map((r) => r.promptChars ?? 0)),
    last: runs.slice(-15).reverse(),
  };
}

/**
 * One file per agent run in .wololo/state/usage/, written when the agent starts and after every
 * turn, so a run that crashes or is killed still counts. `live` stays true until the run ends.
 * @typedef {AgentEvent & { id: string, model?: string, live: boolean, killed?: string }} RunRecord
 */

/** @param {string} root */
const usageDir = (root) => statePath(root, 'usage');

/** @param {string} root @param {RunRecord} record */
export function saveRun(root, record) {
  try {
    writeText(join(usageDir(root), `${record.id}.json`), JSON.stringify(record));
  } catch {
    // usage is a record, not a reason to stop an agent; the next turn writes it again
  }
}

/**
 * Every agent run, oldest first: the usage files, plus runs recorded before they existed (events.jsonl).
 * @param {string} root
 * @returns {RunRecord[]}
 */
export function readRuns(root) {
  /** @type {RunRecord[]} */
  const runs = existsSync(usageDir(root))
    ? readdirSync(usageDir(root))
        .filter((f) => f.endsWith('.json'))
        .flatMap((f) => {
          try {
            return [JSON.parse(readFileSync(join(usageDir(root), f), 'utf8'))];
          } catch {
            return []; // being written right now
          }
        })
    : [];
  const ids = new Set(runs.map((r) => r.id));
  const legacy = readEvents(root, 'agent').filter((e) => !ids.has(e.transcript)).map((e) => ({ ...e, id: e.transcript ?? e.ts, live: false }));
  return [...runs, ...legacy].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}
