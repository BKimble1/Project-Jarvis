/**
 * Voice out (acceptance req. 3), via the Web Speech API only — no service, no
 * network, nothing to install.
 *
 * Two browser realities are handled explicitly:
 *
 * 1. **User activation.** `speechSynthesis.speak()` before the first gesture is
 *    silently swallowed by Chromium and friends. Rather than pretending it
 *    worked, we detect it (no `start` event, nothing speaking or pending) and
 *    surface ONE small "Enable voice" affordance. The queue is kept, and the
 *    first interaction drains it.
 * 2. **Repeats.** Every item carries the server's monotonic `seq`. A seq that
 *    has been offered before is dropped, and each spoken item is acknowledged
 *    to `/api/speech/ack` so the server never offers it again — a refresh or a
 *    reconnect cannot replay yesterday's news.
 */

const START_TIMEOUT_MS = 700;

export function createSpeech({
  synth = globalThis.speechSynthesis,
  utteranceClass = globalThis.SpeechSynthesisUtterance,
  ack,
  onActivationRequired,
  onSpeakingChange,
  muted = false,
} = {}) {
  const supported = Boolean(synth && utteranceClass);
  const offered = new Set();       // seqs we have already accepted (spoken, dropped or queued)
  const queue = [];
  let unlocked = false;
  let speaking = false;
  let activationShown = false;
  let isMuted = Boolean(muted);
  let stopped = false;
  let current = null;              // the item being spoken right now, if any

  function hasGesture() {
    if (unlocked) return true;
    try {
      if (globalThis.navigator?.userActivation?.hasBeenActive) return true;
    } catch { /* not supported: fall through to the affordance */ }
    return false;
  }

  function showActivation(needed) {
    if (activationShown === needed) return;
    activationShown = needed;
    onActivationRequired?.(needed);
  }

  function setSpeaking(next) {
    if (speaking === next) return;
    speaking = next;
    onSpeakingChange?.(speaking);
  }

  function acknowledge(item) {
    if (!Number.isFinite(item?.seq)) return;
    try { ack?.(item.seq); } catch { /* the server will re-offer; never crash the page */ }
  }

  function drainMuted() {
    // Muted means "do not say this", not "say it later": acknowledging keeps the
    // server from re-offering a stale announcement the moment the mute lifts.
    while (queue.length) acknowledge(queue.shift());
  }

  function pump() {
    if (stopped || !supported || speaking) return;
    if (isMuted) { drainMuted(); return; }
    if (!queue.length) return;
    if (!hasGesture()) { showActivation(true); return; }
    showActivation(false);

    const item = queue.shift();
    current = item;
    let started = false;
    let settled = false;

    const utterance = new utteranceClass(String(item.text ?? ''));
    utterance.rate = 1.02;
    utterance.pitch = 1;
    utterance.volume = 1;

    const finish = (didSpeak) => {
      if (settled) return;
      settled = true;
      current = null;
      clearTimeout(watchdog);
      setSpeaking(false);
      if (didSpeak) acknowledge(item);
      pump();
    };

    const blocked = () => {
      if (settled) return;
      settled = true;
      current = null;
      clearTimeout(watchdog);
      setSpeaking(false);
      unlocked = false;
      queue.unshift(item);         // keep it: the first gesture will say it
      try { synth.cancel(); } catch { /* ignore */ }
      showActivation(true);
    };

    utterance.onstart = () => { started = true; setSpeaking(true); };
    utterance.onend = () => finish(true);
    utterance.onerror = (event) => {
      const reason = event?.error ?? '';
      if (reason === 'not-allowed' || reason === 'blocked') blocked();
      // `cancel()` and mute cut the utterance off mid-word. Acknowledging it
      // would tell the server Blake heard something he did not, and the server
      // would never offer it again. Settle it without an ack instead — the
      // deliberate-silence paths ack for themselves.
      else if (reason === 'interrupted' || reason === 'canceled' || reason === 'cancelled') finish(false);
      else finish(true);           // a voice fault is not a reason to repeat forever
    };

    const watchdog = setTimeout(() => {
      if (started || synth.speaking || synth.pending) return;
      blocked();
    }, START_TIMEOUT_MS);

    setSpeaking(true);
    try {
      synth.speak(utterance);
    } catch {
      blocked();
    }
  }

  /** Accept one SpeechItem `{seq, text, priority, at, key}`. */
  function offer(item) {
    if (!item || typeof item !== 'object') return false;
    const seq = Number(item.seq);
    const text = String(item.text ?? '').trim();
    if (!text) return false;
    if (Number.isFinite(seq)) {
      if (offered.has(seq)) return false;
      offered.add(seq);
    }
    if (!supported) { acknowledge(item); return false; }
    if (isMuted) { acknowledge(item); return false; }
    if (item.priority === 'high') queue.unshift({ seq, text });
    else queue.push({ seq, text });
    pump();
    return true;
  }

  function offerMany(items) {
    if (!Array.isArray(items)) return 0;
    let accepted = 0;
    for (const item of items) if (offer(item)) accepted += 1;
    return accepted;
  }

  return {
    supported,
    offer,
    offerMany,
    /** Call from any real user gesture. */
    unlock() {
      if (unlocked) { pump(); return; }
      unlocked = true;
      showActivation(false);
      pump();
    },
    setMuted(next) {
      isMuted = Boolean(next);
      if (isMuted) {
        // A deliberate silence, so the item that was mid-sentence is dropped on
        // purpose: ack it, or it comes back as stale news the next time the
        // page loads. (An *undeliberate* interruption is handled in `onerror`,
        // where the item is deliberately NOT acknowledged.)
        if (current) { acknowledge(current); current = null; }
        try { synth?.cancel(); } catch { /* ignore */ }
        setSpeaking(false);
        drainMuted();
        showActivation(false);
      } else {
        pump();
      }
    },
    get muted() { return isMuted; },
    get speaking() { return speaking; },
    get pending() { return queue.length; },
    get needsActivation() { return activationShown; },
    cancel() {
      queue.length = 0;
      try { synth?.cancel(); } catch { /* ignore */ }
      setSpeaking(false);
    },
    destroy() {
      stopped = true;
      queue.length = 0;
      try { synth?.cancel(); } catch { /* ignore */ }
    },
  };
}
