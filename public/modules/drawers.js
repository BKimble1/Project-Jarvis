/**
 * Drawers: everything that is not one of the five default-view pieces lives
 * here, and every one of them is CLOSED on load (acceptance req. 4).
 *
 * A toggle is any element with `data-panel="<id>"`. The panel it names is
 * hidden/shown with the `hidden` attribute (no CSS-only hiding, so the markup
 * itself is honest about what is on screen), `aria-expanded` tracks state, only
 * one drawer is open at a time, and Escape closes the open one and returns
 * focus to the control that opened it.
 */

export function createDrawers({ root = document, onOpen, onClose } = {}) {
  const toggles = Array.from(root.querySelectorAll('[data-panel]'));
  const panels = new Map();
  let openId = null;
  let opener = null;

  for (const toggle of toggles) {
    const id = toggle.dataset.panel;
    const panel = root.getElementById?.(id) ?? document.getElementById(id);
    if (!panel) continue;
    panels.set(id, panel);
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', id);
    toggle.addEventListener('click', () => toggle_(id, toggle));
  }

  function syncToggles() {
    for (const toggle of toggles) {
      const isOpen = toggle.dataset.panel === openId;
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      toggle.classList.toggle('is-open', isOpen);
    }
  }

  function close(id = openId, { restoreFocus = false } = {}) {
    if (!id) return;
    const panel = panels.get(id);
    if (!panel) return;
    const wasOpen = openId === id;
    panel.hidden = true;
    if (wasOpen) openId = null;
    syncToggles();
    onClose?.(id);
    // Only the drawer that actually held focus owns the return journey; closing
    // some other panel must not throw away the open one's opener.
    if (wasOpen) {
      if (restoreFocus) opener?.focus?.();
      opener = null;
    }
  }

  function open(id, from = null) {
    const panel = panels.get(id);
    if (!panel) return;
    if (openId && openId !== id) close(openId);
    panel.hidden = false;
    openId = id;
    opener = from;
    syncToggles();
    onOpen?.(id, panel);
    const focusable = panel.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    (focusable ?? panel).focus?.({ preventScroll: true });
  }

  function toggle_(id, from) {
    if (openId === id) close(id, { restoreFocus: true });
    else open(id, from);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && openId) {
      event.stopPropagation();
      close(openId, { restoreFocus: true });
    }
  });

  for (const [id, panel] of panels) {
    for (const button of panel.querySelectorAll('[data-close-panel]')) {
      button.addEventListener('click', () => close(id, { restoreFocus: true }));
    }
  }

  return {
    open,
    close,
    toggle: toggle_,
    closeAll: () => close(openId),
    isOpen: (id) => openId === id,
    get openId() { return openId; },
    ids: () => Array.from(panels.keys()),
  };
}
