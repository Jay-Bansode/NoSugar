// Shared ESLint flat config. Usage in a package:
//   import base from '@brand/config/eslint';
//   export default base;
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // CLAUDE.md §8: no `any` without a comment. Disable per line with
      // `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- <reason>`.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-console': 'warn',
    },
  },
  prettier,
);
