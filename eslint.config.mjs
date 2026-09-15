// ESLint flat config — TypeScript source and tests.
// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'examples/**/node_modules/**',
      'examples/**/dist/**',
      'website/**',
      '.codegraph/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      // SQL / driver boundaries legitimately carry dynamic values.
      '@typescript-eslint/no-explicit-any': 'off',
      // `{}` is an intentional default for the base-columns generic
      // (Sqlo, AsyncSqlo, MultiSqlo) meaning "no shared columns".
      '@typescript-eslint/no-empty-object-type': ['error', { allowObjectTypes: 'always' }],
      // `const owner = this;` is how executor closures capture the instance.
      '@typescript-eslint/no-this-alias': ['error', { allowedNames: ['owner', 'self'] }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // Tests assert compile-time behaviour with bare expressions guarded by
      // `@ts-expect-error`; those are intentional.
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
);
