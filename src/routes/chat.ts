import { FastifyPluginAsync } from 'fastify';
import { extractBearerToken, requireAuth } from '../auth/middleware.js';
import { loadLogicalModelConfigs, resolveLogicalModelId } from '../config.js';
import {
  getMetadataMode,
  parseClientMeta,
  recordClientMeta,
  warnMissingMetadataOnce,
} from '../core/client-meta.js';
import { checkLoop, estimateInputTokens } from '../core/loop-guard.js';
import { getTenant, resolveLoopLimits } from '../core/tenants.js';
import { getTenantRouteConfig } from '../core/byok-defaults.js';
import { checkTenantRate } from '../core/tenant-rate.js';
import {
  budgetTokensFromUsage,
  isOverBudget,
  recordBudgetUsage,
  warnBudgetOnce,
} from '../core/budget.js';
import { forwardChat } from '../core/forwarder.js';
import { applyUncensoredOverlay } from '../core/overlay.js';
import { wantsReasoningShown } from '../core/thinking.js';
import { providerLabel } from '../core/provider-label.js';
import {
  AuthType,
  extractClientIp,
  extractPreview,
  formatKeyHint,
  hasImageContent,
  hasToolCallsOrDefinitions,
  recordRequest,
  RequestLogRecord,
} from '../core/request-log.js';
import { ChatCompletionRequest, LOGICAL_MODEL_IDS, PoolEntry } from '../types.js';

