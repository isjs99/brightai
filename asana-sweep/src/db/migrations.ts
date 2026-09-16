import type Database from 'better-sqlite3';

interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial schema and seed rule',
    up(db) {
      db.exec(`
        CREATE TABLE rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          asana_project_gid TEXT NOT NULL,
          asana_project_name TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1,
          cron TEXT NOT NULL,
          timezone TEXT NOT NULL DEFAULT 'Europe/Madrid',
          dry_run INTEGER NOT NULL DEFAULT 1,
          min_age_hours INTEGER NOT NULL DEFAULT 12,
          require_section_match INTEGER NOT NULL DEFAULT 1,
          max_deletes_per_run INTEGER NOT NULL DEFAULT 50,
          notify_slack_webhook TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rule_id INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          status TEXT NOT NULL CHECK (status IN ('running','ok','error','dry_run')),
          trigger TEXT NOT NULL DEFAULT 'schedule',
          dry_run INTEGER NOT NULL DEFAULT 0,
          scanned_count INTEGER NOT NULL DEFAULT 0,
          matched_count INTEGER NOT NULL DEFAULT 0,
          deleted_count INTEGER NOT NULL DEFAULT 0,
          error_message TEXT,
          warnings TEXT NOT NULL DEFAULT '[]'
        );
        CREATE INDEX runs_rule_started ON runs(rule_id, started_at DESC);

        CREATE TABLE run_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          task_gid TEXT NOT NULL,
          task_name TEXT NOT NULL,
          section_name TEXT,
          completed_at TEXT,
          num_subtasks INTEGER NOT NULL DEFAULT 0,
          action TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX run_items_run ON run_items(run_id);
      `);

      // Seed the pilot rule. Left in dry run on purpose: flip it to live from the dashboard.
      db.prepare(
        `INSERT INTO rules (name, asana_project_gid, asana_project_name, enabled, cron, timezone, dry_run,
                            min_age_hours, require_section_match, max_deletes_per_run)
         VALUES (?, ?, ?, 1, ?, ?, 1, 12, 1, 50)`,
      ).run(
        'GreatVita AM Daily Checklist (Pilot)',
        '1216709753301754',
        'GreatVita - AM Daily Checklist (Pilot)',
        '30 6 * * 1-5',
        'Europe/Madrid',
      );
    },
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as { version: number }).version));
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
    })();
  }
}
