import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queries } from '../db/queries.js';
import { Scheduler } from '../scheduler/index.js';
import { LiveWatcher } from '../live/index.js';
import { SharedPasswordAuth } from './auth.js';
import { buildRouter } from './routes.js';

export function createApp(q: Queries, scheduler: Scheduler, live: LiveWatcher) {
  const app = express();
  app.disable('x-powered-by');
  // Hosted behind a reverse proxy (Railway, Fly, nginx): trust it for client IPs and https detection.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '256kb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  const auth = new SharedPasswordAuth();
  app.use('/api', buildRouter(q, scheduler, auth, live));

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
