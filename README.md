# Lights On 14th - Listen Sync

Plays the show audio on phones and browsers in sync with the lights. Audio is not streamed live: each listener downloads the song file and starts it at the exact position FPP is playing, using a clock shared through the relay.

```
FPP master (fpp-plugin-listen-sync)  --wss-->  Relay (this repo, Cloudflare)  --wss-->  Phones / browsers
         uploads audio files  ----------------->  R2  <----------- download audio
```

- **This repo:** the relay Worker and the browser player (`client.js`), plus a standalone listen page at `https://listen.lightson14th.com`.
- **[fpp-plugin-listen-sync](https://github.com/LightsOn14th/fpp-plugin-listen-sync):** the FPP plugin that sends the playback position and uploads the audio.
- Wire format: [PROTOCOL.md](PROTOCOL.md).

## Development

```sh
yarn install
cp .dev.vars.example .dev.vars   # FPP_TOKEN for local testing
yarn dev                         # http://localhost:8787
yarn simulate                    # in a second terminal: fake FPP playing click tracks
```

Open http://localhost:8787 on two devices (or two browser tabs) and press Listen. The simulator plays click tracks with a click every second and a higher click every fourth second, so sync can be judged by ear.

Checks:

```sh
yarn typecheck
yarn lint
yarn test
```

## Deploy (first time)

1. `npx wrangler login`
2. `npx wrangler r2 bucket create lights-on-14th-listen-media`
3. `npx wrangler secret put FPP_TOKEN` and enter a long random token (for example `openssl rand -hex 32`).
4. `yarn deploy`. The custom domain `listen.lightson14th.com` is created in the existing Cloudflare zone by the `routes` entry in `wrangler.jsonc`.
5. Save the same token on the FPP plugin page.

Later deploys: `yarn deploy`.

## Using the player on another site

`client.js` is served with CORS from the relay, so the main website can load it without bundling:

```js
const { ListenSync } = await import( /* webpackIgnore: true */ 'https://listen.lightson14th.com/client.js' )

const player = new ListenSync( { relayUrl: 'https://listen.lightson14th.com', offsetMs: 0 } )

player.addEventListener( 'status', ( event ) => console.log( event.detail ) )

// Inside a click handler:
await player.start()
```

## Cost

Everything fits the Cloudflare free plans for one show: Durable Object duration while a show runs is about 2,800 GB-s a night (13,000 a day free), outgoing WebSocket messages are not billed, and R2 storage for a season of songs is well under the 10 GB free tier. R2 has to be enabled on the account first.
