import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import tseslint from 'typescript-eslint'

export default tseslint.config(
    {
        ignores: [ 'node_modules/', 'public/*.js', 'public/*.js.map', '.wrangler/', 'worker-configuration.d.ts' ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        plugins: {
            '@stylistic': stylistic,
        },
        rules: {
            '@stylistic/space-in-parens': [ 'error', 'always' ],
            '@stylistic/padding-line-between-statements': [ 'error', { blankLine: 'always', prev: '*', next: 'return' } ],
            '@stylistic/indent': [ 'error', 4 ],
            '@stylistic/semi': [ 'error', 'never' ],
            '@stylistic/quotes': [ 'error', 'single', { avoidEscape: true } ],
            curly: [ 'error', 'all' ],
            'no-empty': [ 'error', { allowEmptyCatch: true } ],
        },
    },
    {
        files: [ 'scripts/**/*.mjs' ],
        languageOptions: {
            globals: {
                Buffer: 'readonly',
                console: 'readonly',
                fetch: 'readonly',
                process: 'readonly',
                clearTimeout: 'readonly',
                setTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                performance: 'readonly',
            },
        },
    },
)
