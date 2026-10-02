import type { MediaSample } from '../shared/protocol'

/**
 * Tracks where the show is in the current media file.
 *
 * Every sample implies an "epoch": the relay time (in seconds) at which
 * position 0 of the file played, `at / 1000 - pos`. While a file plays
 * normally the epoch is constant, so the estimate is the median of recent
 * epochs, which removes the jitter of individual samples. A run of samples
 * that disagree with the median (FPP restarted or seeked the file) replaces
 * the history instead of being averaged in.
 *
 * @since  [NEXT_VERSION]
 */
export class PositionTracker {
    private file: string | null = null
    private epochs: number[] = []
    private pending: number[] = []

    /**
     * @since  [NEXT_VERSION]
     *
     * @param  {number}  maxSamples       Number of recent epochs to keep.
     * @param  {number}  jumpThreshold    Seconds of disagreement that count as a jump.
     * @param  {number}  jumpConfirmations Consecutive disagreeing samples needed to accept a jump.
     */
    constructor(
        private readonly maxSamples = 15,
        private readonly jumpThreshold = 0.25,
        private readonly jumpConfirmations = 2,
    ) {}

    /**
     * Add a sample. Returns true when the estimate jumped (new file, or a seek
     * or restart within the same file).
     *
     * @since  [NEXT_VERSION]
     *
     * @param  {MediaSample}  sample  Position sample from the relay.
     * @return {boolean}
     */
    add( sample: MediaSample ): boolean {
        const epoch = sample.at / 1000 - sample.pos

        if ( sample.file !== this.file || this.epochs.length === 0 ) {
            this.file = sample.file
            this.epochs = [ epoch ]
            this.pending = []

            return true
        }

        const current = this.median( this.epochs )

        if ( Math.abs( epoch - current ) > this.jumpThreshold ) {
            this.pending.push( epoch )

            if ( this.pending.length < this.jumpConfirmations ) {
                return false
            }

            const spread = Math.max( ...this.pending ) - Math.min( ...this.pending )

            if ( spread > this.jumpThreshold ) {
                // Disagreeing samples do not agree with each other either; keep waiting.
                this.pending = [ epoch ]

                return false
            }

            this.epochs = this.pending
            this.pending = []

            return true
        }

        this.pending = []
        this.epochs.push( epoch )

        if ( this.epochs.length > this.maxSamples ) {
            this.epochs.shift()
        }

        return false
    }

    /**
     * The file currently tracked.
     *
     * @since  [NEXT_VERSION]
     *
     * @return {string|null}
     */
    get currentFile(): string | null {
        return this.file
    }

    /**
     * Position in seconds that plays at the given relay time.
     *
     * @since  [NEXT_VERSION]
     *
     * @param  {number}  relayMs  Relay time in ms.
     * @return {number|null}
     */
    positionAt( relayMs: number ): number | null {
        if ( this.epochs.length === 0 ) {
            return null
        }

        return relayMs / 1000 - this.median( this.epochs )
    }

    /**
     * Forget everything, e.g. when FPP stops.
     *
     * @since  [NEXT_VERSION]
     *
     * @return {void}
     */
    reset(): void {
        this.file = null
        this.epochs = []
        this.pending = []
    }

    private median( values: number[] ): number {
        const sorted = [ ...values ].sort( ( a, b ) => a - b )
        const middle = Math.floor( sorted.length / 2 )

        if ( sorted.length % 2 === 0 ) {
            return ( sorted[ middle - 1 ] + sorted[ middle ] ) / 2
        }

        return sorted[ middle ]
    }
}
