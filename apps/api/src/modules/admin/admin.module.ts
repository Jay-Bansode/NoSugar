import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RateLimiterService } from '../../common/rate-limiter.service.js';
import { AdminAuthController, AdminMeController } from './admin-auth.controller.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminGuard } from './admin.guard.js';
import { AdminSessionService } from './admin-session.service.js';
import { AdminTokenService } from './admin-token.service.js';
import { AuditLogController } from './audit-log.controller.js';

/**
 * Admin panel API (/v1/admin/...): staff sign-in with 2FA, role guard, audit log.
 * Feature modules add their own admin controllers with @AdminController.
 */
@Module({
  controllers: [AdminAuthController, AdminMeController, AuditLogController],
  providers: [
    AdminAuthService,
    AdminSessionService,
    AdminTokenService,
    RateLimiterService,
    // Checks admin tokens and roles on @AdminController routes; refuses unguarded /admin routes.
    { provide: APP_GUARD, useClass: AdminGuard },
  ],
  exports: [AdminTokenService, AdminSessionService],
})
export class AdminModule {}
