import { z } from 'zod';

/**
 * Environment schema (CLAUDE.md §9). Only what the app uses today is required; add each
 * remaining variable here as the module that needs it lands, so startup fails fast and clearly.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_VERSION: z.string().default('0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
});

export type Env = z.infer<typeof envSchema>;

export const ENV = Symbol('ENV');

export class EnvValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid environment configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

/** Validates the given environment. Error messages name variables but never echo values. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}
