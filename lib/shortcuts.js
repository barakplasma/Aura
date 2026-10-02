// Keyboard shortcuts (docs/PRD-ux-redesign.md, Phase 4): Space arms/disarms,
// 1–4 switch destinations. Esc closes a sheet, but Radix already owns that.
// Pure: takes the event's facts, returns what to do — so the rules that keep a
// shortcut from stealing a keystroke are testable without a DOM.

export const SHORTCUT_SCREENS = ['watch', 'alerts', 'setup', 'lab'];

const TEXT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

// `target` is { tag, editable, interactive, inDialog } — what the keydown hit.
// Space is left alone on anything that already uses it (a focused button or
// checkbox activates on Space); digits are left alone wherever text is typed.
export function shortcutAction({ key, ctrlKey, metaKey, altKey, repeat }, target = {}) {
  if (ctrlKey || metaKey || altKey || repeat) return null;
  if (target.inDialog) return null;
  if (TEXT_TAGS.has(target.tag) || target.editable) return null;
  if (key === ' ') return target.interactive ? null : { type: 'toggle' };
  const n = Number(key);
  if (Number.isInteger(n) && n >= 1 && n <= SHORTCUT_SCREENS.length) {
    return { type: 'go', screen: SHORTCUT_SCREENS[n - 1] };
  }
  return null;
}

// Reads the DOM facts shortcutAction wants off a real keydown target.
export function describeTarget(el) {
  if (!el || !el.tagName) return {};
  return {
    tag: el.tagName,
    editable: Boolean(el.isContentEditable),
    interactive: Boolean(el.closest?.('button, a[href], [role="button"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"]')),
    inDialog: Boolean(el.closest?.('[role="dialog"], [role="menu"]')),
  };
}
