import { FastifyRequest, FastifyReply } from 'fastify';
import { CONFIG } from '../config.js';
import { TenantContext } from '../types.js';
import { verifyTenantToken, timingSafeEqualStrings } from './tenant-token.js';
import {
  isDashboardEnabled,
  parseCookies,
  verifyAdminSessionToken,
} from './admin-auth.js';
import {
  AuthType,
  extractClientIp,
  formatKeyHint,
  recordRequest,
} from '../core/request-log.js';

import { getTenant } from '../core/tenants.js';

export interface AuthMeta {
  authType: AuthType;
  keyHint: string;
  token?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: TenantContext;
    authMeta?: AuthMeta;
  }
}

export function extractBearerToken(req: FastifyRequest): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  const apiKeyHeader = req.headers['x-api-key'];
  if (typeof apiKeyHeader === 'string' && apiKeyHeader.trim()) {
    return apiKeyHeader.trim();
  }
  return null;
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = extractBearerToken(req);

  if (!token) {
    if (req.url.startsWith('/v1/chat/completions') || req.url.startsWith('/v1/embeddings')) {
      recordRequest({
        ts: new Date().toISOString(),
        tenant: '(unauthenticated)',
        authType: 'none',
        keyHint: 'none',
        ip: extractClientIp(req),
        userAgent: req.headers['user-agent'],
        status: 401,
        errorCode: 'unauthorized',
        latencyMs: 0,
      });
    }

    reply.status(401).send({
      error: {
        message: 'Missing Bearer token in Authorization header or X-API-Key',
        type: 'invalid_request_error',
        param: null,
        code: 'unauthorized',
      },
    });
    return;
  }

  // 1. Check Tenant Token
  const tenantId = verifyTenantToken(token);
  if (tenantId) {
    const record = getTenant(tenantId);
    if (record?.status === 'disabled') {
      const authType: AuthType = 'tenant-token';
      const keyHint = formatKeyHint(token, 'tenant-token', tenantId);
      if (req.url.startsWith('/v1/chat/completions') || req.url.startsWith('/v1/embeddings')) {
        recordRequest({
          ts: new Date().toISOString(),
          tenant: tenantId,
          authType,
          keyHint,
          ip: extractClientIp(req),
          userAgent: req.headers['user-agent'],
          status: 403,
          errorCode: 'tenant_disabled',
          latencyMs: 0,
        });
      }
      return reply.status(403).send({
        error: {
          message: `Tenant "${tenantId}" is disabled`,
          type: 'invalid_request_error',
          param: null,
          code: 'tenant_disabled',
        },
      });
    }

    req.tenant = { tenantId, isMaster: false };
    req.authMeta = {
      authType: 'tenant-token',
      keyHint: formatKeyHint(token, 'tenant-token', tenantId),
      token,
    };
    return;
  }

  // 2. Check Master Service API Key
  const masterKey = CONFIG.serviceApiKey;
  if (masterKey && timingSafeEqualStrings(token, masterKey)) {
    const impersonated = req.headers['x-tenant-id'];
    const hasImp = typeof impersonated === 'string' && impersonated.trim();
    const resolvedTenant = hasImp ? impersonated.trim() : 'master-service';
    const authType: AuthType = hasImp ? 'master-impersonated' : 'master';

    if (hasImp) {
      const record = getTenant(resolvedTenant);
      if (record?.status === 'disabled') {
        const keyHint = formatKeyHint(token, authType);
        if (req.url.startsWith('/v1/chat/completions') || req.url.startsWith('/v1/embeddings')) {
          recordRequest({
            ts: new Date().toISOString(),
            tenant: resolvedTenant,
            authType,
            keyHint,
            ip: extractClientIp(req),
            userAgent: req.headers['user-agent'],
            status: 403,
            errorCode: 'tenant_disabled',
            latencyMs: 0,
          });
        }
        return reply.status(403).send({
          error: {
            message: `Tenant "${resolvedTenant}" is disabled`,
            type: 'invalid_request_error',
            param: null,
            code: 'tenant_disabled',
          },
        });
      }
    }

    req.tenant = { tenantId: resolvedTenant, isMaster: true };
    req.authMeta = {
      authType,
      keyHint: formatKeyHint(token, authType),
      token,
    };
    return;
  }

  // 3. Fallback: If no secret is configured at all in dev mode and request passed a dev dummy token
  if (!CONFIG.serviceApiKey && !CONFIG.tenantTokenSecret && process.env.NODE_ENV === 'test') {
    req.tenant = { tenantId: 'test-tenant', isMaster: true };
    req.authMeta = {
      authType: 'master',
      keyHint: 'master …test',
      token,
    };
    return;
  }

  if (req.url.startsWith('/v1/chat/completions') || req.url.startsWith('/v1/embeddings')) {
    recordRequest({
      ts: new Date().toISOString(),
      tenant: '(unauthenticated)',
      authType: 'invalid',
      keyHint: formatKeyHint(token, 'invalid'),
      ip: extractClientIp(req),
      userAgent: req.headers['user-agent'],
      status: 401,
      errorCode: 'unauthorized',
      latencyMs: 0,
    });
  }

  reply.status(401).send({
    error: {
      message: 'Invalid Bearer token',
      type: 'invalid_request_error',
      param: null,
      code: 'unauthorized',
    },
  });
}

