import { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../auth/middleware.js';
import { EMBEDDING_MODEL_IDS, LOGICAL_MODEL_IDS } from '../types.js';
import { getEmbeddingModelConfigs, loadLogicalModelConfigs } from '../config.js';

export const modelsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/v1/models', { preHandler: requireAuth }, async (_req, reply) => {
    const configs = loadLogicalModelConfigs();
    const embedConfigs = getEmbeddingModelConfigs();
    const now = Math.floor(Date.now() / 1000);

    const modelList = LOGICAL_MODEL_IDS.map((id) => {
      const cfg = configs[id];
      const enabledPool = (cfg?.pool || []).filter((e) => e.enabled !== false);
      const withCtx = enabledPool
        .map((e) => e.contextLength)
        .filter((c): c is number => typeof c === 'number');
      const contextLengthMin = withCtx.length > 0 ? Math.min(...withCtx) : undefined;
      const contextLengthUnknown = enabledPool.length === 0 || enabledPool.some((e) => e.contextLength === undefined);

      return {
        id,
        object: 'model' as const,
        created: now,
        owned_by: process.env.ROUTER_OWNER || 'model-router',
        permission: [],
        root: id,
        parent: null,
        description: cfg?.description || id,
        modality: cfg?.modality || 'text',
        tier: cfg?.tier || 'low',
        censored: cfg?.censored ?? true,
        ...(contextLengthMin !== undefined ? { context_length_min: contextLengthMin } : {}),
        ...(contextLengthUnknown ? { context_length_unknown: true } : {}),
      };
    });

    const embedList = EMBEDDING_MODEL_IDS.map((id) => {
      const cfg = embedConfigs[id];
      return {
        id,
        object: 'model' as const,
        created: now,
        owned_by: process.env.ROUTER_OWNER || 'model-router',
        permission: [],
        root: id,
        parent: null,
        description: cfg?.description || id,
        modality: 'embedding' as const,
        dims: cfg?.dims ?? 1024,
      };
    });

    return reply.status(200).send({
      object: 'list',
      data: [...modelList, ...embedList],
    });
  });
};
