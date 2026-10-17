import { describe, expect, it } from 'vitest'

import {
    deviceFromUserAgent,
    localDate,
    minuteTimeline,
    peakConcurrent,
    sanitizeClientId,
    songStats,
    summarizeDate,
    summarizeDates,
    type SessionRow,
} from '../src/worker/listeners'

// 2026-10-17 19:00 EDT = 23:00 UTC.
const SHOW = Date.UTC( 2026, 9, 17, 23, 0, 0 )
const MIN = 60_000

let nextId = 1

const session = ( startMin: number, endMin: number | null, clientId: string | null = null, device = 'iPhone' ): SessionRow => ( {
    id: nextId++,
    client_id: clientId,
    device,
    started_at: SHOW + startMin * MIN,
    last_seen: SHOW + ( endMin ?? startMin ) * MIN,
    ended_at: endMin === null ? null : SHOW + endMin * MIN,
} )

describe( 'deviceFromUserAgent', () => {
    it( 'reduces a user agent to a device class', () => {
        expect( deviceFromUserAgent( 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' ) ).toBe( 'iPhone' )
        expect( deviceFromUserAgent( 'Mozilla/5.0 (Linux; Android 14)' ) ).toBe( 'Android' )
        expect( deviceFromUserAgent( 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' ) ).toBe( 'Mac' )
        expect( deviceFromUserAgent( null ) ).toBe( 'Other' )
    } )
} )

describe( 'sanitizeClientId', () => {
    it( 'accepts random ids and rejects anything else', () => {
        expect( sanitizeClientId( '3f1c9a2e-8b7d-4c6e-9f00-1234567890ab' ) ).toBe( '3f1c9a2e-8b7d-4c6e-9f00-1234567890ab' )
        expect( sanitizeClientId( 'short' ) ).toBeNull()
        expect( sanitizeClientId( 'name@example.com' ) ).toBeNull()
        expect( sanitizeClientId( null ) ).toBeNull()
    } )
} )

describe( 'localDate', () => {
    it( 'uses the show time zone, not UTC', () => {
        // 00:30 UTC on the 18th is still the evening of the 17th in New York.
        expect( localDate( Date.UTC( 2026, 9, 18, 0, 30 ) ) ).toBe( '2026-10-17' )
    } )
} )

describe( 'peakConcurrent', () => {
    it( 'finds the most sessions open at once', () => {
        const result = peakConcurrent( [ session( 0, 30 ), session( 10, 20 ), session( 15, 40 ), session( 35, 50 ) ], SHOW + 60 * MIN )

        expect( result.peak ).toBe( 3 )
        expect( result.peakAt ).toBe( SHOW + 15 * MIN )
    } )

    it( 'does not double count a reconnect at the same instant', () => {
        expect( peakConcurrent( [ session( 0, 10 ), session( 10, 20 ) ], SHOW + 60 * MIN ).peak ).toBe( 1 )
    } )

    it( 'treats open sessions as running until now', () => {
        expect( peakConcurrent( [ session( 0, null ), session( 50, 55 ) ], SHOW + 60 * MIN ).peak ).toBe( 2 )
    } )
} )

describe( 'summarizeDate', () => {
    it( 'counts unique listeners by client id and averages durations', () => {
        const sessions = [
            session( 0, 10, 'aaaaaaaa-1' ),
            session( 12, 32, 'aaaaaaaa-1' ),
            session( 5, 35, 'bbbbbbbb-2', 'Android' ),
        ]
        const summary = summarizeDate( '2026-10-17', sessions, SHOW + 60 * MIN )

        expect( summary.sessions ).toBe( 3 )
        expect( summary.uniqueListeners ).toBe( 2 )
        expect( summary.totalListeningMs ).toBe( 60 * MIN )
        expect( summary.avgSessionMs ).toBe( 20 * MIN )
        expect( summary.medianSessionMs ).toBe( 20 * MIN )
        expect( summary.devices ).toEqual( { iPhone: 2, Android: 1 } )
        expect( summary.peak ).toBe( 2 )
    } )
} )

describe( 'summarizeDates', () => {
    it( 'groups by show-local date, newest first', () => {
        const dates = summarizeDates( [ session( 0, 10 ), session( -24 * 60, -24 * 60 + 5 ) ], SHOW + 60 * MIN )

        expect( dates.map( ( entry ) => entry.date ) ).toEqual( [ '2026-10-17', '2026-10-16' ] )
    } )
} )

describe( 'minuteTimeline', () => {
    it( 'counts listeners connected during each minute', () => {
        const points = minuteTimeline( [ session( 0, 3 ), session( 2, 5 ) ], SHOW, SHOW + 4 * MIN, SHOW + 60 * MIN )

        expect( points.map( ( point ) => point.listeners ) ).toEqual( [ 1, 1, 2, 1, 1 ] )
    } )
} )

describe( 'songStats', () => {
    it( 'reports listeners at the start, the peak and the average for each song', () => {
        const plays = [ { file: 'a.mp3', playlist: 'Halloween - First Show', started_at: SHOW, ended_at: SHOW + 4 * MIN } ]
        const [ stats ] = songStats( plays, [ session( -5, 4 ), session( 2, 10 ) ], SHOW + 60 * MIN )

        expect( stats.listenersAtStart ).toBe( 1 )
        expect( stats.peakListeners ).toBe( 2 )
        expect( stats.avgListeners ).toBe( 1.5 )
    } )
} )
