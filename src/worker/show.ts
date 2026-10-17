import { DurableObject } from 'cloudflare:workers'

import {
    PROTOCOL_VERSION,
    type MediaRef,
    type MediaSample,
    type PlaybackState,
    type PluginMessage,
    type RelayMessage,
    type ShowState,
} from '../shared/protocol'
import {
    SHOW_TIME_ZONE,
    deviceFromUserAgent,
    localDate,
    minuteTimeline,
    sanitizeClientId,
    sessionEnd,
    songStats,
    summarizeDate,
    summarizeDates,
    type PlayRow,
    type SessionRow,
} from './listeners'

const PLUGIN_TAG = 'fpp'
const LISTENER_TAG = 'listener'

// Admin app connections: served like any listener, left out of the counts
// and the analytics.
const ADMIN_TAG = 'admin'

// How often a listener's last-seen time is written while it stays connected.
const LISTENER_TOUCH_MS = 60_000

// Listener analytics older than this are deleted.
const ANALYTICS_RETENTION_MS = 400 * 24 * 60 * 60 * 1000

// How long the plugin may be silent before its socket is treated as dead.
const PLUGIN_SILENCE_MS = 30_000

// How long after losing the plugin a playing show is declared stopped.
// Listeners keep extrapolating the position until then.
const SOURCE_GRACE_MS = 60_000

const MAX_LISTENERS = 5_000
const MAX_MESSAGE_BYTES = 64 * 1024
const MAX_PLAYLIST_ITEMS = 500

interface PersistedShow {
    state: PlaybackState
    currentFile: string | null
    playlist: { name: string, items: string[] } | null
    lostSourceAt: number | null
}

interface PluginAttachment {
    lastSeen: number
}

interface ListenerAttachment {
    sessionId: number | null
    lastWrite: number
}

/**
 * The single show room: one FPP plugin connection feeding any number of
 * listener connections.
 *
 * Uses the WebSocket Hibernation API, so the object can sleep between the
 * plugin's idle heartbeats outside show hours. While a show runs the plugin
 * sends samples every half second and the object stays awake.
 *
 * @since  [NEXT_VERSION]
 */
export class Show extends DurableObject<Env> {
    private state: PlaybackState = 'stopped'
    private currentFile: string | null = null
    private playlist: { name: string, items: string[] } | null = null
    private lostSourceAt: number | null = null
    private sample: MediaSample | null = null
    private versions = new Map<string, string>()

    /**
     * @since  [NEXT_VERSION]
     *
     * @param  {DurableObjectState}  ctx  Object state.
     * @param  {Env}                 env  Worker environment.
     */
    constructor( ctx: DurableObjectState, env: Env ) {
        super( ctx, env )

        ctx.blockConcurrencyWhile( async () => {
            const saved = await ctx.storage.get<PersistedShow>( 'show' )

            if ( saved ) {
                this.state = saved.state
                this.currentFile = saved.currentFile
                this.playlist = saved.playlist
                this.lostSourceAt = saved.lostSourceAt
            }

            const versions = await ctx.storage.get<Record<string, string>>( 'versions' )

            this.versions = new Map( Object.entries( versions ?? {} ) )

            this.setUpAnalytics()
        } )
    }

    /**
     * Create the analytics tables, close sessions left open by a restart, and
     * delete old rows.
     *
     * @since  [NEXT_VERSION]
     */
    private setUpAnalytics(): void {
        const sql = this.ctx.storage.sql

        sql.exec( `CREATE TABLE IF NOT EXISTS listener_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_id TEXT,
            device TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            last_seen INTEGER NOT NULL,
            ended_at INTEGER
        )` )
        sql.exec( 'CREATE INDEX IF NOT EXISTS listener_sessions_started ON listener_sessions ( started_at )' )
        sql.exec( `CREATE TABLE IF NOT EXISTS media_plays (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file TEXT NOT NULL,
            playlist TEXT,
            started_at INTEGER NOT NULL,
            ended_at INTEGER
        )` )
        sql.exec( 'CREATE INDEX IF NOT EXISTS media_plays_started ON media_plays ( started_at )' )

        // Sockets that survived hibernation keep their sessions open.
        const live = new Set(
            this.ctx.getWebSockets( LISTENER_TAG )
                .map( ( ws ) => ( ws.deserializeAttachment() as ListenerAttachment | null )?.sessionId )
                .filter( ( id ): id is number => typeof id === 'number' )
        )
        const open = sql.exec<{ id: number }>( 'SELECT id FROM listener_sessions WHERE ended_at IS NULL' ).toArray()

        for ( const { id } of open ) {
            if ( ! live.has( id ) ) {
                sql.exec( 'UPDATE listener_sessions SET ended_at = last_seen WHERE id = ?', id )
            }
        }

        const cutoff = Date.now() - ANALYTICS_RETENTION_MS

        sql.exec( 'DELETE FROM listener_sessions WHERE started_at < ?', cutoff )
        sql.exec( 'DELETE FROM media_plays WHERE started_at < ?', cutoff )
    }

