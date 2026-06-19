# Belfast Survivor

A fast, kick-heavy first-person shooter MVP set in modern-day Belfast — inspired by
*Anger Foot*. Run, breach doors with your boot, boot/shoot the invaders, chain your
kills for a bigger multiplier, and reach the exit.

Built with **Three.js** (engine/rendering), **Vite** (dev/build), and **Tauri v2**
(native desktop wrapper), with optional **Steamworks** achievements + leaderboards.

<img width="1198" height="1294" alt="belfast-survivor-final" src="https://github.com/user-attachments/assets/dce0c3af-546a-45b9-820e-6afa30a9473b" />

## Controls

| Action | Key |
| --- | --- |
| Move | `W A S D` |
| Sprint | `Shift` |
| Jump | `Space` |
| Slide | `Ctrl` / `C` (while sprinting) |
| **Kick** (breach doors / boot enemies) | `F` |
| Shoot | `Left Mouse` |
| Switch weapon | `1` `2` `3` / `Q` |
| Mute | `M` |

Click the canvas to capture the mouse; `Esc` releases it (and soft-pauses).

## Project layout

```
src/
  main.js            # bootstrap, game loop, state machine, level progression
  game/
    Engine.js        # renderer, overcast sky, lighting, fog, camera
    Player.js        # pointer-lock look, WASD/sprint/jump/slide/kick, collision
    Weapon.js        # hitscan, muzzle flash, tracers, decals, bob/sway, switching
    Level.js         # procedural Belfast street, kickable doors, cover, exit
    Enemy.js         # placeholder soldiers: AI, damage/kick reaction, ragdoll
    Audio.js         # synthesized SFX (Web Audio) + voice lines (SpeechSynthesis)
    HUD.js           # score/combo/timer/health/weapon overlay + callouts
    Score.js         # combo multiplier + time-bonus scoring
  utils/
    steam.js         # Tauri invoke wrapper (no-op fallback in browser dev)
src-tauri/
  src/lib.rs         # Tauri app + feature-gated Steamworks commands
  tauri.conf.json    # immersive borderless/maximized window config
  capabilities/      # window permissions
```

## Develop & run

```bash
npm install

# Browser dev (fast iteration; Steam calls are stubbed/no-op):
npm run dev

# Native desktop app (Tauri):
npm run tauri dev

# Production build:
npm run tauri build
```

### Linux system dependencies (Tauri v2)

Building the native app requires the usual Tauri v2 GTK/WebKit stack:
`webkit2gtk-4.1`, `javascriptcoregtk-4.1`, `gtk+-3.0`, `libsoup-3.0` (plus the
standard Rust toolchain). On Debian/Ubuntu:

```bash
sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev build-essential \
  curl wget file libxdo-dev libssl-dev libgtk-3-dev librsvg2-dev
```

## Steamworks integration

Steam support is **feature-gated and OFF by default** so the app always compiles
without the Steam SDK. The Rust commands (`unlock_achievement`,
`update_leaderboard`, `steam_status`) exist in every build; with the feature off
they return a graceful stub.

Enable the real integration with the `steam` Cargo feature:

```bash
# from src-tauri/
cargo build --features steam
# or via tauri:
npm run tauri build -- --features steam
```

When enabled, the app initialises the Steam client in the Tauri `setup` hook and
**fails gracefully** (logs a warning, no panic) if the Steam client isn't running.
Replace the placeholder `STEAM_APP_ID` (480 = Spacewar) and
`STEAM_LEADERBOARD_NAME` in `src-tauri/src/lib.rs` with your registered AppID and
leaderboard once you have them from the Steamworks partner portal.

The frontend calls Steam through `src/utils/steam.js`:

```js
import { Steam } from "./utils/steam.js";
await Steam.unlock("ACH_FIRST_KICK");
await Steam.submitScore(score);
```

## Status

MVP scaffold: fluid FPS movement + kicking, hitscan gunplay with juice, kickable
doors, reactive enemies, procedural Belfast street levels with progression,
combo-based scoring, synthesized audio, and a desktop/Steam-ready shell. Art is
intentionally placeholder low-poly geometry.
