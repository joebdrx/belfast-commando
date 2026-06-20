# Belfast Commando — Agent / Contributor Guide

Belfast Survivor — a kick-heavy FPS MVP built with **Three.js** (Vite) with native
desktop bundles via **Tauri v2**.

## Git identity — REQUIRED

**Every commit and push to this repository MUST be authored *and* committed as
`joebdrx@gmail.com`.** Do not commit or push under any other identity (e.g. a
work/alias email). The public history must only ever contain `joebdrx@gmail.com`.

Before committing, verify the active identity:

```bash
git config user.email   # must print exactly: joebdrx@gmail.com
```

If it prints anything else, set it before committing:

```bash
git config user.email joebdrx@gmail.com
```

If you ever find local or staged commits authored by a different email, **stop**,
fix the identity, and rewrite those commits (e.g. `git rebase`/`git commit --amend`
or `git filter-branch --env-filter`) so no other email reaches the remote.

## Commands

- `npm run dev` — Vite dev server at `http://localhost:1420`
- `npm run build` — production web build → `dist/`
- `npm test` — Vitest suite (run before committing)
- `npm run tauri dev` / `npm run tauri build` — native desktop app

## Releases — cross-platform desktop builds (GitHub Actions)

Native desktop bundles are built and published automatically by
`.github/workflows/release.yml` using `tauri-apps/tauri-action`. The `release`
job builds on:

- **Linux** (`ubuntu-22.04`) → `.AppImage` + `.deb`
- **macOS** (`macos-latest`) → universal (Intel + Apple Silicon) `.dmg`
- **Windows** (`windows-latest`) → `.exe` (NSIS) + `.msi`

and attaches them to a GitHub Release.

To cut a release:

1. Bump `version` in `package.json` **and** `src-tauri/tauri.conf.json`.
2. Commit (as `joebdrx@gmail.com`), then tag and push:
   ```bash
   git tag v0.1.1
   git push origin v0.1.1
   ```
3. The workflow runs on the `v*` tag and publishes the installers. It can also be
   run manually: **Actions → release → Run workflow** (supply the tag).

The main-menu "Download Desktop Version" button links to the latest GitHub Release.

## Project layout notes

- `src/` — game + UI source (Three.js, Vite). `src/game/Hub.js` is the main-menu scene.
- `public/` — curated runtime assets (textures, models, sfx) served at the web root.
- `assets/` — large source / AI-generated assets, **gitignored**; curate into `public/` as needed.
- `src-tauri/` — Tauri v2 desktop shell + bundle config.
- Stage only explicit, intended paths when committing — avoid blind `git add -A`.
