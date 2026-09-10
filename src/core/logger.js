const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger(scope, { level = process.env.JARVIS_LOG_LEVEL || 'info', sink = console } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, msg, extra) => {
    if ((LEVELS[lvl] ?? 0) < threshold) return;
    const line = `[${lvl}] ${scope}: ${msg}`;
    const fn = lvl === 'error' ? (sink.error || sink.log) : (sink.log || (() => {}));
    if (extra !== undefined) fn.call(sink, line, extra); else fn.call(sink, line);
  };
  return {
    debug: (m, e) => emit('debug', m, e),
    info: (m, e) => emit('info', m, e),
    warn: (m, e) => emit('warn', m, e),
    error: (m, e) => emit('error', m, e),
    child: (sub) => createLogger(`${scope}:${sub}`, { level, sink }),
  };
}
