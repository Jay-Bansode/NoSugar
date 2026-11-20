import { ApiError } from '@brand/api-client';

/** A message to show for a failed request. API messages are already written for people. */
export function errorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Something went wrong. Please try again.';
  if (err.code === 'ACCOUNT_LOCKED' || err.code === 'RATE_LIMITED') {
    const seconds = Number(err.details.retryAfterSeconds);
    if (Number.isFinite(seconds) && seconds > 0) {
      const minutes = Math.ceil(seconds / 60);
      return `${err.message} You can try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
    }
  }
  return err.message;
}
