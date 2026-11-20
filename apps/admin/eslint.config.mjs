import base from '@brand/config/eslint';
import next from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['.next/**', 'next-env.d.ts'] },
  ...base,
  next.configs['core-web-vitals'],
  reactHooks.configs.flat.recommended,
  {
    rules: {
      // The shadcn CLI sometimes rewrites `@/lib/utils` to an unrelated npm package named "cn".
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'cn', message: 'Import cn from "@/lib/utils".' }] },
      ],
    },
  },
  {
    files: ['**/*.tsx'],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
  },
];
