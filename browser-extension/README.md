# Browser Extension (MVP)

## Install (Chrome)

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select folder: `C:\Users\rroko\mywhoosh-garmin-sync\browser-extension`

## Use

1. Log in to MyWhoosh and Garmin Connect in the same Chrome profile.
2. Open any MyWhoosh page (same profile where login is active).
3. Click extension icon in Chrome toolbar.
4. Choose action in popup:
   - `Upload New Activities`
   - `Upload Latest Activity`
   - `Copy Debug Logs` (copies last lines to clipboard)

## Notes

- No button is injected into the MyWhoosh site.
- Extension popup has two run modes: all new or latest only.
- Extension calls MyWhoosh API directly (`service14`) and does not depend on page DOM.
- Strict Garmin state: activity is marked processed only after Garmin returns `uploaded` or `duplicate`.
- `Only new`: processed activities are skipped on next runs.
- Failed uploads are not marked as processed and will be retried next run.
- To reset "new/processed" history, clear this extension storage in `chrome://extensions` -> `Service worker` -> `Application` -> `Storage`.
- Structured logs are stored in `chrome.storage.local` key `syncLogs`.
- Flat grep-friendly lines are stored in `chrome.storage.local` key `syncLogLines` (prefix `MWGLOG`).
