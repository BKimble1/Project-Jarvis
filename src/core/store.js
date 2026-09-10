import fs from 'node:fs';
import path from 'node:path';

/**
 * Durable, crash-safe key/collection store.
 *
 * Writes are atomic (tmp file + rename) and every mutation is appended to a
 * JSONL journal, so in-flight work survives a restart and can be resumed
 * automatically (acceptance req. 1: "save progress ... resume automatically").
 */
export class Store {
  constructor({ dir, clock, autoflush = true }) {
    this.dir = dir;
    this.clock = clock;
    this.autoflush = autoflush;
    this.file = path.join(dir, 'state.json');
    this.journal = path.join(dir, 'journal.jsonl');
    this._state = { collections: {}, meta: { version: 1, updatedAt: 0 } };
    this._dirty = false;
    fs.mkdirSync(dir, { recursive: true });
    this._load();
  }

  _load() {
    if (fs.existsSync(this.file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.collections) this._state = parsed;
      } catch {
        // Corrupt snapshot: keep the file for forensics, start from the journal.
        try { fs.renameSync(this.file, `${this.file}.corrupt`); } catch { /* ignore */ }
      }
    }
    if (fs.existsSync(this.journal)) this._replayJournal();
  }

  _replayJournal() {
    const snapshotAt = this._state.meta?.updatedAt ?? 0;
    let lines;
    try { lines = fs.readFileSync(this.journal, 'utf8').split('\n'); } catch { return; }
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if ((rec.at ?? 0) <= snapshotAt) continue;
      if (rec.op === 'put') this._apply(rec.collection, rec.id, rec.value);
      else if (rec.op === 'del') this._applyDelete(rec.collection, rec.id);
    }
  }

  _apply(collection, id, value) {
    if (!this._state.collections[collection]) this._state.collections[collection] = {};
    this._state.collections[collection][id] = value;
  }

  _applyDelete(collection, id) {
    if (this._state.collections[collection]) delete this._state.collections[collection][id];
  }

  put(collection, id, value) {
    const at = this.clock.now();
    this._apply(collection, id, value);
    this._appendJournal({ op: 'put', collection, id, value, at });
    this._dirty = true;
    if (this.autoflush) this.flush();
    return value;
  }

  patch(collection, id, partial) {
    const current = this.get(collection, id) ?? {};
    return this.put(collection, id, { ...current, ...partial });
  }

  get(collection, id) {
    const v = this._state.collections[collection]?.[id];
    return v === undefined ? null : v;
  }

  delete(collection, id) {
    const at = this.clock.now();
    this._applyDelete(collection, id);
    this._appendJournal({ op: 'del', collection, id, at });
    this._dirty = true;
    if (this.autoflush) this.flush();
  }

  all(collection) {
    return Object.values(this._state.collections[collection] ?? {});
  }

  ids(collection) {
    return Object.keys(this._state.collections[collection] ?? {});
  }

  find(collection, predicate) {
    return this.all(collection).filter(predicate);
  }

  _appendJournal(rec) {
    try { fs.appendFileSync(this.journal, `${JSON.stringify(rec)}\n`); }
    catch (err) { console.error('[error] store: journal append failed', err?.message); }
  }

  /** Atomic snapshot write. */
  flush() {
    if (!this._dirty) return;
    this._state.meta.updatedAt = this.clock.now();
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this._state, null, 2));
      fs.renameSync(tmp, this.file);
      this._dirty = false;
    } catch (err) {
      console.error('[error] store: flush failed', err?.message);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  /** Truncate the journal once its contents are captured in the snapshot. */
  compact() {
    this.flush();
    try { fs.writeFileSync(this.journal, ''); } catch { /* ignore */ }
  }
}
