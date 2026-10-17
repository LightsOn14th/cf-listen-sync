/**
 * Listener analytics: pure helpers over stored sessions and song plays.
 * Sessions are anonymous: a random id the browser keeps, a coarse device
 * class, and start / end times. No IP address or user agent is stored.
 */

export const SHOW_TIME_ZONE = 'America/New_York'

export type Device = 'iPhone' | 'iPad' | 'Android' | 'Mac' | 'Windows' | 'Other'

export type SessionRow = {
    id: number
    client_id: string | null
    device: string
    started_at: number
    last_seen: number
    ended_at: number | null
}

export type PlayRow = {
    file: string
    playlist: string | null
    started_at: number
    ended_at: number | null
}

export interface DateSummary {
    date: string
    sessions: number
    uniqueListeners: number
    peak: number
    peakAt: number | null
    totalListeningMs: number
    avgSessionMs: number
    medianSessionMs: number
    firstAt: number
    lastAt: number
    devices: Record<string, number>
}

/**
 * Coarse device class from a User-Agent header. Only this class is stored.
 *
 * @since  [NEXT_VERSION]
 *
 * @param  {string|null}  userAgent  User-Agent header.
 * @return {Device}
 */
export const deviceFromUserAgent = ( userAgent: string | null ): Device => {
    const ua = userAgent ?? ''

    if ( /iPhone|iPod/.test( ua ) ) {
        return 'iPhone'
    }

    if ( /iPad/.test( ua ) ) {
        return 'iPad'
    }

    if ( /Android/.test( ua ) ) {
        return 'Android'
    }

    if ( /Macintosh/.test( ua ) ) {
        return 'Mac'
    }

    if ( /Windows/.test( ua ) ) {
        return 'Windows'
    }

    return 'Other'
}

/**
 * Accept only an anonymous random id (UUID-like), never free text.
 *
 * @since  [NEXT_VERSION]
 *
 * @param  {string|null}  value  `cid` query parameter.
 * @return {string|null}
 */
export const sanitizeClientId = ( value: string | null ): string | null => {
    return value && /^[A-Za-z0-9-]{8,64}$/.test( value ) ? value : null
}

const dateFormatter = new Intl.DateTimeFormat( 'en-CA', {
    timeZone: SHOW_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
} )

/**
 * Show-local calendar date (YYYY-MM-DD) of a timestamp.
 *
 * @since  [NEXT_VERSION]
 *
 * @param  {number}  ms  Epoch milliseconds.
 * @return {string}
 */
export const localDate = ( ms: number ): string => dateFormatter.format( new Date( ms ) )

/**
 * End of a session: its close time, or `now` while it is still open.
 *
 * @since  [NEXT_VERSION]
 */
export const sessionEnd = ( session: SessionRow, now: number ): number => session.ended_at ?? Math.max( session.last_seen, now )

/**
 * Highest number of sessions open at once, and when it first happened.
 *
 * @since  [NEXT_VERSION]
 *
 * @param  {SessionRow[]}  sessions  Sessions.
 * @param  {number}        now       Current time, for open sessions.
 * @return {{ peak: number, peakAt: number|null }}
 */
export const peakConcurrent = ( sessions: SessionRow[], now: number ): { peak: number, peakAt: number | null } => {
    const events: [ number, number ][] = []

    for ( const session of sessions ) {
        events.push( [ session.started_at, 1 ], [ sessionEnd( session, now ), -1 ] )
    }

    // Ends before starts at the same instant, so a reconnect is not double counted.
    events.sort( ( a, b ) => a[0] - b[0] || a[1] - b[1] )

    let current = 0
    let peak = 0
    let peakAt: number | null = null

    for ( const [ at, delta ] of events ) {
        current += delta

        if ( current > peak ) {
            peak = current
            peakAt = at
        }
    }

    return { peak, peakAt }
}

const median = ( values: number[] ): number => {
    if ( values.length === 0 ) {
        return 0
    }

    const sorted = [ ...values ].sort( ( a, b ) => a - b )
    const middle = Math.floor( sorted.length / 2 )

    return sorted.length % 2 ? sorted[ middle ] : Math.round( ( sorted[ middle - 1 ] + sorted[ middle ] ) / 2 )
}

