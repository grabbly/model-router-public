import { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../auth/middleware.js';
import {
  deleteQuotaGrant,
  getQuotaStatus,
  requestQuotaGrant,
  validateQuotaRequestBody,
} from '../core/budget.js';

export const budgetRoutes: FastifyPluginAsync = async (fastify) => {
  // PUT /v1/budget/quota
  fastify.put(
    '/v1/budget/quota',
    { preHandler: requireAuth },
    async (req, reply) => {
      const tenantId = req.tenant?.tenantId;
      if (!tenantId) {
        return reply.status(401).send({
          error: {
            message: 'Missing Bearer token in Authorization header or X-API-Key',
            type: 'invalid_request_error',
            param: null,
            code: 'unauthorized',
          },
        });
      }

      const val = validateQuotaRequestBody(req.body);
      if (!val.valid) {
        return reply.status(400).send({
          error: {
            message: val.error?.message || 'Invalid request body',
            type: 'invalid_request_error',
            param: val.error?.param ?? null,
            code: 'invalid_request_error',
          },
        });
      }

      const result = requestQuotaGrant(tenantId, req.body as any);
      if (!result.ok) {
        if (result.status === 429) {
          reply.header('retry-after', String(result.retryAfterSec));
          return reply.status(429).send({
            error: {
              message: result.message,
              type: 'rate_limit_error',
              code: 'quota_rate_limited',
            },
          });
        }
        if (result.status === 403) {
          return reply.status(403).send({
            error: {
              message: result.message,
              type: 'invalid_request_error',
              code: 'quota_not_allowed',
            },
          });
        }
        return reply.status(result.status || 400).send({
          error: {
            message: result.message,
            type: 'invalid_request_error',
            code: 'invalid_request_error',
          },
        });
      }

      return reply.status(200).send(result.data);
    }
  );

  // GET /v1/budget/quota
  fastify.get(
    '/v1/budget/quota',
    { preHandler: requireAuth },
    async (req, reply) => {
      const tenantId = req.tenant?.tenantId;
      if (!tenantId) {
        return reply.status(401).send({
          error: {
            message: 'Missing Bearer token in Authorization header or X-API-Key',
            type: 'invalid_request_error',
            param: null,
            code: 'unauthorized',
          },
        });
      }

      const status = getQuotaStatus(tenantId);
      return reply.status(200).send(status);
    }
  );

  // DELETE /v1/budget/quota
  fastify.delete(
    '/v1/budget/quota',
    { preHandler: requireAuth },
    async (req, reply) => {
      const tenantId = req.tenant?.tenantId;
      if (!tenantId) {
        return reply.status(401).send({
          error: {
            message: 'Missing Bearer token in Authorization header or X-API-Key',
            type: 'invalid_request_error',
            param: null,
            code: 'unauthorized',
          },
        });
      }

      deleteQuotaGrant(tenantId);
      return reply.status(200).send({ ok: true });
    }
  );
};
