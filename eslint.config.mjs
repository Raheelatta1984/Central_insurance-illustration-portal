// ESLint (flat config). Scope is deliberately pragmatic: correctness rules are errors,
// style/exhaustiveness nits are warnings so the backlog is visible without blocking work.
// The dead `eslint-disable` comments that used to reference a non-existent setup now refer
// to this file.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/**', 'dist-server/**', 'node_modules/**', 'demo/**', 'site/**',
      'coverage/**', 'backlog/**', 'ledger/**', 'tools/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-empty': ['warn', { allowEmptyCatch: false }],
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
);