    /**
     * Accept a WebSocket from the plugin (`/fpp`) or a listener (`/ws`).
     * Authentication happens in the Worker before the request gets here.
     *
     * @since  [NEXT_VERSION]
     *
     * @param  {Request}  request  Upgrade request.
     * @return {Promise<Response>}
     */
    async fetch( request: Request ): Promise<Response> {
        const url = new URL( request.url )
        const isPlugin = url.pathname === '/fpp'

        if ( ! isPlugin && this.ctx.getWebSockets( LISTENER_TAG ).length >= MAX_LISTENERS ) {
            return new Response( 'Too many listeners', { status: 503 } )
        }

        const pair = new WebSocketPair()
        const [ client, server ] = Object.values( pair )

        if ( isPlugin ) {
            for ( const old of this.ctx.getWebSockets( PLUGIN_TAG ) ) {
                this.closeQuietly( old, 1000, 'Replaced by a newer connection' )
            }

            this.ctx.acceptWebSocket( server, [ PLUGIN_TAG ] )
            server.serializeAttachment( { lastSeen: Date.now() } satisfies PluginAttachment )

            this.lostSourceAt = null
            await this.persist()
            await this.ctx.storage.setAlarm( Date.now() + PLUGIN_SILENCE_MS )
        } else if ( url.searchParams.get( 'app' ) === 'admin' ) {
            this.ctx.acceptWebSocket( server, [ LISTENER_TAG, ADMIN_TAG ] )
            server.serializeAttachment( { sessionId: null, lastWrite: Date.now() } satisfies ListenerAttachment )
        } else {
            const now = Date.now()
            const row = this.ctx.storage.sql.exec<{ id: number }>(
                'INSERT INTO listener_sessions ( client_id, device, started_at, last_seen ) VALUES ( ?, ?, ?, ? ) RETURNING id',
                sanitizeClientId( url.searchParams.get( 'cid' ) ),
                deviceFromUserAgent( request.headers.get( 'User-Agent' ) ),
                now,
                now
            ).one()

            this.ctx.acceptWebSocket( server, [ LISTENER_TAG ] )
            server.serializeAttachment( { sessionId: row.id, lastWrite: now } satisfies ListenerAttachment )
        }

        this.send( server, { type: 'hello', protocol: PROTOCOL_VERSION, show: this.snapshot() } )

        if ( isPlugin ) {
            this.broadcast( { type: 'show', show: this.snapshot() } )
        }

        return new Response( null, { status: 101, webSocket: client } )
    }

    /**
     * Handle a message from the plugin or a listener.
     *
     * @since  [NEXT_VERSION]
     *
     * @param  {WebSocket}            ws   Sending socket.
     * @param  {string|ArrayBuffer}  raw  Message payload.
     * @return {Promise<void>}
     */
    async webSocketMessage( ws: WebSocket, raw: string | ArrayBuffer ): Promise<void> {
        // Read the clock first: in a Worker it only advances on I/O, so this is
        // the arrival time of the message, which is what a pong must report.
        const now = Date.now()

        if ( typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES ) {
            return
        }

        let message: PluginMessage

        try {
            message = JSON.parse( raw )
        } catch {
            return
        }

        if ( message?.type === 'ping' ) {
            if ( Number.isFinite( message.t0 ) ) {
                this.send( ws, { type: 'pong', id: Number( message.id ) || 0, t0: message.t0, ts: now } )
            }

            this.touchListener( ws, now )

            return
        }

        if ( ! this.ctx.getTags( ws ).includes( PLUGIN_TAG ) ) {
            return
        }

        ws.serializeAttachment( { lastSeen: now } satisfies PluginAttachment )

        switch ( message.type ) {
            case 'media':
                await this.onMedia( message )
                break

            case 'playlist':
                await this.onPlaylist( message )
                break

            case 'hb':
                await this.ctx.storage.setAlarm( now + PLUGIN_SILENCE_MS )
                break
        }
    }

