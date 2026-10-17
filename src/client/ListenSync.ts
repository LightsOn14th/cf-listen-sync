import { ClockSync } from '../shared/clock'
import { mediaPath, type MediaRef, type RelayMessage, type ShowState } from '../shared/protocol'

import { PositionTracker } from './position'

/**
 * Player status, as shown to the listener.
 *
 * @since  [NEXT_VERSION]
 */
export type ListenStatus =
    | 'idle'
    | 'connecting'
    | 'waiting'
    | 'loading'
    | 'playing'
    | 'unavailable'
    | 'error'

/**
 * @since  [NEXT_VERSION]
 */
export interface ListenSyncOptions {
    /** Relay origin, e.g. `https://listen.lightson14th.com`. */
    relayUrl: string
    /** Listener offset in ms. Positive values play later. */
    offsetMs?: number
    /** Scheduling lead in ms between deciding and the sound starting. */
    leadMs?: number
    /** Sustained error in ms that triggers a reschedule. */
    maxErrorMs?: number
    /** Title for the lock screen / media controls. */
    titleFor?: ( ref: MediaRef ) => string
    /**
     * Connecting app. `admin` connections are left out of the listener count
     * and the listener analytics.
     */
    app?: 'listen' | 'admin'
}

const CLIENT_ID_KEY = 'listen-sync-client-id'

/**
 * Anonymous random id kept in this browser, so listener analytics can count
 * returning listeners and reconnects once. Not linked to anything else.
 *
 * @since  [NEXT_VERSION]
 *
 * @return {string|null}
 */
const getClientId = (): string | null => {
    try {
        let id = localStorage.getItem( CLIENT_ID_KEY )

        if ( ! id ) {
            id = crypto.randomUUID()
            localStorage.setItem( CLIENT_ID_KEY, id )
        }

        return id
    } catch {
        return null
    }
}

/**
 * Live numbers for a diagnostics readout.
 *
 * @since  [NEXT_VERSION]
 */
export interface ListenDiagnostics {
    clockOffsetMs: number | null
    rttMs: number | null
    errorMs: number | null
    outputLatencyMs: number | null
    position: number | null
    file: string | null
    reschedules: number
}

interface Playing {
    key: string
    source: AudioBufferSourceNode
    gain: GainNode
    startContextTime: number
    startOffset: number
    duration: number
}

interface CacheEntry {
    bytes: Promise<ArrayBuffer> | null
    buffer: Promise<AudioBuffer> | null
}

const PING_BURST = 8
const PING_BURST_SPACING_MS = 120
const PING_INTERVAL_MS = 5_000
const CHECK_INTERVAL_MS = 250
const HARD_ERROR_S = 0.08
const ERROR_STREAK = 3
const FADE_S = 0.015
const DECODE_AHEAD_S = 30
const RECONNECT_MAX_MS = 10_000

/**
 * Plays the show audio in sync with FPP.
 *
 * The relay sends position samples stamped on its own clock. This class keeps
 * an estimate of the offset between `performance.now()` and the relay clock,
 * converts the target position to AudioContext time through
 * `getOutputTimestamp()` (which accounts for the device output latency where
 * the browser reports it), and starts an AudioBufferSourceNode at exactly that
 * point. A periodic check compares what is being heard with what should be
 * heard and reschedules, with a short crossfade, when they disagree.
 *
 * `start()` must be called from a user gesture (tap or click).
 *
 * @since  [NEXT_VERSION]
 */
export class ListenSync extends EventTarget {
    private readonly relayUrl: string
    private readonly app: 'listen' | 'admin'
    private readonly leadMs: number
    private readonly maxErrorS: number
    private readonly titleFor: ( ref: MediaRef ) => string

    private offsetMs: number
    private running = false
    private context: AudioContext | null = null
    private master: GainNode | null = null
    private socket: WebSocket | null = null
    private reconnectAttempt = 0
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null
    private pingTimer: ReturnType<typeof setInterval> | null = null
    private checkTimer: ReturnType<typeof setInterval> | null = null
    private pingId = 0

    private readonly clock = new ClockSync()
    private readonly tracker = new PositionTracker()
    private readonly cache = new Map<string, CacheEntry>()

    private showState: ShowState | null = null
    private playing: Playing | null = null
    private wantedKey: string | null = null
    private errorStreak = 0
    private currentStatus: ListenStatus = 'idle'
    private diag: ListenDiagnostics = {
        clockOffsetMs: null,
        rttMs: null,
        errorMs: null,
        outputLatencyMs: null,
        position: null,
        file: null,
        reschedules: 0,
    }

