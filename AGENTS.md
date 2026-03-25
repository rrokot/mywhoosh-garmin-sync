# AGENTS.md

## Project Scope
- This repository is extension-only.
- Main code lives in `browser-extension/`.
- Do not add legacy Python/BAT sync flows back.

## Main Components
- `browser-extension/background.js`: service worker entrypoint that loads background modules.
- `browser-extension/background/runtime.js`: shared constants, logging, storage, Chrome adapters.
- `browser-extension/background/garmin.js`: Garmin auth and upload flow.
- `browser-extension/background/mywhoosh.js`: MyWhoosh API client and payload normalization.
- `browser-extension/background/service-worker.js`: sync orchestration and Chrome listeners.
- `browser-extension/content/mywhoosh-auth.js`: reads MyWhoosh auth from page storage.
- `browser-extension/popup/popup.js` + `browser-extension/popup/popup.html`: UI actions and status.
- `tools/tail_extension_logs.ps1`: debug log extraction.

## Working Rules
- Keep Garmin upload path API-first (`connectapi`).
- Keep sync behavior:
  - `Sync` uploads only not-yet-processed activities.
- Mark activity as processed only on `uploaded` or `duplicate`.
- Preserve flat logs (`MWGLOG`) in `chrome.storage.local` for diagnostics.
- Keep MyWhoosh auth flow token-based:
  - use stored `mywhooshAuth` when valid
  - if missing/expired, open interactive MyWhoosh login tab and continue automatically
- Keep Garmin auth flow session-based:
  - use current Chrome Garmin session
  - if auth is missing, open interactive Garmin login tab and continue automatically
- Do not reintroduce page `prompt()`-based UX on MyWhoosh pages.

## Validation Before Finish
- Run:
  - `node --check browser-extension/background.js`
  - `node --check browser-extension/content/mywhoosh-auth.js`
- If extension behavior changed, bump `browser-extension/manifest.json` version.

## Manual Runtime Check
1. Open `chrome://extensions`.
2. Reload unpacked extension from `browser-extension/`.
3. Click extension icon and run `Sync`.
4. If MyWhoosh or Garmin login is required, complete sign-in in the tab opened by the extension.
5. If needed, inspect logs:
   - `powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\tail_extension_logs.ps1`
   - `powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\tail_extension_logs.ps1 -ErrorsOnly`
   - pass `-ExtensionId` only if auto-detection picks the wrong extension storage
