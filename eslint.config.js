import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    // pressStart2P.ts is a generated base64 data blob (functions/_lib/fonts/SOURCE.txt
    // documents how to regenerate it), not hand-written source — excluded
    // like the other generated/build-output entries below.
    ignores: [
      'node_modules/',
      'dist/',
      '.vite/',
      '*.js',
      'eslint.config.js',
      'functions/_lib/fonts/pressStart2P.ts',
    ],
  },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
        project: './tsconfig.json',
      },
      globals: {
        document: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        performance: 'readonly',
        requestAnimationFrame: 'readonly',
        localStorage: 'readonly',
        KeyboardEvent: 'readonly',
        AudioContext: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
        URLSearchParams: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        // Used by src/core/replayEngine.ts's chunked (viewer) simulation
        // driver to hand control back to the event loop between chunks.
        setTimeout: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Cloudflare Pages Functions (docs/plan-cloudflare-x-share.md Phase 2):
    // a separate project (tsconfig.functions.json) since they run in the
    // Workers runtime, not the browser/DOM `src/` targets.
    files: ['functions/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2021,
        sourceType: 'module',
        project: './tsconfig.functions.json',
      },
      globals: {
        console: 'readonly',
        crypto: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        TextEncoder: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        URL: 'readonly',
        // Streaming request-body reading (functions/api/scores.ts's
        // readBodyWithLimit()) and its tests.
        ReadableStream: 'readonly',
        TextDecoder: 'readonly',
        RequestInit: 'readonly',
        // Ambient types from @cloudflare/workers-types (tsconfig.functions.json's
        // "types"), not real JS globals — declared here purely so eslint's
        // (type-unaware) `no-undef` rule doesn't flag them; tsc itself
        // already validates their usage via tsconfig.functions.json.
        KVNamespace: 'readonly',
        D1Database: 'readonly',
        D1PreparedStatement: 'readonly',
        PagesFunction: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