    /**
     * A socket closed. Losing the plugin marks the source offline but keeps
     * the current state so listeners can carry on until the grace period ends.
     *
     * @since  [NEXT_VERSION]
     *
     * @param  {WebSocket}  ws    Closed socket.
     * @param  {number}     code  Close code.
     * @return {Promise<void>}
     */
    async webSocketClose( ws: WebSocket, code: number ): Promise<void> {
        this.closeQuietly( ws, code === 1005 ? 1000 : code, 'Closed' )

        if ( ! this.ctx.getTags( ws ).includes( PLUGIN_TAG ) ) {
            this.endListener( ws )

            return
        }

        await this.onSourceLost()
    }

    /**
     * Same handling as a close.
     *
     * @since  [NEXT_VERSION]
     *
     * @param  {WebSocket}  ws  Failed socket.
     * @return {Promise<void>}
     */
    async webSocketError( ws: WebSocket ): Promise<void> {
        await this.webSocketClose( ws, 1011 )
    }

    /**
     * Periodic check for a silent plugin socket and for the end of the grace
     * period after losing the source.
     *
     * @since  [NEXT_VERSION]
     *
     * @return {Promise<void>}
     */
    async alarm(): Promise<void> {
        const now = Date.now()

        for ( const ws of this.ctx.getWebSockets( PLUGIN_TAG ) ) {
            const attachment = ws.deserializeAttachment() as PluginAttachment | null

            if ( ! attachment || now - attachment.lastSeen > PLUGIN_SILENCE_MS ) {
                this.closeQuietly( ws, 1001, 'No messages received' )
            }
        }

        if ( this.pluginSockets().length > 0 ) {
            await this.ctx.storage.setAlarm( now + PLUGIN_SILENCE_MS )

            return
        }

        if ( this.lostSourceAt === null ) {
            await this.onSourceLost()

            return
        }

        if ( now - this.lostSourceAt < SOURCE_GRACE_MS ) {
            await this.ctx.storage.setAlarm( this.lostSourceAt + SOURCE_GRACE_MS )

            return
        }

        if ( this.state !== 'stopped' ) {
            this.state = 'stopped'
            this.currentFile = null
            this.sample = null
            this.recordPlay( null )
            await this.persist()
            this.broadcast( { type: 'show', show: this.snapshot() } )
        }
    }

    /**
     * Record a newly uploaded media version. Called by the Worker after an
     * upload completes.
     *
     * @since  [NEXT_VERSION]
     *
     * @param  {string}  file     Media file name.
     * @param  {string}  version  New version string.
     * @return {Promise<void>}
     */
    async mediaUpdated( file: string, version: string ): Promise<void> {
        this.versions.set( file, version )
        await this.ctx.storage.put( 'versions', Object.fromEntries( this.versions ) )

        if ( file === this.currentFile || this.playlist?.items.includes( file ) ) {
            this.broadcast( { type: 'show', show: this.snapshot() } )
        }
    }

    /**
     * Versions of every uploaded media file, keyed by file name.
     *
     * @since  [NEXT_VERSION]
     *
     * @return {Promise<Record<string, string>>}
     */
    async getVersions(): Promise<Record<string, string>> {
        return Object.fromEntries( this.versions )
    }

    /**
     * Current show state, for the HTTP state endpoint.
     *
     * @since  [NEXT_VERSION]
     *
     * @return {Promise<ShowState & { listeners: number }>}
     */
    async getState(): Promise<ShowState & { listeners: number }> {
        return { ...this.snapshot(), listeners: this.publicListenerCount() }
    }

