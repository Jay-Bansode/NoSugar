import { defineConfig } from 'vitest/config';
import { swcPlugin } from './vitest.config.js';

// API e2e tests (Supertest): test/**/*.e2e-spec.ts
export default defineConfig({
  plugins: [swcPlugin],
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    environment: 'node',
  },
});
