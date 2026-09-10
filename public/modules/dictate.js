/**
 * Voice input. Requirement 6 allows an essential question to be answered "by
 * voice or text", so the composer accepts both.
 *
 * Speech recognition is not available in every browser, and it needs the same
 * kind of user gesture that speech output does. Both cases are handled the
 * same way: the button simply does not appear unless dictation can actually
 * work, so there is never a control that does nothing.
 */
export function createDictation({
  button,
  input,
  onFinal,
  onStateChange,
  recognitionClass = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition,
  lang = 'en-US',
} = {}) {
  const supported = typeof recognitionClass === 'function' && Boolean(button && input);
  let recognition = null;
  let listening = false;

  if (!supported) {
    if (button) button.hidden = true;
    return { supported: false, start() {}, stop() {}, toggle() {}, get listening() { return false; } };
  }

  button.hidden = false;

  function setListening(next) {
    if (listening === next) return;
    listening = next;
    button.setAttribute('aria-pressed', listening ? 'true' : 'false');
    button.classList.toggle('is-listening', listening);
    onStateChange?.(listening);
  }

  function build() {
    const r = new recognitionClass();
    r.lang = lang;
    r.continuous = false;
    r.interimResults = true;

    r.onresult = (event) => {
      let finalText = '';
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (interim) input.value = `${baseValue}${interim}`.trim();
      if (finalText) {
        input.value = `${baseValue}${finalText}`.trim();
        onFinal?.(input.value);
      }
    };

    r.onend = () => { setListening(false); recognition = null; };
    r.onerror = () => { setListening(false); recognition = null; };
    return r;
  }

  let baseValue = '';

  function start() {
    if (listening) return;
    baseValue = input.value ? `${input.value.trim()} ` : '';
    try {
      recognition = build();
      recognition.start();
      setListening(true);
      input.focus();
    } catch {
      // Permission refused or already running: leave the button unpressed.
      setListening(false);
      recognition = null;
    }
  }

  function stop() {
    if (!listening) return;
    try { recognition?.stop(); } catch { /* ignore */ }
    setListening(false);
  }

  button.addEventListener('click', () => (listening ? stop() : start()));

  return {
    supported: true,
    start,
    stop,
    toggle: () => (listening ? stop() : start()),
    get listening() { return listening; },
  };
}
