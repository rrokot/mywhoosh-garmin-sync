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
2. Click `Sync`.
3. If MyWhoosh or Garmin is not authenticated, the extension will automatically open a login tab.
4. Complete the login in the opened tab. Sync will continue automatically.
5. `Copy Debug Logs` copies the log from the last run.
6. `Clear Cache` clears the auth cache, processed keys, statuses, and logs.

## Popup Status

- `Processed` — how many activities have been processed in the current run
- `Uploaded` — how many activities were uploaded to Garmin
- `Duplicate` — how many activities Garmin already knew about
- `Failed` — how many activities could not be processed
