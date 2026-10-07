import { config } from './config.js';
import { openDb } from './db/index.js';
import { Queries } from './db/queries.js';
import { log } from './logger.js';
import { installLlm } from './llm/usage.js';
import { startPerfMonitor } from './perf.js';
import { Scheduler } from './scheduler/index.js';
import { createApp } from './web/server.js';

const db = openDb();
const q = new Queries(db);
q.failStaleGmvSyncs();
installLlm(q);
startPerfMonitor();

const scheduler = new Scheduler(q);

// Listen first, then start the jobs: the health check and the pages answer while the boot work (pulls import,
// enterprise alerts, the first syncs) runs, instead of waiting behind it.
const app = createApp(q, scheduler);
const server = app.listen(config.port, () => {
  log.info(`Dashboard listening on ${config.publicUrl} (port ${config.port}), build ${process.env.GIT_SHA?.trim() || "dev"}`);
  setImmediate(() => { try { scheduler.start(); } catch (err) { log.error(`Scheduler start failed: ${(err as Error).message}`); } });
});

const shutdown = () => {
  log.info('Shutting down');
  scheduler.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
