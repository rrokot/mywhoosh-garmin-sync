# AGENTS.md

## Project Scope
- This repository is extension-only.
- Main code lives in `browser-extension/`.
- Do not add legacy Python/BAT sync flows back.

## Main Components
- `browser-extension/background.js`: core sync, MyWhoosh API, Garmin upload logic.
- `browser-extension/content-mywhoosh.js`: reads MyWhoosh auth from page storage.
- `browser-extension/popup.js` + `browser-extension/popup.html`: UI actions and status.
- `tools/tail_extension_logs.ps1` + `tail_extension_logs.bat`: debug log extraction.

## Working Rules
- Keep Garmin upload path API-first (`connectapi`).
- Keep sync mode behavior:
  - `new` uploads only not-yet-processed activities.
  - `latest` uploads only latest new activity.
- Mark activity as processed only on `uploaded` or `duplicate`.
- Preserve flat logs (`MWGLOG`) in `chrome.storage.local` for diagnostics.

## Validation Before Finish
- Run:
  - `node --check browser-extension/background.js`
  - `node --check browser-extension/content-mywhoosh.js`
- If extension behavior changed, bump `browser-extension/manifest.json` version.

## Manual Runtime Check
1. Open `chrome://extensions`.
2. Reload unpacked extension from `browser-extension/`.
3. Open MyWhoosh activities page.
4. Click extension icon and run sync.
5. If needed, inspect logs:
   - `.\tail_extension_logs.bat`
   - `.\tail_extension_logs.bat -ErrorsOnly`
