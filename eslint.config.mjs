import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

/** @type {import('eslint').Linter.Config[]} */
const config = [
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'drizzle/**',
      'next-env.d.ts',
      'netlify/functions/**',
      '.jarvis-data/**',
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@octokit/rest',
              message:
                'GitHub access must go through src/server/providers/github. Direct Octokit imports are not allowed elsewhere.',
            },
          ],
        },
      ],
      eqeqeq: ['error', 'smart'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['src/server/providers/github/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // The `src/server` tree is server-only. Presentational components must receive data as
    // props from server components instead of reaching into services or the database.
    files: ['src/components/**/*.{ts,tsx}', 'src/lib/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/server/*', '@/server/**'],
              message:
                'Components must not import server modules. Pass data down from a server component instead.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.{ts,mts}', 'tests/**/*.ts', 'vitest.config.ts', 'playwright.config.ts'],
    rules: { 'no-console': 'off' },
  },
];

export default config;