/**
 * Summary of one show date.
 *
 * @since  [NEXT_VERSION]
 *
 * @param  {string}        date      Show-local date.
 * @param  {SessionRow[]}  sessions  Sessions that started on that date.
 * @param  {number}        now       Current time, for open sessions.
 * @return {DateSummary}
 */
export const summarizeDate = ( date: string, sessions: SessionRow[], now: number ): DateSummary => {
    const durations = sessions.map( ( session ) => Math.max( 0, sessionEnd( session, now ) - session.started_at ) )
    const total = durations.reduce( ( sum, value ) => sum + value, 0 )
    const listeners = new Set( sessions.map( ( session ) => session.client_id ?? `session-${ session.id }` ) )
    const devices: Record<string, number> = {}

    for ( const session of sessions ) {
        devices[ session.device ] = ( devices[ session.device ] ?? 0 ) + 1
    }

    const { peak, peakAt } = peakConcurrent( sessions, now )

    return {
        date,
        sessions: sessions.length,
        uniqueListeners: listeners.size,
        peak,
        peakAt,
        totalListeningMs: total,
        avgSessionMs: sessions.length > 0 ? Math.round( total / sessions.length ) : 0,
        medianSessionMs: median( durations ),
        firstAt: Math.min( ...sessions.map( ( session ) => session.started_at ) ),
        lastAt: Math.max( ...sessions.map( ( session ) => sessionEnd( session, now ) ) ),
        devices,
    }
}

/**
 * Group sessions by show-local start date, newest first.
 *
 * @since  [NEXT_VERSION]
 */
export const summarizeDates = ( sessions: SessionRow[], now: number ): DateSummary[] => {
    const byDate = new Map<string, SessionRow[]>()

    for ( const session of sessions ) {
        const date = localDate( session.started_at )
        const list = byDate.get( date ) ?? []

        list.push( session )
        byDate.set( date, list )
    }

    return [ ...byDate.entries() ]
        .map( ( [ date, list ] ) => summarizeDate( date, list, now ) )
        .sort( ( a, b ) => b.date.localeCompare( a.date ) )
}

/**
 * Listeners connected at each minute between two times.
 *
 * @since  [NEXT_VERSION]
 *
 * @return {{ at: number, listeners: number }[]}
 */
export const minuteTimeline = ( sessions: SessionRow[], from: number, to: number, now: number ): { at: number, listeners: number }[] => {
    const points: { at: number, listeners: number }[] = []
    const start = Math.floor( from / 60_000 ) * 60_000

    for ( let at = start; at <= to; at += 60_000 ) {
        const end = at + 60_000
        const listeners = sessions.filter( ( session ) => session.started_at < end && sessionEnd( session, now ) > at ).length

        points.push( { at, listeners } )
    }

    return points
}

/**
 * Listener figures for each song played: listeners at the start, the most at
 * once, and the average over the song.
 *
 * @since  [NEXT_VERSION]
 */
export const songStats = ( plays: PlayRow[], sessions: SessionRow[], now: number ) => {
    return plays.map( ( play ) => {
        const playEnd = play.ended_at ?? now
        const overlapping = sessions.filter( ( session ) => session.started_at < playEnd && sessionEnd( session, now ) > play.started_at )
        const clipped = overlapping.map( ( session ) => ( {
            ...session,
            started_at: Math.max( session.started_at, play.started_at ),
            ended_at: Math.min( sessionEnd( session, now ), playEnd ),
        } ) )
        const duration = Math.max( 1, playEnd - play.started_at )
        const listenedMs = clipped.reduce( ( sum, session ) => sum + ( ( session.ended_at as number ) - session.started_at ), 0 )

        return {
            file: play.file,
            playlist: play.playlist,
            startedAt: play.started_at,
            endedAt: play.ended_at,
            listenersAtStart: overlapping.filter( ( session ) => session.started_at <= play.started_at ).length,
            peakListeners: peakConcurrent( clipped, now ).peak,
            avgListeners: Math.round( ( listenedMs / duration ) * 10 ) / 10,
        }
    } )
}
