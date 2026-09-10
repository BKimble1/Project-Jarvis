/**
 * Chat composer + accessible transcript (acceptance req. 2 and 4).
 *
 * The transcript is an ordered list inside an `aria-live="polite"` log, so a
 * screen reader hears each new turn once and only once. Every turn is keyed by
 * its server id, which is what makes an SSE reconnect safe: replayed turns are
 * recognised and dropped instead of appearing twice.
 */

const ROLE_LABEL = {
  user: 'You',
  assistant: 'Jarvis',
  system: 'System',
  tool: 'Tool',
};

function timeLabel(at) {
  if (!Number.isFinite(at)) return null;
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(at));
  } catch {
    return null;
  }
}

function turnKey(turn) {
  if (turn?.id) return String(turn.id);
  return `${turn?.conversationId ?? ''}#${turn?.index ?? ''}#${turn?.role ?? ''}`;
}

function orderOf(turn) {
  const index = Number(turn?.index);
  if (Number.isFinite(index)) return index;
  const at = Number(turn?.at);
  return Number.isFinite(at) ? at : 0;
}

/**
 * @param {{form: HTMLFormElement, input: HTMLTextAreaElement|HTMLInputElement,
 *          transcript: HTMLElement, empty?: HTMLElement,
 *          onSend: (text: string) => Promise<void>|void,
 *          onActivity?: () => void}} options
 */
export function createChat({ form, input, transcript, empty, onSend, onActivity } = {}) {
  if (!form || !input || !transcript) throw new TypeError('createChat requires form, input and transcript');

  const seen = new Map();          // key -> { order, node }
  let busy = false;

  function setBusy(next) {
    busy = Boolean(next);
    form.setAttribute('aria-busy', busy ? 'true' : 'false');
    input.disabled = false;        // never trap the operator mid-sentence
    for (const button of form.querySelectorAll('button[type="submit"]')) {
      button.disabled = busy;
    }
  }

  function renderTurn(turn) {
    const item = document.createElement('li');
    const role = ROLE_LABEL[turn.role] ? turn.role : 'system';
    item.className = `turn turn-${role}`;

    const who = document.createElement('span');
    who.className = 'turn-who';
    who.textContent = ROLE_LABEL[role];
    item.appendChild(who);

    const body = document.createElement('p');
    body.className = 'turn-text';
    body.textContent = turn.text ?? '';
    item.appendChild(body);

    const stamp = timeLabel(turn.at);
    if (stamp) {
      const time = document.createElement('time');
      time.className = 'turn-time';
      time.textContent = stamp;
      if (Number.isFinite(turn.at)) time.dateTime = new Date(turn.at).toISOString();
      item.appendChild(time);
    }
    return item;
  }

  function atBottom() {
    return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48;
  }

  function scrollIfFollowing(wasAtBottom) {
    if (wasAtBottom) transcript.scrollTop = transcript.scrollHeight;
  }

  function syncEmpty() {
    if (empty) empty.hidden = seen.size > 0;
  }

  /** Append one turn; returns false when it was a duplicate. */
  function appendTurn(turn) {
    if (!turn || typeof turn !== 'object') return false;
    const key = turnKey(turn);
    if (seen.has(key)) return false;
    const wasAtBottom = atBottom();
    const node = renderTurn(turn);
    const order = orderOf(turn);

    // Out-of-order arrival (a replay racing a live event) still lands correctly.
    let before = null;
    for (const entry of seen.values()) {
      if (entry.order > order) { before = entry.node; break; }
    }
    if (before) transcript.insertBefore(node, before);
    else transcript.appendChild(node);

    seen.set(key, { order, node });
    syncEmpty();
    scrollIfFollowing(wasAtBottom);
    return true;
  }

  /** Merge a snapshot of turns. Existing entries are never re-rendered. */
  function applyTurns(turns) {
    if (!Array.isArray(turns)) return 0;
    const sorted = [...turns].sort((a, b) => orderOf(a) - orderOf(b));
    let added = 0;
    for (const turn of sorted) if (appendTurn(turn)) added += 1;
    return added;
  }

  async function submit() {
    const text = String(input.value ?? '').trim();
    if (!text || busy) return;
    input.value = '';
    setBusy(true);
    try {
      await onSend?.(text);
    } catch (err) {
      appendTurn({
        id: `local-error-${Date.now()}`,
        role: 'system',
        text: `That message did not reach Jarvis (${err?.message ?? 'network error'}). It is still in the box below — press Send to retry.`,
        at: Date.now(),
        index: Number.MAX_SAFE_INTEGER,
      });
      input.value = text;
    } finally {
      setBusy(false);
      input.focus();
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    onActivity?.();
    submit();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      onActivity?.();
      submit();
    }
  });

  syncEmpty();

  return {
    appendTurn,
    applyTurns,
    setBusy,
    focus: () => input.focus(),
    get size() { return seen.size; },
    has: (turn) => seen.has(turnKey(turn)),
  };
}