    /**
     * @since  [NEXT_VERSION]
     *
     * @param  {ListenSyncOptions}  options  Player options.
     */
    constructor( options: ListenSyncOptions ) {
        super()

        this.relayUrl = options.relayUrl.replace( /\/+$/, '' )
        this.app = options.app ?? 'listen'
        this.offsetMs = options.offsetMs ?? 0
        this.leadMs = options.leadMs ?? 60
        this.maxErrorS = ( options.maxErrorMs ?? 20 ) / 1000
        this.titleFor = options.titleFor ?? ( ( ref ) => ref.file.replace( /\.[^.]+$/, '' ).replace( /[-_]+/g, ' ' ) )

        this.onVisibilityChange = this.onVisibilityChange.bind( this )
    }

    /**
     * Current status.
     *
     * @since  [NEXT_VERSION]
     *
     * @return {ListenStatus}
     */
    get status(): ListenStatus {
        return this.currentStatus
    }

    /**
     * Last show state received from the relay.
     *
     * @since  [NEXT_VERSION]
     *
     * @return {ShowState|null}
     */
    get show(): ShowState | null {
        return this.showState
    }

    /**
     * Latest diagnostics.
     *
     * @since  [NEXT_VERSION]
     *
     * @return {ListenDiagnostics}
     */
    get diagnostics(): ListenDiagnostics {
        return { ...this.diag }
    }

    /**
     * Start listening. Call from a tap or click handler: browsers only allow
     * audio to start from a user gesture, and iOS requires the AudioContext to
     * be created and resumed inside it.
     *
     * @since  [NEXT_VERSION]
     *
     * @return {Promise<void>}
     */
    async start(): Promise<void> {
        if ( this.running ) {
            return
        }

        this.running = true

        const audioSession = ( navigator as Navigator & { audioSession?: { type: string } } ).audioSession

        if ( audioSession ) {
            // Play through the ringer/silent switch on iOS, like a media app.
            audioSession.type = 'playback'
        }

        const context = new AudioContext()
        const master = context.createGain()

        master.connect( context.destination )
        this.context = context
        this.master = master

        // Unlock output on iOS with a one-sample silent buffer inside the gesture.
        const unlock = context.createBufferSource()

        unlock.buffer = context.createBuffer( 1, 1, context.sampleRate )
        unlock.connect( context.destination )
        unlock.start()

        const resumed = context.resume()

        document.addEventListener( 'visibilitychange', this.onVisibilityChange )
        this.checkTimer = setInterval( () => this.check(), CHECK_INTERVAL_MS )
        this.setStatus( 'connecting' )
        this.connect()

        await resumed
    }

    /**
     * Stop listening and release audio resources.
     *
     * @since  [NEXT_VERSION]
     *
     * @return {void}
     */
    stop(): void {
        if ( ! this.running ) {
            return
        }

        this.running = false

        document.removeEventListener( 'visibilitychange', this.onVisibilityChange )
        this.clearTimers()

        if ( this.socket ) {
            this.socket.onclose = null
            this.socket.close()
            this.socket = null
        }

        this.stopPlayback( false )
        this.cache.clear()
        this.tracker.reset()
        this.clock.reset()
        this.wantedKey = null

        void this.context?.close()
        this.context = null
        this.master = null

        if ( 'mediaSession' in navigator ) {
            navigator.mediaSession.playbackState = 'none'
        }

        this.setStatus( 'idle' )
    }

    /**
     * Change the listener offset. Positive values play later, which helps
     * when the phone is ahead of the lights (e.g. Bluetooth speakers report
     * less latency than they add).
     *
     * @since  [NEXT_VERSION]
     *
     * @param  {number}  ms  Offset in ms.
     * @return {void}
     */
    setOffsetMs( ms: number ): void {
        if ( ! Number.isFinite( ms ) ) {
            return
        }

        this.offsetMs = ms

        if ( this.playing ) {
            this.reschedule()
        }
    }

