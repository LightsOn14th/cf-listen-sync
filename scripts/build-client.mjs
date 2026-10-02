import { build } from 'esbuild'

const watch = process.argv.includes( '--watch' )

const options = {
    entryPoints: {
        client: 'src/client/index.ts',
        page: 'src/client/page.ts',
    },
    outdir: 'public',
    bundle: true,
    format: 'esm',
    target: [ 'es2020', 'safari15' ],
    minify: ! watch,
    sourcemap: true,
    logLevel: 'info',
}

if ( watch ) {
    const { context } = await import( 'esbuild' )
    const ctx = await context( options )

    await ctx.watch()
} else {
    await build( options )
}
