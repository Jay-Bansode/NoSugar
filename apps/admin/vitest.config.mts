import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  // Next compiles JSX itself ("jsx": "preserve"); tests need the automatic React runtime.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['**/*.spec.{ts,tsx}'],
    exclude: ['node_modules/**', '.next/**'],
    environment: 'jsdom',
  },
});
