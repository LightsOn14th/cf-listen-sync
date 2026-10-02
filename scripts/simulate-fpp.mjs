/**
 * Stand-in for the FPP plugin, for testing the relay and the player without
 * the show Pi.
 *
 * Generates two click-track WAV files, uploads them, then "plays" them in a
 * loop and sends position samples exactly as the plugin does. Every second
 * has a short click and every fourth second a higher one, so two phones next
 * to each other can be compared by ear.
 *
 * Usage:
 *   node scripts/simulate-fpp.mjs [relayUrl] [token]
 *
 * Defaults to http://localhost:8787 and the FPP_TOKEN in .dev.vars.
 */
import { readFileSync } from 'node:fs'

import WebSocket from 'ws'

const relayUrl = ( process.argv[ 2 ] ?? 'http://localhost:8787' ).replace( /\/+$/, '' )
const token = process.argv[ 3 ] ?? readToken()

const SAMPLE_RATE = 22050
const SONG_SECONDS = 30
const GAP_MS = 1500
const SAMPLE_INTERVAL_MS = 500

const songs = [
    { file: 'Sync Test A.wav', tone: 880 },
    { file: 'Sync Test B.wav', tone: 523 },
]

function readToken() {
    try {
        const match = /^FPP_TOKEN=(.*)$/m.exec( readFileSync( '.dev.vars', 'utf8' ) )

        return match ? match[ 1 ].trim() : ''
    } catch {
        return ''
    }
}

function clickTrack( tone ) {
    const frames = SAMPLE_RATE * SONG_SECONDS
    const data = Buffer.alloc( 44 + frames * 2 )

    data.write( 'RIFF', 0 )
    data.writeUInt32LE( 36 + frames * 2, 4 )
    data.write( 'WAVEfmt ', 8 )
    data.writeUInt32LE( 16, 16 )
    data.writeUInt16LE( 1, 20 )
    data.writeUInt16LE( 1, 22 )
    data.writeUInt32LE( SAMPLE_RATE, 24 )
    data.writeUInt32LE( SAMPLE_RATE * 2, 28 )
    data.writeUInt16LE( 2, 32 )
    data.writeUInt16LE( 16, 34 )
    data.write( 'data', 36 )
    data.writeUInt32LE( frames * 2, 40 )

    const clickFrames = Math.round( SAMPLE_RATE * 0.03 )

    for ( let second = 0; second < SONG_SECONDS; second++ ) {
        const frequency = second % 4 === 0 ? tone * 2 : tone

        for ( let i = 0; i < clickFrames; i++ ) {
            const envelope = 1 - i / clickFrames
            const value = Math.sin( ( 2 * Math.PI * frequency * i ) / SAMPLE_RATE ) * envelope * 0.8
            const frame = second * SAMPLE_RATE + i

            data.writeInt16LE( Math.round( value * 32767 ), 44 + frame * 2 )
        }
    }

    return data
}

async function upload( song ) {
    const body = clickTrack( song.tone )
    const version = `sim-${ song.tone }-${ body.length }`
    const response = await fetch( `${ relayUrl }/media/${ encodeURIComponent( song.file ) }?version=${ version }`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${ token }`, 'Content-Length': String( body.length ) },
        body,
    } )

    if ( ! response.ok ) {
        throw new Error( `Upload of ${ song.file } failed: ${ response.status } ${ await response.text() }` )
    }

    console.log( `Uploaded ${ song.file }` )
}

function connect() {
    const socket = new WebSocket( relayUrl.replace( /^http/, 'ws' ) + '/fpp', {
        headers: { Authorization: `Bearer ${ token }` },
    } )
    const samples = []
    let pingId = 0
    let songIndex = 0
    let songStart = 0
    let timers = []

    const offset = () => {
        if ( samples.length === 0 ) {
            return null
        }

        const best = [ ...samples ].sort( ( a, b ) => a.rtt - b.rtt ).slice( 0, 3 ).map( ( s ) => s.offset ).sort( ( a, b ) => a - b )

        return best[ Math.floor( best.length / 2 ) ]
    }

    const send = ( message ) => {
        if ( socket.readyState === WebSocket.OPEN ) {
            socket.send( JSON.stringify( message ) )
        }
    }

    const sendSample = () => {
        const clockOffset = offset()

        if ( clockOffset === null ) {
            return
        }

        const now = performance.now()
        const pos = ( now - songStart ) / 1000

        if ( pos < 0 || pos > SONG_SECONDS ) {
            return
        }

        send( { type: 'media', state: 'playing', file: songs[ songIndex ].file, pos, at: now + clockOffset } )
    }

    const playNext = () => {
        songStart = performance.now()
        console.log( `Playing ${ songs[ songIndex ].file }` )
        sendSample()

        timers.push( setTimeout( () => {
            send( { type: 'media', state: 'stopped', file: songs[ songIndex ].file, pos: 0, at: 0 } )
            songIndex = ( songIndex + 1 ) % songs.length
            timers.push( setTimeout( playNext, GAP_MS ) )
        }, SONG_SECONDS * 1000 ) )
    }

    socket.on( 'open', () => {
        console.log( 'Connected to relay' )
        timers.push( setInterval( () => send( { type: 'ping', id: ++pingId, t0: performance.now() } ), 2000 ) )
        timers.push( setInterval( () => send( { type: 'hb' } ), 10_000 ) )
        timers.push( setInterval( sendSample, SAMPLE_INTERVAL_MS ) )

        for ( let i = 0; i < 5; i++ ) {
            timers.push( setTimeout( () => send( { type: 'ping', id: ++pingId, t0: performance.now() } ), i * 100 ) )
        }

        send( { type: 'playlist', name: 'Simulator', items: songs.map( ( song ) => song.file ) } )
        timers.push( setTimeout( playNext, 1000 ) )
    } )

    socket.on( 'message', ( raw ) => {
        const message = JSON.parse( raw.toString() )

        if ( message.type === 'pong' ) {
            const t1 = performance.now()

            samples.push( { offset: message.ts - ( message.t0 + t1 ) / 2, rtt: t1 - message.t0 } )

            if ( samples.length > 16 ) {
                samples.shift()
            }
        }
    } )

    socket.on( 'close', ( code ) => {
        console.log( `Relay connection closed (${ code }); reconnecting in 3 s` )
        timers.forEach( ( timer ) => clearTimeout( timer ) )
        timers = []
        setTimeout( connect, 3000 )
    } )

    socket.on( 'error', ( error ) => {
        console.error( `Relay connection error: ${ error.message }` )
    } )
}

if ( ! token ) {
    console.error( 'No token. Pass one as the second argument or set FPP_TOKEN in .dev.vars.' )
    process.exit( 1 )
}

for ( const song of songs ) {
    await upload( song )
}

connect()
