# Design: Mobile Sprint Button, Civilian Rescue Tap, Fullscreen Toggle

**Date:** 2026-06-19  
**Branch:** feat/mobile-sprint-civilians

---

## Feature 1 — Sprint Button (TouchControls)

### Problem
The joystick sends `ShiftLeft: true` via `onMove` only when the stick reaches the rim. A naive button that emits `onKeyDown("ShiftLeft")` fights with `onMove` firing `ShiftLeft: false` on every frame when the stick is below the rim threshold.

### Design
Add `onSprintDown` / `onSprintUp` callbacks to `TouchControls.setHandlers()`. Wire a **"Run"** button in the bottom-right cluster (same CSS style as jump/kick). In `main.js`, track `_touchSprintBtn = false`; in `onMove`, after applying joystick keys, force `player.keys["ShiftLeft"] = true` when `_touchSprintBtn` is true so the button wins over the joystick's value.

- **Files changed:** `TouchControls.js`, `main.js`
- **Desktop unaffected:** no change to keyboard/mouse path
- **Button position:** bottom-right cluster, left of the Fire button

---

## Feature 2 — Free Civilian by Tapping Interact Prompt

### Clarification
The spec calls the interact prompt a "dialogue box." The current flow is: approach → interact prompt ("Press E to free the civilian") → press E → rescue → "Thank you!" dialogue. The tappable element is the **interact prompt**, not the post-rescue dialogue.

### Design
Add `setInteractCallback(fn)` to `HUD`. When `fn` is non-null:
- `pointerEvents` switches from `"none"` to `"auto"`
- `cursor` becomes `"pointer"`
- A `click` listener calls `fn`

In `Victim.update()`:
- When `inRange` becomes true: call `ctx.hud.setInteractCallback(() => this._rescue(ctx))`
- When `inRange` becomes false or rescue fires: call `ctx.hud.setInteractCallback(null)`

The existing `KeyE` press path is preserved unchanged. Rescue cannot be triggered twice (guarded by `this.rescued`).

- **Files changed:** `HUD.js`, `Victim.js`
- **Works on:** mobile (tap) and desktop (click)

---

## Feature 3 — Fullscreen Toggle Button

### Design
Both `Menu.js` and `PauseMenu.js` add a fullscreen button to their button rows. The button:
- Reads **"⛶ Fullscreen"** when `!document.fullscreenElement`
- Reads **"⊡ Exit Fullscreen"** when `document.fullscreenElement`
- Calls `document.documentElement.requestFullscreen()` or `document.exitFullscreen()`
- Listens to `document` `fullscreenchange` to update its own label reactively
- Is hidden (via `style.display = "none"`) if `document.fullscreenEnabled` is false

- **Files changed:** `Menu.js`, `PauseMenu.js`
- **Works on:** desktop and mobile

---

## Out of scope
- Slide / crouch button for mobile
- Interact button for non-civilian use cases (doors etc.)
- Keyboard rebinding
