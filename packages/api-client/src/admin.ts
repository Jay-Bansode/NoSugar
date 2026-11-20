import {
  ADMIN_CLIENT_HEADER,
  ADMIN_CLIENT_VALUE,
  type AdminChangePassword,
  type AdminLoginChallenge,
  adminLoginChallengeSchema,
  type AdminMe,
  adminMeSchema,
  type AdminTokens,
  adminTokensSchema,
  type AuditLogEntry,
  auditLogEntrySchema,
  type Paginated,
  paginated,
} from '@brand/shared';
import { type ApiClient, type ApiClientOptions, createApiClient } from './client.js';

export interface AuditLogQuery {
  cursor?: string;
  limit?: number;
  adminUserId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
}

const auditLogPage = paginated(auditLogEntrySchema);

/**
 * The admin panel's API: sign-in and the /v1/admin endpoints. Sends cookies (the refresh
 * token is an httpOnly cookie on the API's origin) and the admin client header on every call.
 */
export function createAdminApi(options: Omit<ApiClientOptions, 'credentials'>) {
  const client: ApiClient = createApiClient({
    ...options,
    credentials: 'include',
    headers: { ...options.headers, [ADMIN_CLIENT_HEADER]: ADMIN_CLIENT_VALUE },
  });

  return {
    client,
    auth: {
      login: (email: string, password: string): Promise<AdminLoginChallenge> =>
        client.request('POST', '/admin/auth/login', {
          body: { email, password },
          schema: adminLoginChallengeSchema,
          auth: false,
        }),
      totp: (challengeToken: string, code: string): Promise<AdminTokens> =>
        client.request('POST', '/admin/auth/totp', {
          body: { challengeToken, code },
          schema: adminTokensSchema,
          auth: false,
        }),
      /** Uses the refresh cookie. */
      refresh: (): Promise<AdminTokens> =>
        client.request('POST', '/admin/auth/refresh', { schema: adminTokensSchema, auth: false }),
      logout: (): Promise<void> => client.request('POST', '/admin/auth/logout', { auth: false }),
    },
    me: (): Promise<AdminMe> => client.request('GET', '/admin/me', { schema: adminMeSchema }),
    changePassword: (input: AdminChangePassword): Promise<void> =>
      client.request('POST', '/admin/me/password', { body: input }),
    auditLog: (query: AuditLogQuery = {}): Promise<Paginated<AuditLogEntry>> =>
      client.request('GET', '/admin/audit-log', { query: { ...query }, schema: auditLogPage }),
  };
}

export type AdminApi = ReturnType<typeof createAdminApi>;
