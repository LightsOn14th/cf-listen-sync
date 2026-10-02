/**
 * Whether the request carries the FPP plugin token as a bearer token.
 *
 * @since  [NEXT_VERSION]
 *
 * @param  {Request}  request  Incoming request.
 * @param  {Env}      env      Worker environment.
 * @return {boolean}
 */
export function isPluginRequest( request: Request, env: Env ): boolean {
    const expected = env.FPP_TOKEN

    if ( ! expected ) {
        return false
    }

    const header = request.headers.get( 'Authorization' ) ?? ''
    const match = /^Bearer\s+(.+)$/i.exec( header )

    if ( ! match ) {
        return false
    }

    const encoder = new TextEncoder()
    const given = encoder.encode( match[ 1 ].trim() )
    const wanted = encoder.encode( expected )

    if ( given.byteLength !== wanted.byteLength ) {
        return false
    }

    return crypto.subtle.timingSafeEqual( given, wanted )
}
