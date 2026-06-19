/**
 * controls
 * --------
 * The control-scheme reference shared by the safehouse Settings panel and the
 * pause menu's Controls view. Rendered as the global `.controls-grid` markup
 * (styled in styles.css), so every consumer gets the keycap-chip look for free.
 *
 * Two schemes: keyboard/mouse (desktop) and the on-screen touch layout. Callers
 * pick which to show via `controlsGridHTML(isTouchDevice())`.
 */

/** Desktop keyboard + mouse bindings (action, keys). */
export const KEYBOARD_CONTROLS = [
  ["Move", "W A S D"],
  ["Sprint", "Shift"],
  ["Jump", "Space"],
  ["Slide", "Ctrl / C"],
  ["Kick", "F"],
  ["Shoot", "Left Mouse"],
  ["Weapons", "1 2 3 / Q / Wheel"],
  ["Reload", "R"],
  ["Mute", "M"],
];

/** On-screen touch layout (mirrors TouchControls). */
export const TOUCH_CONTROLS = [
  ["Move", "Left stick"],
  ["Look", "Drag right"],
  ["Sprint", "Stick to rim"],
  ["Shoot", "Fire (hold)"],
  ["Jump", "Jump button"],
  ["Kick", "Kick button"],
  ["Reload", "Rld button"],
  ["Weapons", "Wpn button"],
  ["Pause", "❚❚ (top)"],
];

const escapeHtml = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

/**
 * Build the `.controls-grid` markup for the active scheme.
 * @param {boolean} [touch] true → touch layout, else keyboard/mouse.
 * @returns {string} HTML safe to assign to innerHTML.
 */
export function controlsGridHTML(touch = false) {
  const rows = (touch ? TOUCH_CONTROLS : KEYBOARD_CONTROLS)
    .map(([action, keys]) => `<span>${escapeHtml(action)}</span><b>${escapeHtml(keys)}</b>`)
    .join("");
  return `<div class="controls-grid">${rows}</div>`;
}
