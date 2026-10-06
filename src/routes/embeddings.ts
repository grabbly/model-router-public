import { FastifyPluginAsync } from 'fastify';
import { extractBearerToken, requireAuth } from '../auth/middleware.js';
import { getEmbeddingModelConfigs } from '../config.js';
import {
  getMetadataMode,
  parseClientMeta,
  recordClientMeta,
  warnMissingMetadataOnce,
} from '../core/client-meta.js';
import { isCoolingDown, recordFailure, recordSuccess } from '../core/cooldown.js';
import { resolveEntryKey } from '../core/keys.js';
import { getTenant } from '../core/tenants.js';
import { providerLabel } from '../core/provider-label.js';
import {
  AuthType,
  extractClientIp,
  formatKeyHint,
  recordRequest,
  RequestLogRecord,
} from '../core/request-log.js';
import { checkTenantRate } from '../core/tenant-rate.js';
import { EMBEDDING_MODEL_IDS, EmbeddingModelId, EmbeddingRequest } from '../types.js';

export const embeddingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: EmbeddingRequest }>(
    '/v1/embeddings',
    { preHandler: requireAuth },
    async (req, reply) => {
      const startTime = Date.now();
      const body = req.body;
      const tenantId = req.tenant?.tenantId || 'anonymous';
      const reqIp = extractClientIp(req);
      const userAgent = req.headers['user-agent'];

      const authMeta = req.authMeta || {
        authType: (req.tenant?.isMaster ? 'master' : 'tenant-token') as AuthType,
        keyHint: formatKeyHint(
          extractBearerToken(req),
          req.tenant?.isMaster ? 'master' : 'tenant-token',
          req.tenant?.tenantId
        ),
      };

      let recorded = false;
      let releaseSlot: (() => void) | null = null;
      const ctx: Partial<RequestLogRecord> = {
        ts: new Date(startTime).toISOString(),
        tenant: tenantId,
        authType: authMeta.authType,
        keyHint: authMeta.keyHint,
        ip: reqIp,
        userAgent,
        stream: false,
      };

      const finishRecord = (updates: Partial<RequestLogRecord>) => {
        if (releaseSlot) {
          releaseSlot();
        }
        if (recorded) return;
        recorded = true;
        Object.assign(ctx, updates);
        if (ctx.latencyMs === undefined) {
          ctx.latencyMs = Date.now() - startTime;
        }
        recordRequest(ctx as RequestLogRecord);
      };

      // 1. Missing model field
      if (!body || !body.model) {
        finishRecord({ status: 400, errorCode: 'missing_model' });
        return reply.status(400).send({
          error: {
            message: 'Missing "model" field in request body',
            type: 'invalid_request_error',
            param: 'model',
            code: 'missing_model',
          },
        });
      }

      // 2. Unknown model (embeddings have a dedicated catalog; chat and physical models return 404)
      if (!(EMBEDDING_MODEL_IDS as readonly string[]).includes(body.model)) {
        finishRecord({ tier: body.model, status: 404, errorCode: 'model_not_found' });
        return reply.status(404).send({
          error: {
            message: `Model "${body.model}" not found. Supported embedding models: ${EMBEDDING_MODEL_IDS.join(', ')}`,
            type: 'invalid_request_error',
            param: 'model',
            code: 'model_not_found',
          },
        });
      }

      // For a BYOK tenant, embeddings return 403 not_available_for_byok unless allowSharedEmbeddings is true
      const tenant = getTenant(tenantId);
      if (tenant?.mode === 'byok' && !tenant.allowSharedEmbeddings) {
        finishRecord({ status: 403, errorCode: 'not_available_for_byok' });
        return reply.status(403).send({
          error: {
            message: 'Embeddings are not available for BYOK tenants unless allowSharedEmbeddings is enabled',
            type: 'invalid_request_error',
            code: 'not_available_for_byok',
          },
        });
      }

      ctx.tier = body.model;

      // 3. Input validation: non-empty string or array (<= 256 items) of non-empty strings, total chars <= 200000
      let isValidInput = false;
      if (typeof body.input === 'string') {
        isValidInput = body.input.length > 0 && body.input.length <= 200_000;
      } else if (Array.isArray(body.input)) {
        if (body.input.length > 0 && body.input.length <= 256) {
          let totalChars = 0;
          let allStringsNonEmpty = true;
          for (const item of body.input) {
            if (typeof item !== 'string' || item.length === 0) {
              allStringsNonEmpty = false;
              break;
            }
            totalChars += item.length;
            if (totalChars > 200_000) {
              break;
            }
          }
          isValidInput = allStringsNonEmpty && totalChars <= 200_000;
        }
      }

      if (!isValidInput) {
        finishRecord({ status: 400, errorCode: 'invalid_input' });
        return reply.status(400).send({
          error: {
            message:
              'Invalid "input" field: must be a non-empty string or a non-empty array (<=256 items) of non-empty strings with total characters <= 200000',
            type: 'invalid_request_error',
            param: 'input',
            code: 'invalid_input',
          },
        });
      }

      // 4. Client metadata headers
      const meta = parseClientMeta(req.headers);
      const metaMode = getMetadataMode();
      recordClientMeta(tenantId, meta.complete);

      ctx.app = meta.app;
      ctx.agent = meta.agent;
      ctx.session = meta.session;
      ctx.user = meta.user;
      ctx.missingMetadata = !meta.complete;

      if (metaMode === 'enforce' && !meta.complete) {
        finishRecord({ status: 400, errorCode: 'missing_metadata' });
        return reply.status(400).send({
          error: {
            message:
              'Missing required metadata headers: x-router-app, x-router-agent, x-router-session (see INTEGRATION.md)',
            type: 'invalid_request_error',
            code: 'missing_metadata',
          },
        });
      }

      const missingMetaWarning = metaMode === 'soft' && !meta.complete;
      if (missingMetaWarning) {
        warnMissingMetadataOnce(tenantId);
      }

      // Per-tenant request limits (rpm, concurrent, dayRequests)
      const rateResult = checkTenantRate(tenantId, meta.agent);
      if (!rateResult.ok) {
        reply.header('retry-after', rateResult.retryAfterSec);
        reply.header('x-router-limit', rateResult.limit);
        finishRecord({ status: 429, errorCode: rateResult.errorCode });
        return reply.status(429).send({
          error: {
            message: rateResult.message,
            type: 'rate_limit_error',
            code: rateResult.errorCode,
          },
        });
      }

      releaseSlot = rateResult.release;
      req.raw.on('close', rateResult.release);
      reply.raw.on('close', rateResult.release);
      reply.raw.on('finish', rateResult.release);

      // 5. Forwarding across pool entries
      const embedConfigs = getEmbeddingModelConfigs();
      const cfg = embedConfigs[body.model as EmbeddingModelId];

      if (!cfg || cfg.pool.length === 0) {
        finishRecord({ status: 502, errorCode: 'upstream_unavailable' });
        return reply.status(502).send({
          error: {
            message: `All embedding backends failed for "${body.model}": no backends configured`,
            type: 'api_error',
            code: 'upstream_unavailable',
          },
        });
      }

      const entries = [...cfg.pool]
        .filter((e) => e.enabled)
        .sort((a, b) => a.priority - b.priority);

      let lastReason = '';

      for (const entry of entries) {
        const cooldown = isCoolingDown('text-embed', entry.id);
        if (cooldown.cooling) {
          lastReason = `entry "${entry.id}" cooling down (${cooldown.remainingSec}s remaining)`;
          continue;
        }

        const url = `${entry.baseUrl.replace(/\/+$/, '')}/embeddings`;
        const upstreamBody: Record<string, unknown> = {
          model: entry.model,
          input: body.input,
        };
        if (body.encoding_format === 'float') {
          upstreamBody.encoding_format = 'float';
        }

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        const apiKey = resolveEntryKey(entry);
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }

        try {
          const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(upstreamBody),
            signal: AbortSignal.timeout(cfg.timeoutMs),
          });

          if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            const reason = `status ${res.status}: ${errBody.slice(0, 200)}`;
            recordFailure('text-embed', entry.id, cfg.cooldownSec, reason);
            lastReason = reason;
            continue;
          }

          const json = (await res.json()) as any;
          if (
            !json ||
            !Array.isArray(json.data) ||
            json.data.length === 0 ||
            !Array.isArray(json.data[0]?.embedding)
          ) {
            const reason = 'missing data[0].embedding array in response body';
            recordFailure('text-embed', entry.id, cfg.cooldownSec, reason);
            lastReason = reason;
            continue;
          }

          // Upstream success
          recordSuccess('text-embed', entry.id);
          json.model = 'text-embed';
          const dims = json.data[0].embedding.length;
          const numInputs = typeof body.input === 'string' ? 1 : body.input.length;

          console.log(
            `[router] ${tenantId} text-embed → ${entry.id} (${entry.model}) n=${numInputs} dims=${dims} app=${meta.app ?? '-'} agent=${meta.agent ?? '-'} session=${meta.session ?? '-'}`
          );

          finishRecord({
            status: 200,
            tier: 'text-embed',
            backend: entry.id,
            physicalModel: entry.model,
            promptTokens:
              typeof json.usage?.prompt_tokens === 'number'
                ? json.usage.prompt_tokens
                : undefined,
            stream: false,
          });

          if (missingMetaWarning) {
            reply.header('x-router-warning', 'missing-metadata');
          }
          return reply
            .status(200)
            .header('x-router-model', entry.model)
            .header('x-router-provider', providerLabel(entry))
            .header('x-router-backend', entry.id)
            .header('x-router-dims', String(dims))
            .send(json);
        } catch (err: unknown) {
          const reason = err instanceof Error ? err.message : String(err);
          recordFailure('text-embed', entry.id, cfg.cooldownSec, reason);
          lastReason = reason;
          continue;
        }
      }

      // All pool entries failed
      finishRecord({
        status: 502,
        tier: 'text-embed',
        errorCode: 'upstream_unavailable',
        stream: false,
      });

      return reply.status(502).send({
        error: {
          message: `All embedding backends failed for "text-embed": ${lastReason || 'no reachable backend'}`,
          type: 'api_error',
          code: 'upstream_unavailable',
        },
      });
    }
  );
};
