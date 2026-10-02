# Listen Sync protocol (version 1)

Three parties: the **plugin** on the FPP master, the **relay** (Cloudflare Worker + Durable Object), and **listeners** (browsers). Types live in [src/shared/protocol.ts](src/shared/protocol.ts); the C++ plugin follows the same shapes.

## Clocks

All timestamps on the wire are milliseconds on the **relay clock** (`Date.now()` inside the Durable Object, read when a message arrives).

Each peer estimates `offset = relay - local` with pings:

1. Peer sends `{ "type": "ping", "id": n, "t0": <local ms> }` using a monotonic local clock (`performance.now()` in browsers, `steady_clock` on the Pi).
2. Relay replies `{ "type": "pong", "id": n, "t0": <echoed>, "ts": <relay ms> }`.
3. Peer records `offset = ts - (t0 + t1) / 2` and `rtt = t1 - t0`.

The estimate is the median offset of the 3 fastest of the last 16 samples. Neither the Pi nor the phone needs a correct wall clock.

## Endpoints

| Path | Who | Purpose |
| --- | --- | --- |
| `GET /ws` (WebSocket) | listeners | Show state and position samples |
| `GET /fpp` (WebSocket, `Authorization: Bearer <token>`) | plugin | Position samples, playlist, heartbeats |
| `GET /api/state` | anyone | Current show state as JSON |
| `GET /api/media` (bearer) | plugin | `{ "files": { "<name>": "<version>" } }` |
| `PUT /media/<name>?version=<v>` (bearer) | plugin | Upload or replace an audio file |
| `GET`/`HEAD /media/<name>` | anyone | Audio file, with `Range` support and CORS |

File names are percent-encoded per RFC 3986 (`%20` for spaces, never `+`).

## Plugin to relay

```jsonc
{ "type": "media", "state": "playing", "file": "Song.mp3", "pos": 12.345, "at": 1790949083494.2 }
{ "type": "media", "state": "stopped", "file": "Song.mp3", "pos": 0, "at": 0 }
{ "type": "playlist", "name": "Main Show", "items": [ "Song.mp3", "Other.mp3" ] }
{ "type": "hb" }
```

`pos` seconds into `file` was leaving FPP's audio output at relay time `at`. FPP 10 already corrects its reported position for audio output latency. The plugin sends a sample every 0.5 s, immediately on a file change, and a stop when the media stops. `hb` every 10 s keeps the connection marked alive.

## Relay to listeners

```jsonc
{ "type": "hello", "protocol": 1, "show": ShowState }   // on connect
{ "type": "show", "show": ShowState }                   // on any state change
{ "type": "sample", "sample": { "file": "...", "pos": 12.3, "at": ... } }
```

`ShowState`:

```jsonc
{
    "source": "online" | "offline",
    "state": "playing" | "stopped",
    "current": { "file": "Song.mp3", "version": "4012345-10/02/26  09:00 AM" } | null,
    "playlist": { "name": "Main Show", "items": [ MediaRef, ... ] } | null,
    "sample": MediaSample | null
}
```

`version` is `null` when the file has not been uploaded yet; listeners show it as unavailable. If the plugin disconnects, the relay marks the source offline but keeps the state for 60 s so listeners can keep playing through a short network drop.

## Listener playback

For each sample the listener computes the song "epoch" `at / 1000 - pos` (relay time at which position 0 played) and takes the median of recent epochs. The position to hear at local time `p` is:

```
position( p ) = ( p + clockOffset - userOffsetMs ) / 1000 - epoch
```

That position is mapped to AudioContext time through `getOutputTimestamp()` and started with `AudioBufferSourceNode.start( when, offset )`. Every 250 ms the player compares the heard position with the expected one and reschedules with a 15 ms crossfade when the error stays above 20 ms (or immediately above 80 ms).
