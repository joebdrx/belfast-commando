# Desktop build downloads

The main menu's **Download Desktop Version** button links to the native Tauri
installers served from this folder (`public/downloads/`, served at `/downloads/`).
Drop the built bundles here with these exact names (Tauri's defaults for
`productName: belfast-commando` v0.1.0):

| OS | File |
| --- | --- |
| Windows | `belfast-commando_0.1.0_x64-setup.exe` |
| macOS | `belfast-commando_0.1.0_x64.dmg` |
| Linux | `belfast-commando_0.1.0_amd64.AppImage` |

## Build them

```bash
npm run tauri build
```

Bundles land in `src-tauri/target/release/bundle/`. Copy the ones you want here, e.g.:

```bash
cp src-tauri/target/release/bundle/appimage/*.AppImage \
   public/downloads/belfast-commando_0.1.0_amd64.AppImage
```

Each platform's installer must be built on (or cross-compiled for) that platform.

## Hosting externally instead

These binaries are large; if you'd rather not commit them, host them on a GitHub
Release and point the menu there: set `DESKTOP_BUILD.baseUrl` in
`src/game/Menu.js` to the release asset base URL (the filenames stay the same).

The filename/version live in `DESKTOP_BUILD` in `src/game/Menu.js` — bump them when
`src-tauri/tauri.conf.json` `version` changes.
