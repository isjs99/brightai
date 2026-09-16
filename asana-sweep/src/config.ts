import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load KEY=VALUE pairs from a .env file in the working directory into process.env.
 * Variables already set in the environment win, so Docker / shell exports override the file.
 */
function loadDotEnv(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required environment variable ${name}. See .env.example.`);
  }
  return v.trim();
}

export const config = {
  asanaPat: process.env.ASANA_PAT?.trim() ?? '',
  dashboardPassword: required('DASHBOARD_PASSWORD'),
  /** Optional second password that signs in with the read-only "account manager" role. */
  amPassword: process.env.AM_PASSWORD?.trim() ?? '',
  port: Number(process.env.PORT ?? 3000),
  databasePath: process.env.DATABASE_PATH?.trim() || './data/sweep.db',
  publicUrl: (process.env.PUBLIC_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, ''),
  sessionSecret:
    process.env.SESSION_SECRET?.trim() ||
    createHash('sha256').update('asana-sweep:' + required('DASHBOARD_PASSWORD')).digest('hex'),
  runRetentionDays: 90,
  asanaBaseUrl: (process.env.ASANA_BASE_URL?.trim() || 'https://app.asana.com/api/1.0').replace(/\/+$/, ''),
};