    private connect(): void {
        const params = new URLSearchParams()
        const clientId = getClientId()

        if ( this.app === 'admin' ) {
            params.set( 'app', 'admin' )
        } else if ( clientId ) {
            params.set( 'cid', clientId )
        }

        const query = params.toString()
        const url = this.relayUrl.replace( /^http/, 'ws' ) + '/ws' + ( query ? `?${ query }` : '' )
        const socket = new WebSocket( url )

        this.socket = socket

        socket.onopen = () => {
            this.reconnectAttempt = 0
            this.clock.reset()
            this.pingBurst()
            this.pingTimer = setInterval( () => this.ping(), PING_INTERVAL_MS )
        }

        socket.onmessage = ( event ) => {
            if ( typeof event.data !== 'string' ) {
                return
            }

            try {
                this.onMessage( JSON.parse( event.data ) as RelayMessage )
            } catch ( error ) {
                console.error( 'listen-sync: bad message', error )
            }
        }

        socket.onclose = () => {
            if ( this.pingTimer ) {
                clearInterval( this.pingTimer )
                this.pingTimer = null
            }

            this.socket = null

            if ( ! this.running ) {
                return
            }

            if ( ! this.playing ) {
                this.setStatus( 'connecting' )
            }

            const delay = Math.min( RECONNECT_MAX_MS, 1000 * 2 ** this.reconnectAttempt )

            this.reconnectAttempt++
            this.reconnectTimer = setTimeout( () => this.connect(), delay )
        }
    }

    private onMessage( message: RelayMessage ): void {
        switch ( message.type ) {
            case 'pong':
                this.clock.add( message.t0, message.ts, performance.now() )
                this.diag.clockOffsetMs = this.clock.offset
                this.diag.rttMs = this.clock.rtt
                break

            case 'hello':
            case 'show':
                this.showState = message.show
                this.dispatchEvent( new CustomEvent( 'show', { detail: message.show } ) )
                this.applyShow()
                break

            case 'sample':
                if ( this.tracker.add( message.sample ) && this.playing ) {
                    this.reschedule()
                }

                break
        }
    }

    private applyShow(): void {
        const show = this.showState

        if ( ! show || show.state !== 'playing' || ! show.current ) {
            this.tracker.reset()
            this.wantedKey = null
            this.stopPlayback( true )
            this.setStatus( 'waiting' )

            return
        }

        if ( show.sample && show.sample.file === show.current.file ) {
            this.tracker.add( show.sample )
        }

        const current = show.current

        this.updateMediaSession( current )
        this.prefetchNext( current )

        if ( ! current.version ) {
            this.wantedKey = null
            this.stopPlayback( true )
            this.setStatus( 'unavailable' )

            return
        }

        const key = this.keyFor( current )

        if ( this.playing?.key === key ) {
            return
        }

        this.wantedKey = key

        if ( ! this.playing ) {
            this.setStatus( 'loading' )
        }

        this.decode( current )
            .then( ( buffer ) => {
                if ( this.wantedKey !== key || ! this.running ) {
                    return
                }

                this.schedule( key, buffer )
                this.pruneCache()
            } )
            .catch( ( error ) => {
                console.error( 'listen-sync: could not load audio', error )

                if ( this.wantedKey === key ) {
                    this.cache.delete( key )
                    this.stopPlayback( true )
                    this.setStatus( 'error' )
                }
            } )
    }

    private schedule( key: string, buffer: AudioBuffer ): void {
        const context = this.context
        const master = this.master

        if ( ! context || ! master || ! this.clock.ready ) {
            // The first pong has not arrived yet; check() retries.
            return
        }

        const at = performance.now() + this.leadMs
        const position = this.expectedPosition( at )

        if ( position === null || position >= buffer.duration ) {
            return
        }

        const when = this.contextTimeAt( at )
        const startContextTime = position < 0 ? when - position : when
        const startOffset = Math.max( 0, position )
        const source = context.createBufferSource()
        const gain = context.createGain()

        source.buffer = buffer
        source.connect( gain )
        gain.connect( master )

        const previous = this.playing

        if ( previous ) {
            // Short crossfade so a correction does not click.
            gain.gain.setValueAtTime( 0, startContextTime )
            gain.gain.linearRampToValueAtTime( 1, startContextTime + FADE_S )
            this.fadeOut( previous, startContextTime )
        }

        source.start( Math.max( startContextTime, context.currentTime ), startOffset )
        source.onended = () => {
            if ( this.playing?.source === source ) {
                this.playing = null
            }
        }

        this.playing = {
            key,
            source,
            gain,
            startContextTime,
            startOffset,
            duration: buffer.duration,
        }
        this.errorStreak = 0

        if ( 'mediaSession' in navigator ) {
            navigator.mediaSession.playbackState = 'playing'
        }

        this.setStatus( 'playing' )
    }

