/**
 * Wire protocol shared by the relay Worker, the browser client and (by
 * convention, see PROTOCOL.md) the FPP plugin.
 *
 * All timestamps are milliseconds on the RELAY clock. Each peer estimates its
 * own offset to the relay with ping/pong, so no peer depends on its wall clock
 * being correct.
 *
 * @since  [NEXT_VERSION]
 */
export const PROTOCOL_VERSION = 1

/**
 * Playback state reported by FPP.
 *
 * @since  [NEXT_VERSION]
 */
export type PlaybackState = 'playing' | 'stopped'

/**
 * One position sample: `pos` seconds into `file` was leaving FPP's audio
 * output at relay time `at`.
 *
 * @since  [NEXT_VERSION]
 */
export interface MediaSample {
    file: string
    pos: number
    at: number
}

/**
 * A media file the relay can serve, with a version string that changes when
 * the file on FPP changes.
 *
 * @since  [NEXT_VERSION]
 */
export interface MediaRef {
    file: string
    version: string | null
}

/**
 * Everything a listener needs to start or resume playback.
 *
 * @since  [NEXT_VERSION]
 */
export interface ShowState {
    source: 'online' | 'offline'
    state: PlaybackState
    current: MediaRef | null
    playlist: {
        name: string
        items: MediaRef[]
    } | null
    sample: MediaSample | null
}

/**
 * Clock ping. `t0` is the sender's own clock and is echoed back unchanged.
 *
 * @since  [NEXT_VERSION]
 */
export interface PingMessage {
    type: 'ping'
    id: number
    t0: number
}

/**
 * Messages sent by the FPP plugin to the relay.
 *
 * @since  [NEXT_VERSION]
 */
export type PluginMessage =
    | PingMessage
    | { type: 'media', state: PlaybackState, file: string, pos: number, at: number }
    | { type: 'playlist', name: string, items: string[] }
    | { type: 'hb' }

/**
 * Messages sent by a listener to the relay.
 *
 * @since  [NEXT_VERSION]
 */
export type ListenerMessage = PingMessage

/**
 * Messages sent by the relay to the plugin and to listeners.
 *
 * `hello` and `show` carry the full state; `sample` is the frequent position
 * update and only goes to listeners.
 *
 * @since  [NEXT_VERSION]
 */
export type RelayMessage =
    | { type: 'pong', id: number, t0: number, ts: number }
    | { type: 'hello', protocol: number, show: ShowState }
    | { type: 'show', show: ShowState }
    | { type: 'sample', sample: MediaSample }

/**
 * Build the public URL path for a media file.
 *
 * @since  [NEXT_VERSION]
 *
 * @param  {MediaRef}  ref  Media reference.
 * @return {string}         Path relative to the relay origin.
 */
export function mediaPath( ref: MediaRef ): string {
    const path = `/media/${ encodeURIComponent( ref.file ) }`

    return ref.version ? `${ path }?v=${ encodeURIComponent( ref.version ) }` : path
}
