import { readJson, writeJson } from '../../core/files.js';
import { statePath } from '../../core/state.js';
import { shortHash } from '../../core/text.js';

export const KINDS = ['issue', 'bug', 'feedback', 'mistake', 'finding', 'garden'];

/**
 * @typedef {object} QueueItem
 * @property {string} id
 * @property {string} kind
 * @property {string} source
 * @property {string} title
 * @property {string} body
 * @property {string} [url]
 * @property {string[]} tags
 * @property {'open' | 'grouped' | 'done' | 'dropped'} status
 * @property {string} [task]
 * @property {string} ts
 */

/** @param {string} root @returns {QueueItem[]} */
export function readQueue(root) {
  return readJson(statePath(root, 'queue.json'), []);
}

/** @param {string} root @param {QueueItem[]} items */
export function writeQueue(root, items) {
  writeJson(statePath(root, 'queue.json'), items);
}

/**
 * Add items, deduplicating by id. Returns only the newly added ones.
 * @param {string} root
 * @param {Partial<QueueItem>[]} incoming
 */
export function enqueue(root, incoming) {
  const items = readQueue(root);
  const seen = new Set(items.map((i) => i.id));
  /** @type {QueueItem[]} */
  const added = [];
  for (const raw of incoming) {
    const item = normalizeItem(raw);
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
    added.push(item);
  }
  if (added.length) writeQueue(root, items);
  return added;
}

/** @param {Partial<QueueItem>} raw @returns {QueueItem} */
export function normalizeItem(raw) {
  const source = raw.source ?? 'manual';
  const title = (raw.title ?? '').trim() || (raw.body ?? '').split('\n')[0].slice(0, 120);
  const body = raw.body ?? '';
  return {
    id: raw.id ? `${source}:${raw.id}` : `${source}:${shortHash(`${title}\n${body}`)}`,
    kind: raw.kind && KINDS.includes(raw.kind) ? raw.kind : 'issue',
    source,
    title,
    body,
    url: raw.url,
    tags: raw.tags ?? [],
    status: raw.status ?? 'open',
    ts: raw.ts ?? new Date().toISOString(),
  };
}

const PICK = {
  id: ['id', 'number', 'key', 'identifier', 'ts'],
  title: ['title', 'name', 'summary', 'subject'],
  body: ['body', 'description', 'text', 'content', 'message', 'snippet'],
  url: ['url', 'html_url', 'link', 'permalink', 'web_url'],
};

/**
 * Map any JSON object from an external source onto a queue item using common field names.
 * @param {Record<string, any>} obj
 * @param {Record<string, string>} [fields] Explicit mapping (item field → source field).
 */
export function fromExternal(obj, fields = {}) {
  /** @param {keyof typeof PICK} key */
  const get = (key) => {
    const explicit = fields[key];
    if (explicit) return explicit.split('.').reduce((/** @type {any} */ o, k) => o?.[k], obj);
    const k = PICK[key].find((c) => obj[c] !== undefined && obj[c] !== null);
    return k ? obj[k] : undefined;
  };
  const labels = Array.isArray(obj.labels) ? obj.labels.map((/** @type {any} */ l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean) : [];
  const id = get('id');
  return { id: id === undefined ? undefined : String(id), title: String(get('title') ?? ''), body: String(get('body') ?? ''), url: get('url'), tags: labels };
}
