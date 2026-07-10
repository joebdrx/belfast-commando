# Belfast Survivor

A fast, kick-heavy first-person shooter MVP set in modern-day Belfast — inspired by
*Anger Foot*. Run, breach doors with your boot, boot/shoot the invaders, chain your
kills for a bigger multiplier, and reach the exit.

Built with **Three.js** (engine/rendering), **Vite** (dev/build), and **Tauri v2**
(native desktop wrapper), with optional **Steamworks** achievements + leaderboards.

<img width="500" height="550" alt="belfast-survivor-final" src="https://raw.githubusercontent.com/joebdrx/belfast-commando/refs/heads/master/belfast-survivor-final.png" />

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

## Campaign

The game now ships as a seven-operation campaign. Every sector bends the shared
procedural city generator into a different combat map: the Falls Road breach
maze, Shankill street gauntlet, Markets arena, Docks container yard, Ardoyne
tenement maze, Short Strand siege pocket, and the vertical Divis Tower finale.

Clears unlock the next operation and bank persistent Resistance Points for
weapons, boots, and upgrades. Each operation also tracks a best score, best time,
best rank, and three mastery medals (clear, beat par, rescue every civilian), so
completed sectors remain worthwhile replay targets. Campaign completion returns
to a fully unlocked operation board for score-chasing and repeat liberations.

## Status

Playable full campaign with fluid FPS movement, kicking, hitscan gunplay,
kickable doors, four enemy archetypes, civilians, modifiers, extraction goals,
persistent progression, mission grading, achievements, controller/touch input,
and browser/Tauri distribution. The visual direction intentionally retains a
grimy low-poly/retro character.
