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
  {
    version: 3,
    name: 'sweep rule for every linked checklist board, rules live',
    up(db) {
      // Every account with a linked checklist project gets its own sweep rule.
      const accounts = db.prepare(`SELECT name, asana_project_gid, asana_project_name FROM accounts WHERE asana_project_gid IS NOT NULL`).all() as {
        name: string;
        asana_project_gid: string;
        asana_project_name: string;
      }[];
      const exists = db.prepare(`SELECT 1 FROM rules WHERE asana_project_gid = ?`);
      const ins = db.prepare(
        `INSERT INTO rules (name, asana_project_gid, asana_project_name, enabled, cron, timezone, dry_run, min_age_hours, require_section_match, max_deletes_per_run)
         VALUES (?, ?, ?, 1, '30 6 * * 1-5', 'Europe/Madrid', 0, 12, 1, 50)`,
      );
      for (const a of accounts) {
        if (!exists.get(a.asana_project_gid)) ins.run(`${a.name} AM Daily Checklist`, a.asana_project_gid, a.asana_project_name);
      }
      // Sweeps are live from here on. Toggle a rule back to dry run from the dashboard if needed.
      db.exec(`UPDATE rules SET dry_run = 0`);
    },
  },
  {
    version: 4,
    name: 'people, slack reminders, cruva shops, gmv, targets',
    up(db) {
      db.exec(`
        CREATE TABLE people (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL DEFAULT 'am',
          email TEXT,
          slack_user_id TEXT,
          notify INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE account_shops (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          shop_id TEXT NOT NULL UNIQUE,
          shop_name TEXT NOT NULL,
          currency TEXT NOT NULL DEFAULT '$'
        );
        CREATE INDEX account_shops_account ON account_shops(account_id);

        CREATE TABLE gmv_daily (
          shop_id TEXT NOT NULL,
          date TEXT NOT NULL,
          total_gmv REAL NOT NULL DEFAULT 0,
          affiliate_gmv REAL NOT NULL DEFAULT 0,
          units INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL DEFAULT 'cruva',
          synced_at TEXT NOT NULL,
          PRIMARY KEY (shop_id, date)
        );
        CREATE INDEX gmv_daily_date ON gmv_daily(date);

        CREATE TABLE gmv_targets (
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          month TEXT NOT NULL,
          target REAL NOT NULL,
          PRIMARY KEY (account_id, month)
        );

        CREATE TABLE gmv_syncs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          status TEXT NOT NULL,
          shops_synced INTEGER NOT NULL DEFAULT 0,
          error_message TEXT
        );
      `);

      const set = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
      set.run('notify_ams_enabled', '0');
      set.run('reminder_cron', '0 14 * * 1-5');
      set.run('gmv_sync_cron', '15 7 * * *');
      set.run('gmv_sync_enabled', '1');
      set.run('gmv_currency', '$');
      set.run('grade_weight_checklist', '50');

      const person = db.prepare(`INSERT INTO people (name, role, email) VALUES (?, 'am', ?)`);
      person.run('Elena', null);
      person.run('Giorgia', null);
      person.run('Federica', 'federica@brightform.agency');
      person.run('Tamara', 'tamara@brightform.agency');
      person.run('Michael', null);

      // Cruva shops mapped to accounts (Sept 2026 shop list).
      const shops: [string, string, string][] = [
        ['GreatVita', '698ca8a11bc07d2529d16d1d', 'GreatVita'],
        ['GreatVita', '69b466a66a87a28634003922', 'GreatVita IT'],
        ['GreatVita', '69b466bfe9a698de0d9680f4', 'GreatVita ES'],
        ['GreatVita', '69b466d09f5f26acb7cf47e0', 'GreatVita FR'],
        ['Kijimea', '6936d165342cc96175676f97', 'Kijimea IT'],
        ['Kijimea', '695e3b547f18f1f9c8f17d52', 'Kijimea ES'],
        ['Kijimea', '695e50332c966c6dc08d5d30', 'Kijimea FR'],
        ['Kijimea', '69738844a366ac9d3bf84d42', 'Kijimea DE'],
        ['Kijimea', '6985b35d46b2ba3420639349', 'Kijimea UK'],
        ['Kijimea', '6a4bc4c9980f3d46f4560f3a', 'Kijimea PL'],
        ['Svenja', '695d1e81777760f97753dbf3', 'Svenja UK'],
        ['Waschies', '6973851855c7d0811b307586', 'Waschies DE'],
        ['Clearly', '6973a15e06f8df59ef3f02eb', 'Clearly DE'],
        ['Feel Güd', '6973a3f2a88f19f246a0413e', 'Feel Gud DE'],
        ['Satin Naturel', '69773b4547b672aebf7ecefd', 'Satin DE'],
        ['Living Things', '698ee7a19beb62840d4e2e03', 'Living Things'],
        ['Evolsin', '69a8439aa8c4ed8c1c63f5bc', 'Evolsin Medical DE'],
        ['Evolsin', '69f9c30de01a3a6f482b6f98', 'Evolsin FR'],
        ['Super Ninja', '69b3f6d537ca86c6dd07b7aa', 'Super Ninja DE'],
        ['Super Ninja', '69b41dc4b93a3fea8e0eabf5', 'Super Ninja FR'],
        ['Super Ninja', '69b41dcf3100a3b8f9711e78', 'Super Ninja IT'],
        ['Super Ninja', '69b4211a3100a3b8f9712132', 'Super Ninja ES'],
        ['Super Ninja', '6a47ab9a7d2de208b1c1eafd', 'Super Ninja NL'],
        ['Super Ninja', '6a47abf353cabf8579d0339c', 'Super Ninja BE'],
        ['Estrid', '69ce1beed14555ce065a8783', 'Estrid DE'],
        ['Estrid', '69ce1e851b6bd2519fc4788e', 'Estrid UK'],
        ['Estrid', '6a75ccec27a4343dcaa6a6de', 'Estrid FR'],
        ['Estrid', '6a75ccfb27a4343dcaa6a78d', 'Estrid IT'],
        ['Estrid', '6a75cd0b7354b0c4d53f05f2', 'Estrid NL'],
        ['Estrid', '6a75cd476aca012870d7bd37', 'Estrid AU'],
        ['Estrid', '6a75cd74267348cb5eefe201', 'Estrid IE'],
        ['Estrid', '6a75cd80e78685606172b064', 'Estrid ES'],
        ['Estrid', '6a75cde05465c7c29309a67f', 'Estrid BE'],
        ['Belively', '69f1ffa88fa9bee8204e773d', 'Belively'],
        ['Mars', '69fdeee1a0c17ae16729f33f', 'MARS UK'],
        ['Mothersearth', '6a297236e38f4af4722349d6', "Mother's Earth"],
        ['Mothersearth', '6a33ca28b56d7c99d3b3418e', "Mother's Earth UK"],
        ['Mothersearth', '6a54c1ed74d53655d6f41089', 'Mothersearth NL'],
        ['Chupa Chups', '6a2fb596981953ffd720f179', 'Chupa Chups DE'],
        ['Golden Tree', '6a32ad81bbf99a2af27e9226', 'Golden Tree'],
        ['Muehlenkraft', '6a3bbca901baaf5a46937944', 'Mühlenkraft DE'],
        ['BiFi', '6a423798889212a71f91950d', 'BiFi DE'],
        ['VeoBabys', '6a4ba4d3f3f94fe06bb7b6e8', 'VeoBabys IT'],
        ['Bears With Benefits', '6a57569b37ac6b1106c48355', 'Bears With Benefits IT'],
        ['My Protein', '6a631dc8045f180d301bb099', 'Myprotein DE'],
        ['Vaseline', '6a993450b07efd8e856b8876', 'Vaseline - DE'],
        ['Vaseline', '6a993f1fab247ecfb48e53d7', 'Vaseline - FR'],
        ['Vaseline', '6a993f5b01f674387bc71a39', 'Vaseline - IT'],
        ['Vaseline', '6a993fa001f674387bc71cea', 'Vaseline - ES'],
        ['Nutrivita (Dr Nutrition)', '6a9934968fd63ac36f432d29', 'Nutrivita - DE'],
        ['Nutrivita (Dr Nutrition)', '6a9938f0e92ad02a0fa8a8df', 'Nutrivita DE'],
        ['Unilever', '6a9934739db5374e9d84dfe9', 'SheaMoisture - DE'],
        ['Unilever', '6a993fc5d0cf791856b27536', 'Shea Moisture - FR'],
      ];
      const accountId = db.prepare(`SELECT id FROM accounts WHERE name = ?`);
      const insShop = db.prepare(`INSERT OR IGNORE INTO account_shops (account_id, shop_id, shop_name) VALUES (?, ?, ?)`);
      for (const [account, shopId, shopName] of shops) {
        const row = accountId.get(account) as { id: number } | undefined;
        if (row) insShop.run(row.id, shopId, shopName);
      }
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
