# Changelog

## [NEXT_VERSION] - [UNRELEASED]
* FEA: Listener Analytics - Record anonymous listener sessions (a random id kept in the browser, a device class, start and end times; no IP address or user agent is stored) and song plays in the Durable Object SQLite storage, kept for 400 days. Add `/api/listeners/live`, `/api/listeners/history` and `/api/listeners/history/<date>` with live listeners, a summary per show date (America/New_York), listeners per minute and listeners per song.
* ENH: Player - Add an `app` option; `admin` connections are left out of the listener count and the analytics.
* FEA: Relay - Cloudflare Worker with a Durable Object that relays the FPP playback position to listeners over WebSockets, answers clock pings, and keeps the last show state.
* FEA: Media - Store show audio in R2, accept uploads from the FPP plugin with a bearer token, and serve files publicly with range support.
* FEA: Player - Browser player that syncs its clock to the relay, schedules the current song with Web Audio against the device output clock, corrects drift with short crossfades, and downloads the next song ahead of time.
* FEA: Listen page - Standalone page with a listen button, a per-device audio offset control, and diagnostics.
* TSK: Simulator - Script that stands in for the FPP plugin and plays click tracks, for testing without the show Pi.