    private reschedule(): void {
        if ( ! this.playing ) {
            return
        }

        const key = this.playing.key
        const buffer = this.playing.source.buffer

        if ( buffer ) {
            this.diag.reschedules++
            this.schedule( key, buffer )
        }
    }

    private check(): void {
        if ( ! this.running || ! this.context ) {
            return
        }

        this.diag.outputLatencyMs = Math.round( ( this.context.outputLatency || this.context.baseLatency || 0 ) * 1000 )
        this.diag.file = this.tracker.currentFile

        // Retry a schedule that was waiting on the clock.
        if ( ! this.playing && this.wantedKey && this.clock.ready ) {
            const entry = this.cache.get( this.wantedKey )
            const key = this.wantedKey

            entry?.buffer?.then( ( buffer ) => {
                if ( this.wantedKey === key && ! this.playing ) {
                    this.schedule( key, buffer )
                }
            } ).catch( () => {} )
        }

        const playing = this.playing

        if ( ! playing ) {
            this.diag.errorMs = null
            this.diag.position = null
            this.emitDiagnostics()

            return
        }

        const now = performance.now()
        const heardContextTime = this.contextTimeAt( now )
        const expected = this.expectedPosition( now )

        if ( heardContextTime < playing.startContextTime || expected === null ) {
            this.emitDiagnostics()

            return
        }

        const heard = heardContextTime - playing.startContextTime + playing.startOffset
        const error = heard - expected

        this.diag.errorMs = Math.round( error * 1000 )
        this.diag.position = heard

        if ( Math.abs( error ) > HARD_ERROR_S ) {
            this.reschedule()
        } else if ( Math.abs( error ) > this.maxErrorS ) {
            this.errorStreak++

            if ( this.errorStreak >= ERROR_STREAK ) {
                this.reschedule()
            }
        } else {
            this.errorStreak = 0
        }

        if ( playing.duration - heard < DECODE_AHEAD_S ) {
            const next = this.nextRef()

            if ( next?.version ) {
                this.decode( next ).catch( () => {} )
            }
        }

        this.emitDiagnostics()
    }

    /**
     * Song position that should be heard at a local `performance.now()` time.
     */
    private expectedPosition( localMs: number ): number | null {
        return this.tracker.positionAt( this.clock.toRelay( localMs ) - this.offsetMs )
    }

    /**
     * AudioContext time that is heard at a local `performance.now()` time.
     *
     * `getOutputTimestamp()` pairs the context time leaving the speaker with
     * the performance time it does so, which folds the output latency in. Older
     * browsers fall back to `currentTime` minus the reported latency.
     */
    private contextTimeAt( localMs: number ): number {
        const context = this.context

        if ( ! context ) {
            return 0
        }

        const stamp = typeof context.getOutputTimestamp === 'function' ? context.getOutputTimestamp() : null

        if ( stamp && stamp.contextTime !== undefined && stamp.performanceTime && stamp.contextTime > 0 ) {
            return stamp.contextTime + ( localMs - stamp.performanceTime ) / 1000
        }

        const latency = context.outputLatency || context.baseLatency || 0

        return context.currentTime - latency + ( localMs - performance.now() ) / 1000
    }

    private fadeOut( playing: Playing, at: number ): void {
        const context = this.context

        if ( ! context ) {
            return
        }

        const from = Math.max( at, context.currentTime )

        try {
            playing.gain.gain.cancelScheduledValues( from )
            playing.gain.gain.setValueAtTime( 1, from )
            playing.gain.gain.linearRampToValueAtTime( 0, from + FADE_S )
            playing.source.stop( from + FADE_S + 0.005 )
        } catch {
            // Already stopped.
        }
    }

    private stopPlayback( fade: boolean ): void {
        const playing = this.playing

        this.playing = null

        if ( ! playing ) {
            return
        }

        if ( fade && this.context ) {
            this.fadeOut( playing, this.context.currentTime )
        } else {
            try {
                playing.source.stop()
            } catch {
                // Already stopped.
            }
        }

        if ( 'mediaSession' in navigator ) {
            navigator.mediaSession.playbackState = 'paused'
        }
    }

