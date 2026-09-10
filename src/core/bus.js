/**
 * Small synchronous-dispatch event bus with wildcard support and a bounded
 * replay buffer. Replay is explicitly *opt-in per subscriber* and stamped with
 * a monotonic sequence so the UI can resume without ever re-showing or
 * re-speaking an event it already saw (acceptance req. 3).
 */
export class EventBus {
  constructor({ historyLimit = 500 } = {}) {
    this._handlers = new Map();
    this._history = [];
    this._seq = 0;
    this._historyLimit = historyLimit;
  }

  /** @returns {() => void} unsubscribe */
  on(type, handler) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(handler);
    return () => this.off(type, handler);
  }

  off(type, handler) {
    this._handlers.get(type)?.delete(handler);
  }

  once(type, handler) {
    const off = this.on(type, (evt) => { off(); handler(evt); });
    return off;
  }

  /** Emit an event. Returns the stamped envelope. */
  emit(type, payload = {}) {
    const evt = { seq: ++this._seq, type, payload };
    this._history.push(evt);
    if (this._history.length > this._historyLimit) this._history.shift();
    for (const h of this._handlers.get(type) ?? []) safeCall(h, evt);
    for (const h of this._handlers.get('*') ?? []) safeCall(h, evt);
    return evt;
  }

  /** Events strictly newer than `afterSeq`. Used for reconnect, never for replay-on-refresh of speech. */
  since(afterSeq = 0) {
    return this._history.filter((e) => e.seq > afterSeq);
  }

  get lastSeq() { return this._seq; }
}

function safeCall(handler, evt) {
  try { handler(evt); }
  catch (err) { console.error('[error] bus: handler threw', { type: evt.type, err: err?.message }); }
}
