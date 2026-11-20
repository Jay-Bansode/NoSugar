import base from '@brand/config/eslint';
import next from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['.next/**', 'next-env.d.ts'] },
  ...base,
  next.configs['core-web-vitals'],
  reactHooks.configs.flat.recommended,
  {
    files: ['**/*.tsx'],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
  },
];