export const chatRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: ChatCompletionRequest }>(
    '/v1/chat/completions',
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

      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        finishRecord({ tier: body.model, status: 400, errorCode: 'missing_messages' });
        return reply.status(400).send({
          error: {
            message: 'Missing or empty "messages" array in request body',
            type: 'invalid_request_error',
            param: 'messages',
            code: 'missing_messages',
          },
        });
      }

      // Populate parsed request context
      ctx.tier = body.model;
      ctx.msgs = body.messages.length;
      ctx.chars = JSON.stringify(body.messages).length;
      ctx.hasTools = hasToolCallsOrDefinitions(body);
      ctx.hasImages = hasImageContent(body.messages);
      ctx.preview = extractPreview(body.messages);
      ctx.stream = Boolean(body.stream);

      const logicalId = resolveLogicalModelId(body.model);
      if (!logicalId) {
        finishRecord({ status: 404, errorCode: 'model_not_found' });
        return reply.status(404).send({
          error: {
            message: `Model "${body.model}" not found. Supported logical models: ${LOGICAL_MODEL_IDS.join(', ')}`,
            type: 'invalid_request_error',
            param: 'model',
            code: 'model_not_found',
          },
        });
      }

      // Parse client metadata headers: x-router-app, x-router-agent, x-router-session
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

      const tenantRec = getTenant(tenantId);
      const isByok = tenantRec?.mode === 'byok';

      const configs = loadLogicalModelConfigs();
      const baseRouteConfig = configs[logicalId];
      const routeConfig = isByok && baseRouteConfig
        ? getTenantRouteConfig(tenantId, logicalId, baseRouteConfig)
        : baseRouteConfig;

      if (!routeConfig || routeConfig.pool.length === 0) {
        if (isByok) {
          finishRecord({ status: 503, errorCode: 'byok_no_models' });
          return reply.status(503).send({
            error: {
              message: `No admitted models available for logical route "${logicalId}" for this BYOK client`,
              type: 'invalid_request_error',
              code: 'byok_no_models',
            },
          });
        }
        finishRecord({ status: 503, errorCode: 'tier_unavailable' });
        return reply.status(503).send({
          error: {
            message: `No physical models currently configured for logical tier "${logicalId}"`,
            type: 'invalid_request_error',
            code: 'tier_unavailable',
          },
        });
      }

      // Loop guard check: per-session sliding window (rate, volume, repeat)
      const sessionKey = `${tenantId}|${meta.app ?? '?'}|${meta.agent ?? '?'}|${meta.session ?? '?'}`;
      const outLimit = (body as any).max_completion_tokens ?? (body as any).max_tokens;
      const loopLimits = resolveLoopLimits(tenantId, meta.agent);
      const loopResult = checkLoop(sessionKey, body.messages, {
        repeatSalt: typeof outLimit === 'number' ? `max_tokens=${outLimit}` : undefined,
        dryRun: !meta.complete,
        limits: loopLimits,
        agent: meta.agent,
      });

      if (loopResult.blocked) {
        reply.header('retry-after', loopResult.retryAfterSec);
        reply.header('x-router-loop', loopResult.rule);
        if (loopResult.rule === 'rate') {
          finishRecord({ status: 429, errorCode: 'rate_limited', loopRule: 'rate' });
          return reply.status(429).send({
            error: {
              message: `Session request rate exceeded (${loopResult.details}). Retry after ${loopResult.retryAfterSec}s.`,
              type: 'rate_limit_error',
              code: 'rate_limited',
            },
          });
        }
        finishRecord({ status: 429, errorCode: 'loop_detected', loopRule: loopResult.rule });
        return reply.status(429).send({
          error: {
            message: `Loop detected for this session (${loopResult.rule}: ${loopResult.details}). Blocked until ${loopResult.until}. Do not retry — stop the agent loop.`,
            type: 'rate_limit_error',
            code: 'loop_detected',
          },
        });
      }

      // Check MiniMax budget limits (skipped for BYOK clients). When over budget, exclude MiniMax direct entries
      // and exclude ollama-cloud unless the tier is uncensored, and exclude local ollama on text-high.
      const budgetOver = isByok ? null : isOverBudget(tenantId, undefined, meta.user);
      let excludeEntry: ((e: PoolEntry) => boolean) | undefined;
      if (budgetOver) {
        warnBudgetOnce(tenantId, budgetOver.reason, meta.user);
        ctx.budgetExceeded = budgetOver.reason;
        excludeEntry = (e: PoolEntry) => {
          if (e.budgetGroup === 'minimax') return true;
          if (e.provider === 'ollama-cloud' && routeConfig.censored !== false) return true;
          if (e.provider === 'ollama' && routeConfig.modality === 'text' && routeConfig.tier === 'high') return true;
          return false;
        };
      }

      // Auto-inject the uncensored system overlay for *-uncensored-* tiers so
      // clients don't each have to carry it (the models refuse bare explicit).
      // Opt out per request with `x-router-no-overlay: 1` or per tenant with `overlay: 'off'`.
      // Force in per request with `x-router-overlay: 1` even if tenant has `overlay: 'off'`.
      // If both headers are sent, no-overlay wins.
      const noOverlay =
        req.headers['x-router-no-overlay'] === '1' ||
        req.headers['x-router-no-overlay'] === 'true';
      const forceOverlay =
        req.headers['x-router-overlay'] === '1' ||
        req.headers['x-router-overlay'] === 'true';
      const skipOverlay = noOverlay || (tenantRec?.overlay === 'off' && !forceOverlay);
      if (!skipOverlay) {
        const overlaid = applyUncensoredOverlay(routeConfig, body.messages);
        if (overlaid !== body.messages) {
          body.messages = overlaid;
          ctx.overlay = true;
        }
      }

      // Reasoning is stripped from answers unless the client opts in.
      const keepReasoning =
        req.headers['x-router-reasoning'] === '1' ||
        req.headers['x-router-reasoning'] === 'true' ||
        wantsReasoningShown(body);

      let streamErrorCode: string | undefined;
      const forwardResult = await forwardChat(logicalId, routeConfig, body, tenantId, {
        excludeEntry,
        excludeReason: budgetOver?.reason,
        keepReasoning,
        thinkingWithTools: tenantRec?.thinkingWithTools,
        onError: (code) => {
          streamErrorCode = code;
        },
      });

      if (!forwardResult.ok) {
        if (missingMetaWarning) {
          reply.header('x-router-warning', 'missing-metadata');
        }
        if (forwardResult.retryAfter) {
          reply.header('retry-after', forwardResult.retryAfter);
        }
        if (forwardResult.via) {
          reply
            .header('x-router-model', forwardResult.via.model)
            .header('x-router-provider', providerLabel(forwardResult.via))
            .header('x-router-backend', forwardResult.via.id)
            .header('x-pf-backend', forwardResult.via.id)
            .header('x-pf-backend-model', forwardResult.via.model);
          if (forwardResult.via.contextLength !== undefined) {
            reply.header('x-router-context-length', forwardResult.via.contextLength);
          }
        }
        if (budgetOver) {
          reply.header('x-router-budget', `exceeded; reason=${budgetOver.reason}`);
          finishRecord({
            status: 503,
            errorCode: 'budget_exceeded',
            failoverCount: forwardResult.failoverCount,
            backend: forwardResult.via?.id,
            physicalModel: forwardResult.via?.model,
          });
          return reply.status(503).send({
            error: {
              message: `MiniMax budget exceeded for this client (${budgetOver.reason}) and fallback backends were unavailable`,
              type: 'rate_limit_error',
              code: 'budget_exceeded',
            },
          });
        }
        finishRecord({
          status: forwardResult.status || 502,
          errorCode: (forwardResult.error as any)?.code || 'api_error',
          failoverCount: forwardResult.failoverCount,
          backend: forwardResult.via?.id,
          physicalModel: forwardResult.via?.model,
        });
        return reply.status(forwardResult.status || 502).send({
          error: forwardResult.error || {
            message: 'Upstream generation failed',
            type: 'api_error',
          },
        });
      }

      // Which physical backend actually served this request. Logged here and
      // echoed to the caller so the portal's audit trail can record the real
      // model behind a logical tier (e.g. text-high → gemini vs deepseek-pro).
      const backendId = forwardResult.via?.id || '';
      const backendModel = forwardResult.via?.model || '';

      const logRequest = () => {
        const u = forwardResult.usage;
        console.log(
          `[router] ${tenantId} ${body.model} → ${backendId} (${backendModel})` +
            (forwardResult.failoverCount ? ` failover=${forwardResult.failoverCount}` : '') +
            ` msgs=${body.messages?.length ?? 0} chars=${JSON.stringify(body.messages ?? []).length}` +
            (body.stream ? ' stream' : '') +
            ` in=${u?.prompt_tokens ?? '?'} out=${u?.completion_tokens ?? '?'}` +
            ` app=${meta.app ?? '-'} agent=${meta.agent ?? '-'} session=${meta.session ?? '-'}`
        );

        // Record MiniMax token budget consumption (skipped for BYOK clients)
        if (!isByok && forwardResult.via?.budgetGroup === 'minimax') {
          const budgetTokens = budgetTokensFromUsage(
            forwardResult.usage,
            estimateInputTokens(body.messages)
          );
          recordBudgetUsage(tenantId, budgetTokens, undefined, meta.user);
        }
      };

      // Handle streaming SSE
      if (body.stream && forwardResult.stream) {
        reply.hijack();
        const sseHeaders: Record<string, string> = {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'x-pf-backend': backendId,
          'x-pf-backend-model': backendModel,
        };
        if (forwardResult.via) {
          sseHeaders['x-router-model'] = forwardResult.via.model;
          sseHeaders['x-router-provider'] = providerLabel(forwardResult.via);
          sseHeaders['x-router-backend'] = forwardResult.via.id;
          if (forwardResult.via.contextLength !== undefined) {
            sseHeaders['x-router-context-length'] = String(forwardResult.via.contextLength);
          }
        }
        if (missingMetaWarning) {
          sseHeaders['x-router-warning'] = 'missing-metadata';
        }
        if (budgetOver) {
          sseHeaders['x-router-budget'] = `exceeded; reason=${budgetOver.reason}`;
        }
        reply.raw.writeHead(200, sseHeaders);

        const reader = forwardResult.stream.getReader();

        let clientDisconnected = false;
        let firstByteTime: number | null = null;

        req.raw.on('close', () => {
          clientDisconnected = true;
          reader.cancel('client_disconnected').catch(() => {});
        });

        try {
          while (!clientDisconnected) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              if (!firstByteTime) {
                firstByteTime = Date.now();
                ctx.ttfbMs = firstByteTime - startTime;
              }
              reply.raw.write(value);
            }
          }
        } catch (streamErr) {
          if (!clientDisconnected) {
            console.error('[chat] Stream piping error:', streamErr);
          }
        } finally {
          if (!reply.raw.writableEnded) {
            reply.raw.end();
          }
          logRequest();
          const u = forwardResult.usage;
          const pTokens = typeof u?.prompt_tokens === 'number' ? u.prompt_tokens : undefined;
          const cTokens = typeof u?.completion_tokens === 'number' ? u.completion_tokens : undefined;
          const rawReasoning = (u as any)?.completion_tokens_details?.reasoning_tokens ?? (u as any)?.reasoning_tokens;
          const rTokens = typeof rawReasoning === 'number' ? rawReasoning : undefined;
          const cachedTokens = u ? budgetTokensFromUsage(u, 0).cached : undefined;

          finishRecord({
            status: 200,
            errorCode: streamErrorCode,
            backend: backendId,
            physicalModel: backendModel,
            failoverCount: forwardResult.failoverCount,
            promptTokens: pTokens,
            completionTokens: cTokens,
            cachedTokens,
            reasoningTokens: rTokens,
          });
        }
        return reply;
      }

      // Handle non-streaming JSON
      logRequest();
      const u = forwardResult.usage;
      const pTokens = typeof u?.prompt_tokens === 'number' ? u.prompt_tokens : undefined;
      const cTokens = typeof u?.completion_tokens === 'number' ? u.completion_tokens : undefined;
      const rawReasoning = (u as any)?.completion_tokens_details?.reasoning_tokens ?? (u as any)?.reasoning_tokens;
      const rTokens = typeof rawReasoning === 'number' ? rawReasoning : undefined;
      const cachedTokens = u ? budgetTokensFromUsage(u, 0).cached : undefined;

      finishRecord({
        status: 200,
        backend: backendId,
        physicalModel: backendModel,
        failoverCount: forwardResult.failoverCount,
        promptTokens: pTokens,
        completionTokens: cTokens,
        cachedTokens,
        reasoningTokens: rTokens,
      });

      if (missingMetaWarning) {
        reply.header('x-router-warning', 'missing-metadata');
      }
      if (budgetOver) {
        reply.header('x-router-budget', `exceeded; reason=${budgetOver.reason}`);
      }
      if (forwardResult.via) {
        reply
          .header('x-router-model', forwardResult.via.model)
          .header('x-router-provider', providerLabel(forwardResult.via))
          .header('x-router-backend', forwardResult.via.id);
        if (forwardResult.via.contextLength !== undefined) {
          reply.header('x-router-context-length', forwardResult.via.contextLength);
        }
      }
      return reply
        .status(200)
        .header('x-pf-backend', backendId)
        .header('x-pf-backend-model', backendModel)
        .send(forwardResult.data);
    }
  );
};
