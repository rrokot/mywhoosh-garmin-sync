# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product Purpose

A Chrome extension that transfers MyWhoosh FIT activities to Garmin Connect.
The popup starts a manual sync of activities not previously processed and reports its outcome.

## Users and Operating Context

MyWhoosh users transferring workouts to Garmin, through a compact Chrome extension popup.
Audience beyond this workflow and ambient-light preferences are unspecified.

## Capabilities and Constraints

- Extension-only; static HTML/CSS/JavaScript, no framework or remote UI dependencies.
- Keep existing token-based MyWhoosh and session-based Garmin login flows.
- Preserve sync, diagnostic log copying and confirmed cache clearing.
- User explicitly requested a complete popup redesign with both utility buttons in one collapsed disclosure.
- Explain partial failures clearly. Preserve all existing sync invariants in AGENTS.md.

## Evidence on Hand

README.md, browser-extension/popup/, background modules and node:test suites.
No user research or claims beyond repository behavior supplied.

## Brand Commitments

Use MyWhoosh colors for the extension UI, as requested by the user. Keep success, warning and error states distinguishable.

