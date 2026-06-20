# CLAUDE.md

Guidance for Claude Code (and other AI agents) working in this repo. This mirrors
[`AGENTS.md`](./AGENTS.md) — read that for the full contributor guide.

## Git identity — REQUIRED

**Every commit and push to this repository MUST be authored *and* committed as
`joebdrx@gmail.com`.** Never commit or push under any other identity (e.g. a
work/alias email). The public history must only ever contain `joebdrx@gmail.com`.

Before committing, verify and fix if needed:

```bash
git config user.email                      # must be joebdrx@gmail.com
git config user.email joebdrx@gmail.com    # set it if it isn't
```

If any local/staged commit has a different author email, stop and rewrite it before pushing.

## Commands

- `npm run dev` — Vite dev server (`http://localhost:1420`)
- `npm run build` — production web build → `dist/`
- `npm test` — Vitest suite (run before committing)
- `npm run tauri dev` / `npm run tauri build` — native desktop app

## Releases

Tagging `vX.Y.Z` and pushing triggers `.github/workflows/release.yml`, which builds
the Tauri desktop bundles for **Linux** (.AppImage/.deb), **macOS** (universal .dmg)
and **Windows** (.exe/.msi) and publishes them to a GitHub Release. Bump `version` in
both `package.json` and `src-tauri/tauri.conf.json` first. See [`AGENTS.md`](./AGENTS.md).
