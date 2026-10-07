import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { runMigrations } from './migrations.js';

export type DB = Database.Database;

let instance: DB | null = null;

export function openDb(path: string = config.databasePath): DB {
  if (instance) return instance;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  // WAL with NORMAL: the log is flushed at checkpoints rather than on every commit. Safe against an app crash
  // (the OS keeps the WAL); on a network volume FULL made every small write a disk round trip that held the server.
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  instance = db;
  return db;
}

export function getDb(): DB {
  if (!instance) throw new Error('Database not opened yet');
  return instance;
}

/** For tests: open a fresh in-memory database that is not shared with the singleton. */
export function openTestDb(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
