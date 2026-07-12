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
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        URL: 'readonly',
        // Ambient types from @cloudflare/workers-types (tsconfig.functions.json's
        // "types"), not real JS globals — declared here purely so eslint's
        // (type-unaware) `no-undef` rule doesn't flag them; tsc itself
        // already validates their usage via tsconfig.functions.json.
        KVNamespace: 'readonly',
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
