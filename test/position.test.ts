import { describe, expect, it } from 'vitest'

import { PositionTracker } from '../src/client/position'

const sample = ( file: string, pos: number, at: number ) => ( { file, pos, at } )

describe( 'PositionTracker', () => {
    it( 'extrapolates the position from a sample', () => {
        const tracker = new PositionTracker()

        expect( tracker.add( sample( 'a.mp3', 10, 100_000 ) ) ).toBe( true )
        expect( tracker.positionAt( 101_500 ) ).toBeCloseTo( 11.5, 6 )
    } )

    it( 'smooths jitter with the median epoch', () => {
        const tracker = new PositionTracker()

        // True epoch is 90 s; samples jitter by up to 15 ms.
        tracker.add( sample( 'a.mp3', 10.000, 100_000 ) )
        tracker.add( sample( 'a.mp3', 10.515, 100_500 ) )
        tracker.add( sample( 'a.mp3', 10.990, 101_000 ) )
        tracker.add( sample( 'a.mp3', 11.500, 101_500 ) )
        tracker.add( sample( 'a.mp3', 12.004, 102_000 ) )

        expect( tracker.positionAt( 110_000 ) ).toBeCloseTo( 20, 2 )
    } )

    it( 'starts over on a new file', () => {
        const tracker = new PositionTracker()

        tracker.add( sample( 'a.mp3', 100, 200_000 ) )

        expect( tracker.add( sample( 'b.mp3', 0.2, 300_000 ) ) ).toBe( true )
        expect( tracker.currentFile ).toBe( 'b.mp3' )
        expect( tracker.positionAt( 301_000 ) ).toBeCloseTo( 1.2, 6 )
    } )

    it( 'ignores a single outlier', () => {
        const tracker = new PositionTracker()

        tracker.add( sample( 'a.mp3', 10, 100_000 ) )
        tracker.add( sample( 'a.mp3', 10.5, 100_500 ) )

        expect( tracker.add( sample( 'a.mp3', 30, 101_000 ) ) ).toBe( false )
        expect( tracker.add( sample( 'a.mp3', 11.5, 101_500 ) ) ).toBe( false )
        expect( tracker.positionAt( 102_000 ) ).toBeCloseTo( 12, 6 )
    } )

    it( 'accepts a confirmed jump within the same file', () => {
        const tracker = new PositionTracker()

        tracker.add( sample( 'a.mp3', 50, 100_000 ) )
        tracker.add( sample( 'a.mp3', 50.5, 100_500 ) )

        // FPP restarted the song.
        expect( tracker.add( sample( 'a.mp3', 0.1, 101_000 ) ) ).toBe( false )
        expect( tracker.add( sample( 'a.mp3', 0.6, 101_500 ) ) ).toBe( true )
        expect( tracker.positionAt( 102_000 ) ).toBeCloseTo( 1.1, 6 )
    } )

    it( 'returns null when reset', () => {
        const tracker = new PositionTracker()

        tracker.add( sample( 'a.mp3', 1, 1_000 ) )
        tracker.reset()

        expect( tracker.positionAt( 2_000 ) ).toBeNull()
        expect( tracker.currentFile ).toBeNull()
    } )
} )
