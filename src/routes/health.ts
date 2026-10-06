import { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/healthz', async (_req, reply) => {
    return reply.status(200).send({
      status: 'ok',
      service: 'model-router',
      uptime: process.uptime(),
      timestamp: Date.now(),
    });
  });
};
