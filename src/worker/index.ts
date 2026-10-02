import { isPluginRequest } from './auth'
import { handleMedia } from './media'

export { Show } from './show'

/**
 * Relay entry point.
 *
 * - `/ws`          listener WebSocket (public)
 * - `/fpp`         FPP plugin WebSocket (bearer token)
 * - `/api/state`   current show state as JSON (public)
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
