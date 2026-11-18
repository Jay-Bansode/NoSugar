import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC (not esbuild) so Nest's decorator metadata is emitted and DI works in tests.
export const swcPlugin = swc.vite({
  module: { type: 'es6' },
  jsc: {
    target: 'es2022',
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
  },
});

// Unit tests: src/**/*.spec.ts
export default defineConfig({
  plugins: [swcPlugin],
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