    private decode( ref: MediaRef ): Promise<AudioBuffer> {
        const key = this.keyFor( ref )
        const entry = this.entryFor( ref )

        if ( entry.buffer ) {
            return entry.buffer
        }

        const context = this.context

        if ( ! context ) {
            return Promise.reject( new Error( 'Not started' ) )
        }

        const bytes = entry.bytes ?? this.fetchBytes( ref )

        entry.buffer = bytes.then( ( data ) => context.decodeAudioData( data ) )
        // Decoding detaches the bytes; only the decoded buffer is kept.
        entry.bytes = null
        this.cache.set( key, entry )

        return entry.buffer
    }

    private prefetchNext( current: MediaRef ): void {
        const next = this.nextRef( current )

        if ( ! next?.version ) {
            return
        }

        const entry = this.entryFor( next )

        if ( ! entry.bytes && ! entry.buffer ) {
            entry.bytes = this.fetchBytes( next )
            entry.bytes.catch( () => {
                this.cache.delete( this.keyFor( next ) )
            } )
        }
    }

    private nextRef( current: MediaRef | null = this.showState?.current ?? null ): MediaRef | null {
        const items = this.showState?.playlist?.items

        if ( ! current || ! items || items.length === 0 ) {
            return null
        }

        const index = items.findIndex( ( item ) => item.file === current.file )

        if ( index === -1 ) {
            return null
        }

        return items[ ( index + 1 ) % items.length ]
    }

    private async fetchBytes( ref: MediaRef ): Promise<ArrayBuffer> {
        const response = await fetch( this.relayUrl + mediaPath( ref ) )

        if ( ! response.ok ) {
            throw new Error( `Media request failed with ${ response.status }` )
        }

        return response.arrayBuffer()
    }

    private entryFor( ref: MediaRef ): CacheEntry {
        const key = this.keyFor( ref )
        let entry = this.cache.get( key )

        if ( ! entry ) {
            entry = { bytes: null, buffer: null }
            this.cache.set( key, entry )
        }

        return entry
    }

    private pruneCache(): void {
        // Decoded songs are large (about 20 MB per minute of stereo audio), so
        // keep only the current song and the next one.
        const keep = new Set<string>()
        const current = this.showState?.current
        const next = this.nextRef()

        if ( current ) {
            keep.add( this.keyFor( current ) )
        }

        if ( next ) {
            keep.add( this.keyFor( next ) )
        }

        for ( const key of this.cache.keys() ) {
            if ( ! keep.has( key ) ) {
                this.cache.delete( key )
            }
        }
    }

    private keyFor( ref: MediaRef ): string {
        return `${ ref.file }|${ ref.version ?? '' }`
    }

    private pingBurst(): void {
        for ( let i = 0; i < PING_BURST; i++ ) {
            setTimeout( () => this.ping(), i * PING_BURST_SPACING_MS )
        }
    }

    private ping(): void {
        if ( this.socket?.readyState !== WebSocket.OPEN ) {
            return
        }

        this.socket.send( JSON.stringify( { type: 'ping', id: ++this.pingId, t0: performance.now() } ) )
    }

    private onVisibilityChange(): void {
        if ( document.visibilityState !== 'visible' || ! this.running ) {
            return
        }

        // Timers and audio may have been throttled in the background.
        void this.context?.resume()
        this.pingBurst()

        if ( this.playing ) {
            this.reschedule()
        } else {
            this.applyShow()
        }
    }

    private updateMediaSession( ref: MediaRef ): void {
        if ( ! ( 'mediaSession' in navigator ) || typeof MediaMetadata === 'undefined' ) {
            return
        }

        navigator.mediaSession.metadata = new MediaMetadata( {
            title: this.titleFor( ref ),
            artist: 'Lights On 14th',
        } )
    }

    private setStatus( status: ListenStatus ): void {
        if ( status === this.currentStatus ) {
            return
        }

        this.currentStatus = status
        this.dispatchEvent( new CustomEvent( 'status', { detail: status } ) )
    }

    private emitDiagnostics(): void {
        this.dispatchEvent( new CustomEvent( 'diagnostics', { detail: this.diagnostics } ) )
    }

    private clearTimers(): void {
        for ( const timer of [ this.pingTimer, this.checkTimer ] ) {
            if ( timer ) {
                clearInterval( timer )
            }
        }

        if ( this.reconnectTimer ) {
            clearTimeout( this.reconnectTimer )
        }

        this.pingTimer = null
        this.checkTimer = null
        this.reconnectTimer = null
    }
}
