# MyWhoosh -> Garmin

A Chrome extension that syncs workouts from MyWhoosh to Garmin Connect.

## Installation

1. Clone the repository or extract the project into any folder on your computer.
2. Open `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select the `browser-extension` folder from the root of the project.

## Usage

1. Click the extension icon.
2. Click `MyWhoosh → Garmin`.
3. If MyWhoosh or Garmin is not authenticated, the extension will automatically open a login tab.
4. Complete the login in the opened tab. Sync will continue automatically.
5. Expand the chevron below the result to access `Copy logs` and `Clear Cache`.
6. `Copy logs` copies the log from the last run. `Clear Cache` clears the auth cache, processed keys, statuses, and logs. The first click explains what will be cleared; click again within 30 seconds to confirm.

## Popup Status

After a sync, the popup shows only the number uploaded to Garmin and the date. During a run, it shows progress or a login instruction. General sync errors remain visible; per-activity details are available in debug logs under Advanced.

## Development

- `npm run check` — syntax-checks every extension script.
- `npm test` — runs the `node:test` suites in `tests/`.
- `npm run verify` — both of the above; run this before committing.

No dependencies are required: the tests load the real background modules in a
`vm` sandbox with a stubbed Chrome API.