    /**
     * Listeners connected now, and today's figures so far.
     *
     * @since  [NEXT_VERSION]
     */
    async getLiveListeners() {
        const now = Date.now()
        const today = localDate( now )
        const sessions = this.sessionsBetween( now - 36 * 60 * 60 * 1000, now + 1 ).filter( ( session ) => localDate( session.started_at ) === today )
        const open = sessions.filter( ( session ) => session.ended_at === null )

        return {
            at: now,
            listeners: this.publicListenerCount(),
            adminListeners: this.ctx.getWebSockets( ADMIN_TAG ).length,
            current: this.currentFile,
            playlist: this.playlist?.name ?? null,
            sessions: open
                .map( ( session ) => ( { device: session.device, startedAt: session.started_at, durationMs: now - session.started_at } ) )
                .sort( ( a, b ) => a.startedAt - b.startedAt ),
            today: sessions.length > 0 ? summarizeDate( today, sessions, now ) : null,
        }
    }

    /**
     * A summary per show date for the last `days` days, newest first.
     *
     * @since  [NEXT_VERSION]
     */
    async getListenerHistory( days: number ) {
        const now = Date.now()
        const span = Math.min( Math.max( Math.round( days ) || 0, 1 ), 400 ) * 24 * 60 * 60 * 1000

        return { timeZone: SHOW_TIME_ZONE, dates: summarizeDates( this.sessionsBetween( now - span, now + 1 ), now ) }
    }

    /**
     * One show date: summary, listeners per minute, and listeners per song.
     *
     * @since  [NEXT_VERSION]
     */
    async getListenerDate( date: string ) {
        const now = Date.now()
        const midnightUtc = Date.parse( `${ date }T00:00:00Z` )

        if ( ! Number.isFinite( midnightUtc ) ) {
            return null
        }

        // Sessions are grouped by show-local date; widen the query window by a
        // day either side and filter.
        const sessions = this.sessionsBetween( midnightUtc - 86_400_000, midnightUtc + 2 * 86_400_000 )
            .filter( ( session ) => localDate( session.started_at ) === date )

        if ( sessions.length === 0 ) {
            return null
        }

        const summary = summarizeDate( date, sessions, now )
        const plays = this.ctx.storage.sql.exec<PlayRow>(
            'SELECT file, playlist, started_at, ended_at FROM media_plays WHERE started_at < ? AND COALESCE( ended_at, ? ) > ? ORDER BY started_at',
            summary.lastAt,
            now,
            summary.firstAt
        ).toArray()

        return {
            summary,
            timeline: minuteTimeline( sessions, summary.firstAt, summary.lastAt, now ),
            songs: songStats( plays, sessions, now ),
            durations: sessions.map( ( session ) => sessionEnd( session, now ) - session.started_at ),
        }
    }

    private publicListenerCount(): number {
        return this.ctx.getWebSockets( LISTENER_TAG ).length - this.ctx.getWebSockets( ADMIN_TAG ).length
    }

    private sessionsBetween( from: number, to: number ): SessionRow[] {
        return this.ctx.storage.sql.exec<SessionRow>(
            'SELECT id, client_id, device, started_at, last_seen, ended_at FROM listener_sessions WHERE started_at >= ? AND started_at < ? ORDER BY started_at',
            from,
            to
        ).toArray()
    }

    /**
     * Keep an open session's last-seen time current, at most once a minute,
     * so a session cut off by a restart ends close to when it really did.
     *
     * @since  [NEXT_VERSION]
     */
    private touchListener( ws: WebSocket, now: number ): void {
        const attachment = ws.deserializeAttachment() as ListenerAttachment | null

        if ( ! attachment?.sessionId || now - attachment.lastWrite < LISTENER_TOUCH_MS ) {
            return
        }

        this.ctx.storage.sql.exec( 'UPDATE listener_sessions SET last_seen = ? WHERE id = ?', now, attachment.sessionId )
        ws.serializeAttachment( { ...attachment, lastWrite: now } satisfies ListenerAttachment )
    }

    private endListener( ws: WebSocket ): void {
        const attachment = ws.deserializeAttachment() as ListenerAttachment | null

        if ( ! attachment?.sessionId ) {
            return
        }

        const now = Date.now()

        this.ctx.storage.sql.exec( 'UPDATE listener_sessions SET ended_at = ?, last_seen = ? WHERE id = ? AND ended_at IS NULL', now, now, attachment.sessionId )
    }

