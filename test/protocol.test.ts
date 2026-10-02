import { describe, expect, it } from 'vitest'

import { mediaPath } from '../src/shared/protocol'

describe( 'mediaPath', () => {
    it( 'encodes the file name and version', () => {
        expect( mediaPath( { file: 'Jingle Bells #2.mp3', version: '123-10/01/26  07:47 PM' } ) )
            .toBe( '/media/Jingle%20Bells%20%232.mp3?v=123-10%2F01%2F26%20%2007%3A47%20PM' )
    } )

    it( 'omits the version when unknown', () => {
        expect( mediaPath( { file: 'a.mp3', version: null } ) ).toBe( '/media/a.mp3' )
    } )
} )
