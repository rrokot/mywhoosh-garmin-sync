# Popup design

## Direction

A small action panel, not a dashboard. One MyWhoosh → Garmin button serves as both title and action; no separate header. Utilities are collapsed behind a centered chevron with an accessible name. Show no readiness headline, badge, auth speculation, marketing copy or permanent instructions.

## Content rules

- Idle: direction button and disclosure chevron. No result section before the first run.
- Running: the direction button is disabled and marked busy; one status line reports current / total, plus a native progress bar when available.
- Login: one instruction names the service and the opened tab. No repeated explanations.
- Complete: only Uploaded: N and the date. Do not display duplicate or per-activity failure statistics.
- Empty: Uploaded: 0 and the date.
- Failure: general run errors retain their message and an enabled action; per-activity failures remain in diagnostics. Announce results through one atomic live region.
- Advanced: two buttons only. Explain reset consequences after the first click, before confirmation.

## Visual system

304px wide; content-sized height, around 154px idle and 247px for a mixed result. Flat surface, 16px outer spacing, 17px product names, 12px status, 11px labels, tabular counts. Manrope regular/bold bundled locally with OFL license.

MyWhoosh website colors: yellow #fcb913, graphite #1d1e1f, neutral text #59636b, cool white #f9fbfc. Source: https://wpcdn-prod.mywhoosh.com/wp-content/themes/mywhoosh-2022/assets/css/style.css (checked 2026-11-17). Warning/error colors remain semantic. Visible keyboard outlines and reduced-motion support.

## Verification

Node VM tests cover UI states. Isolated browser previews mock Chrome APIs and never authenticate or upload. Preview scripts and screenshots live in ignored output/playwright/.
