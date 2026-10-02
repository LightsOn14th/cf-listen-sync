# Changelog

## [NEXT_VERSION] - [UNRELEASED]
* FEA: Relay - Cloudflare Worker with a Durable Object that relays the FPP playback position to listeners over WebSockets, answers clock pings, and keeps the last show state.
* FEA: Media - Store show audio in R2, accept uploads from the FPP plugin with a bearer token, and serve files publicly with range support.
* FEA: Player - Browser player that syncs its clock to the relay, schedules the current song with Web Audio against the device output clock, corrects drift with short crossfades, and downloads the next song ahead of time.
* FEA: Listen page - Standalone page with a listen button, a per-device audio offset control, and diagnostics.
* TSK: Simulator - Script that stands in for the FPP plugin and plays click tracks, for testing without the show Pi.
