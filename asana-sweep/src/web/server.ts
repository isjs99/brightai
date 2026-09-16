import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queries } from '../db/queries.js';
import { Scheduler } from '../scheduler/index.js';
import { SharedPasswordAuth } from './auth.js';
import { buildRouter } from './routes.js';

export function createApp(q: Queries, scheduler: Scheduler) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  const auth = new SharedPasswordAuth();
  app.use('/api', buildRouter(q, scheduler, auth));

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
