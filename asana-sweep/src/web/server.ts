import { recordRequest } from '../perf.js';
import compression from 'compression';
import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queries } from '../db/queries.js';
import { Scheduler } from '../scheduler/index.js';
import { SharedPasswordAuth } from './auth.js';
import { buildRouter } from './routes.js';
import { handleMcp } from './mcp.js';

export function createApp(q: Queries, scheduler: Scheduler) {
  const app = express();
  app.disable('x-powered-by');
  // Hosted behind a reverse proxy (Railway, Fly, nginx): trust it for client IPs and https detection.
  app.set('trust proxy', 1);
  // Gzip anything over 1 KB: the pipeline and monitor payloads are megabytes of JSON that shrink about ten times.
  // The live-update stream must not be buffered by it.
  app.use(compression({ threshold: 1024, filter: (req, res) => req.path !== '/api/events' && req.headers.accept !== 'text/event-stream' && compression.filter(req, res) }));
  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => recordRequest(req.method, req.path, Number(process.hrtime.bigint() - started) / 1e6));
    next();
  });
  app.use((_req, res, next) => {
    // SAMEORIGIN rather than DENY: the Pitch designer previews its own deck in an iframe; other sites still cannot frame us.
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  const auth = new SharedPasswordAuth();
  app.use('/api', buildRouter(q, scheduler, auth));
  // The dashboard as an MCP server for Claude Code, Cowork and the Claude apps (bearer tokens from the environment).
  app.all('/mcp', (req, res) => void handleMcp(q, scheduler, req, res));

  // Built front end (dist/client). In dev, Vite serves the client on :5173 and proxies /api here.
  const here = dirname(fileURLToPath(import.meta.url));
  const clientDir = [join(here, '../../client'), join(here, '../../../dist/client')].find((d) => existsSync(join(d, 'index.html')));
  if (clientDir) {
    app.use(express.static(clientDir, { index: false }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      res.sendFile(join(clientDir, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => res.type('text').send('Dashboard not built. Run `npm run build` or use `npm run dev`.'));
  }

  return app;
}
