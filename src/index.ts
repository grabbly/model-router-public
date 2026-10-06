import cors from '@fastify/cors';
import Fastify, { FastifyInstance } from 'fastify';
import { CONFIG, loadLogicalModelConfigs, loadRawLogicalModelConfigs } from './config.js';
import { saveBudgetSync } from './core/budget.js';
import { saveTenantUsageSync } from './core/tenant-rate.js';
import { startMinimaxRemainsPoller, stopMinimaxRemainsPoller } from './core/provider-quota.js';
import { flushRequestLogSync } from './core/request-log.js';
import { startProberLoop } from './core/prober.js';
import { startRetirementCheckerLoop } from './core/retirement.js';
import { startCatalogPoller, stopCatalogPoller } from './core/catalog.js';
import { updateAllPreselections } from './core/selector.js';
import { startNotifier, stopNotifier } from './core/notify.js';
import { startWatchScheduler, stopWatchScheduler } from './core/watch.js';
import { adminRoutes } from './routes/admin.js';
import { budgetRoutes } from './routes/budget.js';
import { chatRoutes } from './routes/chat.js';
import { docsRoutes } from './routes/docs.js';
import { embeddingsRoutes } from './routes/embeddings.js';
import { healthRoutes } from './routes/health.js';
import { modelsRoutes } from './routes/models.js';

export function buildApp(): FastifyInstance {
  const fastify = Fastify({
    logger:
      process.env.NODE_ENV === 'test'
        ? false
        : {
            level: process.env.LOG_LEVEL || 'info',
            transport:
              process.env.NODE_ENV !== 'production'
                ? {
                    target: 'pino-pretty',
                    options: { colorize: true },
                  }
                : undefined,
          },
    // Vision requests carry base64 image data-URIs. MiniMax accepts images up
    // to 10MB; base64 inflates that ~33%. Fastify's default bodyLimit (1MB)
    // rejects them with 413, so raise it.
    bodyLimit: Number(process.env.ROUTER_BODY_LIMIT_BYTES || 20 * 1024 * 1024),
  });

  fastify.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  fastify.register(healthRoutes);
  fastify.register(modelsRoutes);
  fastify.register(chatRoutes);
  fastify.register(embeddingsRoutes);
  fastify.register(budgetRoutes);
  fastify.register(docsRoutes);
  fastify.register(adminRoutes);

  return fastify;
}

async function startServer() {
  const app = buildApp();
  const configs = loadLogicalModelConfigs();

  // Initialize initial pre-selections
  updateAllPreselections(configs);

  // Start background loops
  const prober = startProberLoop(() => loadLogicalModelConfigs(), CONFIG.probeIntervalSeconds);
  const retirementChecker = startRetirementCheckerLoop(
    () => loadLogicalModelConfigs(),
    CONFIG.retirementCheckIntervalSeconds
  );
  const catalogPoller = startCatalogPoller(
    () => loadRawLogicalModelConfigs(),
    CONFIG.catalogIntervalSec
  );
  startMinimaxRemainsPoller();
  startNotifier();
  startWatchScheduler();

  // Run first probe cycle immediately in background
  prober.runNow().then(() => {
    updateAllPreselections(loadLogicalModelConfigs());
  }).catch((err) => {
    app.log.warn({ err }, 'Initial probe cycle failed');
  });

  // Graceful shutdown
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, async () => {
      app.log.info(`Received ${signal}, shutting down gracefully...`);
      prober.stop();
      retirementChecker.stop();
      catalogPoller.stop();
      stopCatalogPoller();
      stopMinimaxRemainsPoller();
      stopNotifier();
      stopWatchScheduler();
      saveBudgetSync();
      saveTenantUsageSync();
      flushRequestLogSync();
      await app.close();
      process.exit(0);
    });
  }

  try {
    const address = await app.listen({ port: CONFIG.port, host: CONFIG.host });
    app.log.info(`Model Router listening at ${address}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== 'test' && import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
