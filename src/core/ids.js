import { randomUUID } from 'node:crypto';

let counter = 0;

/** Short, sortable-ish id with a type prefix. */
export function newId(prefix = 'id') {
  counter = (counter + 1) % 100000;
  const rand = randomUUID().replace(/-/g, '').slice(0, 8);
  return `${prefix}_${rand}${counter.toString(36)}`;
}

/** Stable key for de-duplicating repeated events. */
export function dedupeKey(...parts) {
  return parts.map((p) => String(p ?? '')).join('|');
}
