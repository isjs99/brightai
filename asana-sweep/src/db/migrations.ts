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
  {
    version: 2,
    name: 'accounts, checklist checks, settings',
    up(db) {
      db.exec(`
        CREATE TABLE accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          markets TEXT,
          am_name TEXT,
          aa_name TEXT,
          asana_project_gid TEXT,
          asana_project_name TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1,
          notes TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT
        );

        CREATE TABLE checks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          check_date TEXT NOT NULL,
          checked_at TEXT NOT NULL,
          trigger TEXT NOT NULL DEFAULT 'schedule',
          status TEXT NOT NULL,
          am_total INTEGER NOT NULL DEFAULT 0,
          am_done INTEGER NOT NULL DEFAULT 0,
          aa_total INTEGER NOT NULL DEFAULT 0,
          aa_done INTEGER NOT NULL DEFAULT 0,
          am_complete INTEGER NOT NULL DEFAULT 0,
          aa_complete INTEGER NOT NULL DEFAULT 0,
          combined_complete INTEGER NOT NULL DEFAULT 0,
          warnings TEXT NOT NULL DEFAULT '[]',
          error_message TEXT,
          items TEXT NOT NULL DEFAULT '[]',
          UNIQUE(account_id, check_date)
        );
        CREATE INDEX checks_date ON checks(check_date);
      `);

      const ins = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`);
      ins.run('check_cron', '0 16 * * 1-5');
      ins.run('check_timezone', 'Europe/Madrid');
      ins.run('check_enabled', '1');
      ins.run('check_slack_webhook', '');

      // Account roster (Sept 2026). Linked to the checklist projects that already exist in Asana.
      const acc = db.prepare(
        `INSERT INTO accounts (name, markets, am_name, aa_name, asana_project_gid, asana_project_name, notes)
         VALUES (?, ?, ?, ?, ?, COALESCE(?, ''), ?)`,
      );
      const roster: (string | null)[][] = [
        ['Super Ninja', 'DE/IT/ES/FR/BE/NL', 'Elena', null, '1217145492095942', 'Super Ninja - AM Daily Checklist', 'OCT PAUSE'],
        ['Feel Güd', 'DE/IT/FR/ES', 'Giorgia', null, '1217145492095987', 'FeelGüd - AM Daily Checklist', null],
        ['Waschies', 'DE', 'Federica', null, null, null, null],
        ['Satin Naturel', 'DE', 'Federica', null, null, null, null],
        ['Kijimea', 'DE/IT/FR/ES/UK/PL', 'Federica', null, null, null, null],
        ['GreatVita', 'DE/IT/FR/ES', 'Elena', 'DM', '1216709753301754', 'GreatVita - AM Daily Checklist (Pilot)', null],
        ['Mothersearth', 'DE/NL/UK', 'Tamara', null, null, null, null],
        ['Clearly', 'DE', 'Tamara', null, '1218453485943205', 'Clearly - AM Daily Checklist', null],
        ['Svenja', 'UK', 'Federica', null, null, null, null],
        ['Muehlenkraft', 'DE', 'Federica', null, null, null, null],
        ['Belively', 'DE', 'Michael', null, null, null, null],
        ['Estrid', 'DE/UK/FR/IT/ES/IE/NL/BE/AT/PL', 'Tamara', null, '1217270139323267', 'AM Daily Checklist Estrid', null],
        ['Evolsin', 'DE/FR', 'Elena', null, '1217145492095927', 'Evolsin - AM Daily Checklist', null],
        ['Mars', 'UK', 'Federica', null, null, null, null],
        ['Living Things', 'UK', 'Giorgia', null, '1217145492095957', 'Living Things - AM Daily Checklist', null],
        ['Chupa Chups', 'DE', 'Elena', null, '1217145492095972', 'Chupa Chups - AM Daily Checklist', null],
        ['Golden Tree', 'DE', 'Michael', null, null, null, null],
        ['BioPak', 'DE', null, null, null, null, null],
        ['BiFi', 'DE', 'Tamara', null, null, null, null],
        ['VeoBabys', 'IT', 'Giorgia', null, null, null, null],
        ['Bears With Benefits', 'IT', 'Giorgia', null, '1217239903735088', 'BWB AM Daily Checklist', null],
        ['Nutrivita (Dr Nutrition)', null, 'Michael', null, null, null, null],
        ['French Avenue', null, null, null, null, null, null],
        ['My Protein', 'DE', 'Tamara', null, null, null, null],
        ['Vaseline', null, 'Elena', null, null, null, null],
        ['Sacheu', 'DE/IT/FR/ES/N/IE', 'Federica', null, null, null, null],
        ['Unilever', 'DE/IT/FR/ES/N', 'Elena', null, null, null, null],
        ['Coca Cola', 'DE', 'Tamara', null, null, null, null]
      ];
      for (const r of roster) acc.run(...r);
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
