import { createHash } from 'node:crypto';

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
  port: Number(process.env.PORT ?? 3000),
  databasePath: process.env.DATABASE_PATH?.trim() || './data/sweep.db',
  publicUrl: (process.env.PUBLIC_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, ''),
  sessionSecret:
    process.env.SESSION_SECRET?.trim() ||
    createHash('sha256').update('asana-sweep:' + required('DASHBOARD_PASSWORD')).digest('hex'),
  runRetentionDays: 90,
  asanaBaseUrl: (process.env.ASANA_BASE_URL?.trim() || 'https://app.asana.com/api/1.0').replace(/\/+$/, ''),
};
