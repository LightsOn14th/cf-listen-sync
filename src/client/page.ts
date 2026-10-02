import { ListenSync, type ListenDiagnostics, type ListenStatus } from './index'
import type { ShowState } from '../shared/protocol'

const OFFSET_KEY = 'listen-sync-offset-ms'
const OFFSET_MIN = -500
const OFFSET_MAX = 500

const STATUS_TEXT: Record<ListenStatus, string> = {
    idle: 'Not playing',
    connecting: 'Connecting',
    waiting: 'The show is not playing',
    loading: 'Loading audio',
    playing: 'Playing',
    unavailable: 'Audio for this song is not available',
    error: 'Audio could not be loaded',
}

const $ = <T extends HTMLElement>( id: string ): T => document.getElementById( id ) as T

const toggle = $<HTMLButtonElement>( 'toggle' )
const statusLine = $<HTMLParagraphElement>( 'status' )
const nowPlaying = $<HTMLParagraphElement>( 'now-playing' )
const offsetInput = $<HTMLInputElement>( 'offset' )
const offsetValue = $<HTMLOutputElement>( 'offset-value' )
const offsetDown = $<HTMLButtonElement>( 'offset-down' )
const offsetUp = $<HTMLButtonElement>( 'offset-up' )
const offsetReset = $<HTMLButtonElement>( 'offset-reset' )
const diagnostics = $<HTMLElement>( 'diagnostics-values' )

let player: ListenSync | null = null
let wakeLock: WakeLockSentinel | null = null

/**
 * Read the saved offset, tolerating blocked storage.
 *
 * @since  [NEXT_VERSION]
 *
 * @return {number}
 */
function loadOffset(): number {
    try {
        const saved = Number( localStorage.getItem( OFFSET_KEY ) )

        return Number.isFinite( saved ) ? saved : 0
    } catch {
        return 0
    }
}

/**
 * Save and apply a new offset.
 *
 * @since  [NEXT_VERSION]
 *
 * @param  {number}  ms  Offset in ms.
 * @return {void}
 */
function setOffset( ms: number ): void {
    const clamped = Math.max( OFFSET_MIN, Math.min( OFFSET_MAX, Math.round( ms ) ) )

    offsetInput.value = String( clamped )
    offsetValue.textContent = `${ clamped > 0 ? '+' : '' }${ clamped } ms`
    player?.setOffsetMs( clamped )

    try {
        localStorage.setItem( OFFSET_KEY, String( clamped ) )
    } catch {
        // Storage blocked; the offset still applies for this visit.
    }
}

/**
 * Keep the screen on while playing, where supported.
 *
 * @since  [NEXT_VERSION]
 *
 * @param  {boolean}  on  Whether to hold the lock.
 * @return {Promise<void>}
 */
async function holdWakeLock( on: boolean ): Promise<void> {
    try {
        if ( on && ! wakeLock && 'wakeLock' in navigator ) {
            wakeLock = await navigator.wakeLock.request( 'screen' )
            wakeLock.addEventListener( 'release', () => {
                wakeLock = null
            } )
        } else if ( ! on && wakeLock ) {
            await wakeLock.release()
            wakeLock = null
        }
    } catch {
        // Not allowed right now (e.g. page hidden); try again on the next change.
    }
}

/**
 * Render the show title line.
 *
 * @since  [NEXT_VERSION]
 *
 * @param  {ShowState|null}  show  Show state.
 * @return {void}
 */
function renderShow( show: ShowState | null ): void {
    if ( show?.state === 'playing' && show.current ) {
        nowPlaying.textContent = show.current.file.replace( /\.[^.]+$/, '' ).replace( /[-_]+/g, ' ' )
    } else {
        nowPlaying.textContent = ''
    }
}

/**
 * Render the diagnostics list.
 *
 * @since  [NEXT_VERSION]
 *
 * @param  {ListenDiagnostics}  d  Diagnostics.
 * @return {void}
 */
function renderDiagnostics( d: ListenDiagnostics ): void {
    const ms = ( value: number | null ): string => ( value === null ? '-' : `${ Math.round( value ) } ms` )

    diagnostics.textContent = [
        `Sync error: ${ ms( d.errorMs ) }`,
        `Round trip: ${ ms( d.rttMs ) }`,
        `Clock offset: ${ ms( d.clockOffsetMs ) }`,
        `Output latency: ${ ms( d.outputLatencyMs ) }`,
        `Position: ${ d.position === null ? '-' : d.position.toFixed( 2 ) + ' s' }`,
        `Corrections: ${ d.reschedules }`,
    ].join( '\n' )
}

toggle.addEventListener( 'click', () => {
    if ( player ) {
        player.stop()
        player = null
        toggle.textContent = 'Listen'
        toggle.setAttribute( 'aria-pressed', 'false' )
        statusLine.textContent = STATUS_TEXT.idle
        renderShow( null )
        void holdWakeLock( false )

        return
    }

    player = new ListenSync( {
        relayUrl: window.location.origin,
        offsetMs: Number( offsetInput.value ),
    } )

    player.addEventListener( 'status', ( event ) => {
        const status = ( event as CustomEvent<ListenStatus> ).detail

        statusLine.textContent = STATUS_TEXT[ status ]
        void holdWakeLock( status === 'playing' )
    } )

    player.addEventListener( 'show', ( event ) => {
        renderShow( ( event as CustomEvent<ShowState> ).detail )
    } )

    player.addEventListener( 'diagnostics', ( event ) => {
        renderDiagnostics( ( event as CustomEvent<ListenDiagnostics> ).detail )
    } )

    toggle.textContent = 'Stop'
    toggle.setAttribute( 'aria-pressed', 'true' )

    player.start().catch( ( error ) => {
        console.error( error )
        statusLine.textContent = STATUS_TEXT.error
    } )
} )

offsetInput.addEventListener( 'input', () => setOffset( Number( offsetInput.value ) ) )
offsetDown.addEventListener( 'click', () => setOffset( Number( offsetInput.value ) - 10 ) )
offsetUp.addEventListener( 'click', () => setOffset( Number( offsetInput.value ) + 10 ) )
offsetReset.addEventListener( 'click', () => setOffset( 0 ) )

document.addEventListener( 'visibilitychange', () => {
    if ( document.visibilityState === 'visible' && player?.status === 'playing' ) {
        void holdWakeLock( true )
    }
} )

setOffset( loadOffset() )
statusLine.textContent = STATUS_TEXT.idle