/**
 * Authorization for admin ops (/admin/status, /admin/probe, etc.).
 * ONLY the master key or the admin session cookie is accepted; tenant tokens get 403.
 */
export async function requireAdminAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Check admin session cookie first
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.rr_admin && verifyAdminSessionToken(cookies.rr_admin)) {
    req.tenant = { tenantId: 'admin', isMaster: true };
    return;
  }

  const token = extractBearerToken(req);

  if (!token) {
    if (!CONFIG.serviceApiKey && process.env.NODE_ENV === 'test') {
      req.tenant = { tenantId: 'admin-test', isMaster: true };
      return;
    }
    reply.status(401).send({
      error: {
        message: 'Admin authorization required',
        type: 'invalid_request_error',
        code: 'unauthorized',
      },
    });
    return;
  }

  const masterKey = CONFIG.serviceApiKey;
  if (masterKey && timingSafeEqualStrings(token, masterKey)) {
    req.tenant = { tenantId: 'admin', isMaster: true };
    return;
  }

  // Tenant tokens are strictly forbidden for admin endpoints
  const tenantId = verifyTenantToken(token);
  if (tenantId) {
    reply.status(403).send({
      error: {
        message: 'Forbidden: admin access required',
        type: 'invalid_request_error',
        code: 'forbidden',
      },
    });
    return;
  }

  if (!CONFIG.serviceApiKey && process.env.NODE_ENV === 'test') {
    req.tenant = { tenantId: 'admin-test', isMaster: true };
    return;
  }

  reply.status(401).send({
    error: {
      message: 'Admin authorization required',
      type: 'invalid_request_error',
      code: 'unauthorized',
    },
  });
}

/**
 * PreHandler for Dashboard pages (/admin/ui) and Admin APIs (/admin/api/*).
 * Accepts a valid rr_admin cookie OR the master key.
 * Pages redirect to /admin/login when unauthenticated; APIs return 401 JSON (or 403 for tenant token).
 */
export async function requireAdminSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const isPage = req.url.startsWith('/admin/ui');

  if (!isDashboardEnabled()) {
    if (isPage) {
      return reply
        .status(503)
        .type('text/plain; charset=utf-8')
        .send('Dashboard disabled: set ROUTER_ADMIN_PASSWORD');
    }

    // Admin API is still usable with the master key when dashboard is disabled
    const token = extractBearerToken(req);
    const masterKey = CONFIG.serviceApiKey;
    if (token && masterKey && timingSafeEqualStrings(token, masterKey)) {
      req.tenant = { tenantId: 'admin', isMaster: true };
      return;
    }

    // Check if tenant token was passed to API
    if (token && verifyTenantToken(token)) {
      return reply.status(403).send({
        error: {
          message: 'Forbidden: admin access required',
          type: 'invalid_request_error',
          code: 'forbidden',
        },
      });
    }

    return reply.status(401).send({
      error: {
        message: 'Admin authorization required',
        type: 'invalid_request_error',
        code: 'unauthorized',
      },
    });
  }

  // 1. Check rr_admin session cookie
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.rr_admin && verifyAdminSessionToken(cookies.rr_admin)) {
    req.tenant = { tenantId: 'admin', isMaster: true };
    return;
  }

  // 2. Check master key
  const token = extractBearerToken(req);
  const masterKey = CONFIG.serviceApiKey;
  if (token && masterKey && timingSafeEqualStrings(token, masterKey)) {
    req.tenant = { tenantId: 'admin', isMaster: true };
    return;
  }

  // 3. Reject tenant token with 403
  if (token && verifyTenantToken(token)) {
    return reply.status(403).send({
      error: {
        message: 'Forbidden: admin access required',
        type: 'invalid_request_error',
        code: 'forbidden',
      },
    });
  }

  // 4. Not authenticated
  if (isPage) {
    return reply.redirect(303, '/admin/login');
  }

  return reply.status(401).send({
    error: {
      message: 'Admin authorization required',
      type: 'invalid_request_error',
      code: 'unauthorized',
    },
  });
}
