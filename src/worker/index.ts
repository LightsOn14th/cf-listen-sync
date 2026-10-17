import { isPluginRequest } from './auth'
import { handleMedia } from './media'

export { Show } from './show'

/**
 * Relay entry point.
 *
 * - `/ws`          listener WebSocket (public)
 * - `/fpp`         FPP plugin WebSocket (bearer token)
 * - `/api/state`   current show state as JSON (public)
 * - `/api/listeners/live`           listeners now and today (public)
 * - `/api/listeners/history`        summary per show date (public, `?days=`)
 * - `/api/listeners/history/<date>` one show date in detail (public)
 * - `/api/media`   uploaded media versions (bearer token)
 * - `/media/<f>`   media files: GET/HEAD public, PUT bearer token
 *
 * Anything else falls through to the static assets (the listen page and the
 * client bundle).
 *
 * @since  [NEXT_VERSION]
 */
export default {
    async fetch( request, env ): Promise<Response> {
        const url = new URL( request.url )
        const show = env.SHOW.get( env.SHOW.idFromName( 'show' ) )

        if ( url.pathname === '/ws' || url.pathname === '/fpp' ) {
            if ( request.headers.get( 'Upgrade' )?.toLowerCase() !== 'websocket' ) {
                return new Response( 'Expected a WebSocket upgrade', { status: 426 } )
            }

            if ( url.pathname === '/fpp' && ! isPluginRequest( request, env ) ) {
                return new Response( 'Unauthorized', { status: 401 } )
            }

            return show.fetch( request )
        }

        if ( url.pathname === '/api/state' ) {
            return Response.json( await show.getState(), {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-store',
                },
            } )
        }

        if ( url.pathname.startsWith( '/api/listeners/' ) ) {
            return handleListeners( url, show )
        }

        if ( url.pathname === '/api/media' ) {
            if ( ! isPluginRequest( request, env ) ) {
                return new Response( 'Unauthorized', { status: 401 } )
            }

            return Response.json( { files: await show.getVersions() } )
        }

        if ( url.pathname.startsWith( '/media/' ) ) {
            return handleMedia( request, env, url.pathname.slice( '/media/'.length ) )
        }

        return env.ASSETS.fetch( request )
    },
} satisfies ExportedHandler<Env>

const JSON_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
}

/**
 * Listener analytics. Anonymous aggregates only, so these are public like
 * `/api/state`.
 *
 * @since  [NEXT_VERSION]
 *
 * @param  {URL}     url   Request URL.
 * @param  {object}  show  Show Durable Object stub.
 * @return {Promise<Response>}
 */
const handleListeners = async ( url: URL, show: DurableObjectStub<import( './show' ).Show> ): Promise<Response> => {
    const path = url.pathname.slice( '/api/listeners/'.length )

    if ( path === 'live' ) {
        return Response.json( await show.getLiveListeners(), { headers: JSON_HEADERS } )
    }

    if ( path === 'history' ) {
        const days = Number( url.searchParams.get( 'days' ) ) || 90

        return Response.json( await show.getListenerHistory( days ), { headers: JSON_HEADERS } )
    }

    const match = path.match( /^history\/(\d{4}-\d{2}-\d{2})$/ )

    if ( match ) {
        const detail = await show.getListenerDate( match[1] )

        return detail
            ? Response.json( detail, { headers: JSON_HEADERS } )
            : Response.json( { error: 'No listeners on this date' }, { status: 404, headers: JSON_HEADERS } )
    }

    return Response.json( { error: 'Not found' }, { status: 404, headers: JSON_HEADERS } )
}
