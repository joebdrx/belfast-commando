/** Create an element with optional class + text. Shared by Menu and PauseMenu. */
export function createEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}
