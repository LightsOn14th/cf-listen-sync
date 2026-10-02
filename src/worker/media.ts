import { isPluginRequest } from './auth'

const MEDIA_PREFIX = 'music/'

const CONTENT_TYPES: Record<string, string> = {
    aac: 'audio/aac',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    mp3: 'audio/mpeg',
    mp4: 'audio/mp4',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    wav: 'audio/wav',
}

const CORS_HEADERS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag',
}

/**
 * Guess a media content type from a file name.
 *
 * @since  [NEXT_VERSION]
 *
 * @param  {string}  file  File name.
 * @return {string}
 */
export function contentTypeFor( file: string ): string {
    const extension = file.split( '.' ).pop()?.toLowerCase() ?? ''

    return CONTENT_TYPES[ extension ] ?? 'application/octet-stream'
}

/**
 * Whether a decoded file name is safe to use as an object key.
 *
 * @since  [NEXT_VERSION]
 *
 * @param  {string}  file  Decoded file name.
 * @return {boolean}
 */
export function isValidMediaName( file: string ): boolean {
    if ( file.length === 0 || file.length > 255 ) {
        return false
    }

    if ( file.includes( '/' ) || file.includes( '\\' ) || file === '.' || file === '..' ) {
        return false
    }

    return ! [ ...file ].some( ( character ) => character.charCodeAt( 0 ) < 0x20 )
}

/**
 * Handle `/media/<file>`: public GET/HEAD with range support, and PUT from the
 * FPP plugin.
 *
 * @since  [NEXT_VERSION]
 *
 * @param  {Request}  request  Incoming request.
 * @param  {Env}      env      Worker environment.
 * @param  {string}   encoded  The still-encoded file name from the path.
 * @return {Promise<Response>}
 */
export async function handleMedia( request: Request, env: Env, encoded: string ): Promise<Response> {
    let file: string

    try {
        file = decodeURIComponent( encoded )
    } catch {
        return new Response( 'Bad file name', { status: 400 } )
    }

    if ( ! isValidMediaName( file ) ) {
        return new Response( 'Bad file name', { status: 400 } )
    }

    if ( request.method === 'OPTIONS' ) {
        return new Response( null, { status: 204, headers: CORS_HEADERS } )
    }

    if ( request.method === 'PUT' ) {
        return putMedia( request, env, file )
    }

    if ( request.method === 'GET' || request.method === 'HEAD' ) {
        return getMedia( request, env, file )
    }

    return new Response( 'Method not allowed', { status: 405 } )
}

async function getMedia( request: Request, env: Env, file: string ): Promise<Response> {
    const key = MEDIA_PREFIX + file

    if ( request.method === 'HEAD' ) {
        const head = await env.MEDIA.head( key )

        if ( ! head ) {
            return new Response( null, { status: 404, headers: CORS_HEADERS } )
        }

        const headers = mediaHeaders( head, file )
        headers.set( 'Content-Length', String( head.size ) )

        return new Response( null, { status: 200, headers } )
    }

    const object = await env.MEDIA.get( key, { range: request.headers, onlyIf: request.headers } )

    if ( ! object ) {
        return new Response( 'Not found', { status: 404, headers: CORS_HEADERS } )
    }

    const headers = mediaHeaders( object, file )

    if ( ! ( 'body' in object ) ) {
        // A conditional request matched; the client copy is current.
        return new Response( null, { status: 304, headers } )
    }

    const range = object.range as { offset?: number, length?: number } | undefined

    if ( range && request.headers.has( 'Range' ) ) {
        const offset = range.offset ?? 0
        const length = range.length ?? object.size - offset

        headers.set( 'Content-Range', `bytes ${ offset }-${ offset + length - 1 }/${ object.size }` )
        headers.set( 'Content-Length', String( length ) )

        return new Response( object.body, { status: 206, headers } )
    }

    headers.set( 'Content-Length', String( object.size ) )

    return new Response( object.body, { status: 200, headers } )
}

async function putMedia( request: Request, env: Env, file: string ): Promise<Response> {
    if ( ! isPluginRequest( request, env ) ) {
        return new Response( 'Unauthorized', { status: 401 } )
    }

    const version = new URL( request.url ).searchParams.get( 'version' )

    if ( ! version || version.length > 128 ) {
        return new Response( 'Missing version', { status: 400 } )
    }

    if ( ! request.body || ! request.headers.get( 'Content-Length' ) ) {
        return new Response( 'Missing body', { status: 411 } )
    }

    await env.MEDIA.put( MEDIA_PREFIX + file, request.body, {
        httpMetadata: { contentType: contentTypeFor( file ) },
        customMetadata: { version },
    } )

    const show = env.SHOW.get( env.SHOW.idFromName( 'show' ) )
    await show.mediaUpdated( file, version )

    return Response.json( { file, version } )
}

function mediaHeaders( object: R2Object, file: string ): Headers {
    const headers = new Headers( CORS_HEADERS )

    object.writeHttpMetadata( headers )

    if ( ! headers.has( 'Content-Type' ) ) {
        headers.set( 'Content-Type', contentTypeFor( file ) )
    }

    headers.set( 'ETag', object.httpEtag )
    headers.set( 'Accept-Ranges', 'bytes' )
    headers.set( 'Cache-Control', 'public, max-age=86400' )

    return headers
}
