import { describe, expect, it } from 'vitest'

import { ClockSync } from '../src/shared/clock'

describe( 'ClockSync', () => {
    it( 'returns 0 before any samples', () => {
        const clock = new ClockSync()

        expect( clock.ready ).toBe( false )
        expect( clock.offset ).toBe( 0 )
        expect( clock.rtt ).toBeNull()
    } )

    it( 'computes the offset from a symmetric round trip', () => {
        const clock = new ClockSync()

        // Relay is 5000 ms ahead; 40 ms each way.
        clock.add( 1000, 6040, 1080 )

        expect( clock.offset ).toBe( 5000 )
        expect( clock.rtt ).toBe( 80 )
        expect( clock.toRelay( 2000 ) ).toBe( 7000 )
        expect( clock.toLocal( 7000 ) ).toBe( 2000 )
    } )

    it( 'prefers the fastest round trips over slow, skewed ones', () => {
        const clock = new ClockSync( 16, 3 )

        // Accurate fast samples.
        clock.add( 0, 5010, 20 )
        clock.add( 100, 5110, 120 )
        clock.add( 200, 5212, 220 )

        // Slow samples with asymmetric delay (300 ms up, 10 ms down).
        clock.add( 300, 5600, 610 )
        clock.add( 400, 5700, 710 )

        expect( clock.offset ).toBeCloseTo( 5000, 0 )
        expect( clock.rtt ).toBe( 20 )
    } )

    it( 'ignores invalid samples', () => {
        const clock = new ClockSync()

        clock.add( 100, 5000, 50 )
        clock.add( 0, Number.NaN, 10 )

        expect( clock.ready ).toBe( false )
    } )

    it( 'keeps only the most recent samples', () => {
        const clock = new ClockSync( 2, 1 )

        clock.add( 0, 1000, 2 )
        clock.add( 10, 2010, 30 )
        clock.add( 40, 2040, 60 )

        // The 2 ms sample (offset 999) was dropped.
        expect( clock.rtt ).toBe( 20 )
        expect( clock.offset ).toBe( 1990 )
    } )
} )
