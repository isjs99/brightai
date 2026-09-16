import { config } from './config.js';
import { openDb } from './db/index.js';
import { Queries } from './db/queries.js';
import { log } from './logger.js';
import { Scheduler } from './scheduler/index.js';
import { LiveWatcher } from './live/index.js';
import { createApp } from './web/server.js';

const db = openDb();
const q = new Queries(db);
const stale = q.failStaleRuns();
if (stale) log.warn(`Marked ${stale} interrupted run(s) as errored`);
q.failStaleGmvSyncs();

const scheduler = new Scheduler(q);
scheduler.start();

if (!config.asanaPat) log.warn('ASANA_PAT is not set. Runs and previews will fail until it is.');

const live = new LiveWatcher(q);
if (config.asanaPat) live.start();

const app = createApp(q, scheduler, live);
const server = app.listen(config.port, () => log.info(`Dashboard listening on ${config.publicUrl} (port ${config.port})`));

const shutdown = () => {
  log.info('Shutting down');
  live.stop();
  scheduler.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
