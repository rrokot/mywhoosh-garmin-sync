# MyWhoosh -> Garmin (Chrome Extension)

This project now works only via the Chrome extension in `browser-extension/`.

## Run

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select folder: `C:\Users\rroko\mywhoosh-garmin-sync\browser-extension`.
5. Open MyWhoosh activities page and click extension icon.

## Logs

Use:

```powershell
cd C:\Users\rroko\mywhoosh-garmin-sync
.\tail_extension_logs.bat
```

Useful filters:

```powershell
.\tail_extension_logs.bat -ErrorsOnly
.\tail_extension_logs.bat -Tail 80
.\tail_extension_logs.bat -SinceMinutes 30
```
