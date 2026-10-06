import fs from 'node:fs';
import path from 'node:path';
import { FastifyPluginAsync } from 'fastify';

// Public client guide at /docs — the link owners hand to new projects together
// with their key. No auth and no secrets: it only documents the public API.
// Read once; the file ships in the image (Dockerfile copies public/).
const GUIDE_PATH = path.resolve(process.cwd(), 'public', 'client-guide.html');
let cached: string | null = null;

function loadGuide(): string | null {
  if (cached === null) {
    try {
      cached = fs.readFileSync(GUIDE_PATH, 'utf8');
    } catch {
      return null;
    }
  }
  return cached;
}

export const docsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/docs', async (_req, reply) => {
    const html = loadGuide();
    if (!html) return reply.status(404).type('text/plain; charset=utf-8').send('Guide not found');
    return reply
      .header('cache-control', 'public, max-age=300')
      .type('text/html; charset=utf-8')
      .send(html);
  });
};
