/**
 * One round trip: local send time, relay receive time, local receive time.
 *
 * @since  [NEXT_VERSION]
 */
export interface ClockSample {
    offset: number
    rtt: number
    receivedAt: number
}

/**
 * NTP-style offset estimator between a local monotonic clock and the relay
 * clock.
 *
 * Each round trip gives `offset = ts - ( t0 + t1 ) / 2` with an error bounded
 * by half the round trip time, so the samples with the shortest round trip are
 * the most trustworthy. The estimate is the median offset of the fastest few
 * recent samples, which rejects one-off outliers without lagging behind real
 * changes for long.
 *
 * @since  [NEXT_VERSION]
 */
export class ClockSync {
    private samples: ClockSample[] = []

    /**
     * @since  [NEXT_VERSION]
     *
     * @param  {number}  maxSamples  Number of recent samples to keep.
     * @param  {number}  bestOf      Number of fastest samples the estimate uses.
     */
    constructor( private readonly maxSamples = 16, private readonly bestOf = 3 ) {}

    /**
     * Record one round trip.
     *
     * @since  [NEXT_VERSION]
     *
     * @param  {number}  t0  Local time the ping was sent.
     * @param  {number}  ts  Relay time the ping was received.
     * @param  {number}  t1  Local time the pong was received.
     * @return {void}
     */
    add( t0: number, ts: number, t1: number ): void {
        const rtt = t1 - t0

        if ( rtt < 0 || ! Number.isFinite( rtt ) || ! Number.isFinite( ts ) ) {
            return
        }

        this.samples.push( { offset: ts - ( t0 + t1 ) / 2, rtt, receivedAt: t1 } )

        if ( this.samples.length > this.maxSamples ) {
            this.samples.shift()
        }
    }

    /**
     * Whether at least one sample has been recorded.
     *
     * @since  [NEXT_VERSION]
     *
     * @return {boolean}
     */
    get ready(): boolean {
        return this.samples.length > 0
    }

    /**
     * Estimated `relay - local` offset in ms, or 0 before any samples.
     *
     * @since  [NEXT_VERSION]
     *
     * @return {number}
     */
    get offset(): number {
        const best = this.fastest()

        if ( best.length === 0 ) {
            return 0
        }

        const offsets = best.map( ( sample ) => sample.offset ).sort( ( a, b ) => a - b )

        return offsets[ Math.floor( offsets.length / 2 ) ]
    }

    /**
     * Shortest round trip time among the kept samples, in ms.
     *
     * @since  [NEXT_VERSION]
     *
     * @return {number|null}
     */
    get rtt(): number | null {
        const best = this.fastest()

        return best.length > 0 ? best[ 0 ].rtt : null
    }

    /**
     * Convert a local time to relay time.
     *
     * @since  [NEXT_VERSION]
     *
     * @param  {number}  local  Local time in ms.
     * @return {number}
     */
    toRelay( local: number ): number {
        return local + this.offset
    }

    /**
     * Convert a relay time to local time.
     *
     * @since  [NEXT_VERSION]
     *
     * @param  {number}  relay  Relay time in ms.
     * @return {number}
     */
    toLocal( relay: number ): number {
        return relay - this.offset
    }

    /**
     * Drop all samples, e.g. after a reconnect.
     *
     * @since  [NEXT_VERSION]
     *
     * @return {void}
     */
    reset(): void {
        this.samples = []
    }

    private fastest(): ClockSample[] {
        return [ ...this.samples ].sort( ( a, b ) => a.rtt - b.rtt ).slice( 0, this.bestOf )
    }
}
