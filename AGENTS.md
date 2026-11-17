# AGENTS.md

Chrome extension only. Code: `browser-extension/`. Tests: `tests/`.

## Rules

- Upload to Garmin through `connectapi`; process only activities not already marked as processed.
- Mark an activity processed only after `uploaded` or `duplicate`, and persist `processedFitKeys` after each activity.
- Reuse stored `mywhooshAuth` and the current Chrome Garmin session. When login is needed, open the relevant tab and resume automatically.
- Keep flat `MWGLOG` entries in `chrome.storage.local.syncLogLines`. Debounce writes; flush errors immediately.
- Restrict `host_permissions` to required hosts. Never use `<all_urls>`.
- Collect input in the popup or login tab; do not use page `prompt()`.
- Keep the popup minimal: MyWhoosh → Garmin button, Uploaded count, date. Logs and cache clearing belong in a collapsed, arrow-only block.

## Validation

Run `npm run verify` before finishing. Bump `browser-extension/manifest.json` when extension behavior changes.

For runtime checks, reload in `chrome://extensions`, start an upload and complete any requested login. Read diagnostics with `tools/tail_extension_logs.ps1` (`-ErrorsOnly` filters errors).