    /**
     * Close the open song play and start a new one when a file is playing.
     *
     * @since  [NEXT_VERSION]
     */
    private recordPlay( file: string | null ): void {
        const now = Date.now()
        const sql = this.ctx.storage.sql

        sql.exec( 'UPDATE media_plays SET ended_at = ? WHERE ended_at IS NULL', now )

        if ( file ) {
            sql.exec( 'INSERT INTO media_plays ( file, playlist, started_at ) VALUES ( ?, ?, ? )', file, this.playlist?.name ?? null, now )
        }
    }

    private async onMedia( message: Extract<PluginMessage, { type: 'media' }> ): Promise<void> {
        const state: PlaybackState = message.state === 'playing' ? 'playing' : 'stopped'
        const file = typeof message.file === 'string' ? message.file.slice( 0, 255 ) : ''

        if ( state === 'playing' && ( ! file || ! Number.isFinite( message.pos ) || ! Number.isFinite( message.at ) ) ) {
            return
        }

        const nextFile = state === 'playing' ? file : null
        const changed = state !== this.state || nextFile !== this.currentFile

        if ( nextFile !== this.currentFile ) {
            this.recordPlay( nextFile )
        }

        this.state = state
        this.currentFile = nextFile
        this.sample = nextFile ? { file: nextFile, pos: message.pos, at: message.at } : null

        if ( changed ) {
            await this.persist()
            this.broadcast( { type: 'show', show: this.snapshot() } )

            return
        }

        if ( this.sample ) {
            this.broadcast( { type: 'sample', sample: this.sample } )
        }
    }

    private async onPlaylist( message: Extract<PluginMessage, { type: 'playlist' }> ): Promise<void> {
        if ( ! Array.isArray( message.items ) ) {
            return
        }

        const items = message.items
            .filter( ( item ): item is string => typeof item === 'string' && item.length > 0 )
            .slice( 0, MAX_PLAYLIST_ITEMS )

        this.playlist = { name: String( message.name ?? '' ).slice( 0, 255 ), items }
        await this.persist()
        this.broadcast( { type: 'show', show: this.snapshot() } )
    }

    private async onSourceLost(): Promise<void> {
        if ( this.pluginSockets().length > 0 ) {
            return
        }

        this.lostSourceAt = Date.now()
        await this.persist()
        await this.ctx.storage.setAlarm( this.lostSourceAt + SOURCE_GRACE_MS )
        this.broadcast( { type: 'show', show: this.snapshot() } )
    }

    private pluginSockets(): WebSocket[] {
        return this.ctx.getWebSockets( PLUGIN_TAG ).filter( ( ws ) => ws.readyState === WebSocket.OPEN )
    }

    private snapshot(): ShowState {
        return {
            source: this.pluginSockets().length > 0 ? 'online' : 'offline',
            state: this.state,
            current: this.currentFile ? this.ref( this.currentFile ) : null,
            playlist: this.playlist
                ? { name: this.playlist.name, items: this.playlist.items.map( ( item ) => this.ref( item ) ) }
                : null,
            sample: this.sample,
        }
    }

    private ref( file: string ): MediaRef {
        return { file, version: this.versions.get( file ) ?? null }
    }

    private async persist(): Promise<void> {
        await this.ctx.storage.put( 'show', {
            state: this.state,
            currentFile: this.currentFile,
            playlist: this.playlist,
            lostSourceAt: this.lostSourceAt,
        } satisfies PersistedShow )
    }

    private broadcast( message: RelayMessage ): void {
        const payload = JSON.stringify( message )

        for ( const ws of this.ctx.getWebSockets( LISTENER_TAG ) ) {
            try {
                ws.send( payload )
            } catch {
                // The socket is closing; its close handler cleans up.
            }
        }
    }

    private send( ws: WebSocket, message: RelayMessage ): void {
        try {
            ws.send( JSON.stringify( message ) )
        } catch {
            // The socket is closing; its close handler cleans up.
        }
    }

    private closeQuietly( ws: WebSocket, code: number, reason: string ): void {
        try {
            ws.close( code, reason )
        } catch {
            // Already closed.
        }
    }
}
