import { sh } from '../../core/exec.js';
import { age, cluster, truncate } from '../../core/text.js';
import { enqueue, fromExternal, KINDS, readQueue, writeQueue } from './store.js';

/** @param {import('./store.js').QueueItem} i */
const line = (i) => `${i.id} [${i.kind}${i.tags.length ? `: ${i.tags.join(',')}` : ''}] ${truncate(i.title, 90)} (${age(Date.now() - Date.parse(i.ts))}${i.task ? `, task ${i.task}` : ''})`;

/** @type {import('../../core/types.js').Command[]} */
export const commands = [
  {
    name: 'queue add',
    summary: 'Buffer a finding (bug, feedback, agent mistake…) instead of spawning a fix right away.',
    args: [{ name: 'title', description: 'One-line title', required: false }],
    options: {
      kind: { type: 'string', description: `${KINDS.join(' | ')}`, default: 'finding' },
      body: { type: 'string', description: 'Details / evidence' },
      source: { type: 'string', description: 'Where it came from (slack, linear, email, review, agent…)', default: 'manual' },
      url: { type: 'string', description: 'Link to the original' },
      tag: { type: 'string[]', description: 'Tags (e.g. the area or the mistake type)' },
      stdin: { type: 'boolean', description: 'Read a JSON item or array of items from stdin' },
    },
    async run(input, ctx) {
      /** @type {any[]} */
      let raw = [];
      if (input.stdin) {
        const parsed = JSON.parse(await ctx.readStdin());
        raw = (Array.isArray(parsed) ? parsed : [parsed]).map((o) => ({ ...fromExternal(o), kind: o.kind ?? input.kind, source: o.source ?? input.source }));
      } else {
        if (!input.title) return { ok: false, summary: 'need a title (or --stdin)' };
        raw = [{ title: input.title, body: input.body, kind: input.kind, source: input.source, url: input.url, tags: input.tag }];
      }
      const added = enqueue(ctx.root, raw);
      return { ok: true, summary: `queued ${added.length} item(s)${raw.length - added.length ? `, ${raw.length - added.length} duplicate(s) skipped` : ''}`, details: added.map(line), data: added };
    },
  },
  {
    name: 'queue pull',
    summary: 'Pull outside context from configured sources (GitHub, Linear, Slack, email exports…) into the queue.',
    options: { source: { type: 'string[]', description: 'Only these source names' } },
    async run(input, ctx) {
      const sources = ctx.config.sources.filter((s) => !input.source?.length || input.source.includes(s.name));
      if (!sources.length) return { ok: false, summary: 'no sources configured (wololo.config.json → sources: [{"name":"gh","run":"gh issue list --json number,title,body,url,labels"}])' };
      const details = [];
      let ok = true;
      for (const s of sources) {
        const r = await sh(s.run, { cwd: ctx.root, timeoutMs: 120_000 });
        if (r.code !== 0) {
          ok = false;
          details.push(`${s.name}: failed (${truncate(r.stderr, 200)})`);
          continue;
        }
        try {
          const parsed = JSON.parse(r.stdout);
          const list = Array.isArray(parsed) ? parsed : [parsed];
          const added = enqueue(ctx.root, list.map((o) => ({ ...fromExternal(o, s.fields), kind: s.kind ?? 'issue', source: s.name })));
          details.push(`${s.name}: ${list.length} seen, ${added.length} new`);
        } catch (e) {
          ok = false;
          details.push(`${s.name}: output is not JSON (${/** @type {Error} */ (e).message})`);
        }
      }
      return { ok, summary: `pulled ${sources.length} source(s)`, details };
    },
  },
  {
    name: 'queue list',
    summary: 'List buffered items.',
    options: {
      kind: { type: 'string', description: 'Filter by kind' },
      status: { type: 'string', description: 'open | grouped | done | dropped | all', default: 'open' },
    },
    async run(input, ctx) {
      const items = readQueue(ctx.root).filter((i) => (input.status === 'all' || i.status === input.status) && (!input.kind || i.kind === input.kind));
      return { ok: true, summary: `${items.length} ${input.status} item(s)`, details: items.map(line), data: items };
    },
  },
  {
    name: 'queue patterns',
    summary: 'Cluster open items. Repeated mistakes → rules; related issues → one coordinator task.',
    options: {
      kind: { type: 'string', description: 'Filter by kind' },
      min: { type: 'number', description: 'Minimum cluster size', default: 2 },
      threshold: { type: 'number', description: 'Token-overlap similarity (0..1)', default: 0.25 },
    },
    async run(input, ctx) {
      const open = readQueue(ctx.root).filter((i) => i.status === 'open' && (!input.kind || i.kind === input.kind));
      const groups = cluster(open, (i) => `${i.title} ${i.tags.join(' ')} ${i.body.slice(0, 400)}`, input.threshold).filter((g) => g.length >= input.min);
      const details = groups.map((g) => {
        const mistakes = g.filter((i) => i.kind === 'mistake').length;
        const advice = mistakes >= 2 ? 'repeated agent mistake → fix the environment: wololo rule add' : `related work → wololo task add --group <name> --from-queue ${g.map((i) => i.id).join(',')}`;
        return `${g.length}× ${truncate(g[0].title, 70)}\n    → ${advice}\n${g.map((i) => `    - ${line(i)}`).join('\n')}`;
      });
      return { ok: true, summary: `${groups.length} pattern(s) across ${open.length} open item(s)`, details, data: groups.map((g) => g.map((i) => i.id)) };
    },
  },
  {
    name: 'queue resolve',
    summary: 'Close queue items (done or dropped).',
    args: [{ name: 'ids', description: 'Item ids', variadic: true }],
    options: { drop: { type: 'boolean', description: 'Mark as dropped instead of done' } },
    async run(input, ctx) {
      const items = readQueue(ctx.root);
      let n = 0;
      for (const i of items) if (input.ids.includes(i.id)) ((i.status = input.drop ? 'dropped' : 'done'), n++);
      writeQueue(ctx.root, items);
      return { ok: n === input.ids.length, summary: `resolved ${n}/${input.ids.length}` };
    },
  },
];
