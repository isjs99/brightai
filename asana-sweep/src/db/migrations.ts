import type Database from 'better-sqlite3';
import { SEED_CONTACTS, SEED_DOMAINS, SEED_PULLED_AT, SEED_SHOPS } from '../bd/seed.js';
import { SEED_ENRICHED } from '../bd/seed-enriched.js';
import { SEED_TTS_CONTACTS } from '../bd/seed-tts.js';
import { CHECKLIST_TEMPLATE } from '../checklist/template.js';
import { SEED_WATCHLIST } from '../bd/watchlist.js';
import { SEED_BOOKING_URL, SEED_EXAMPLES, SEED_PITCH, SEED_SENDER_NAME, SEED_SENDER_TITLE, SEED_SENT_QUERY } from '../bd/voice.js';

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
  {
    version: 5,
    name: 'live watching: final snapshots and live status',
    up(db) {
      db.exec(`
        ALTER TABLE checks ADD COLUMN final INTEGER NOT NULL DEFAULT 0;

        CREATE TABLE live_checks (
          account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
          check_date TEXT NOT NULL,
          checked_at TEXT NOT NULL,
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
          items TEXT NOT NULL DEFAULT '[]'
        );
      `);
      const set = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
      set.run('live_enabled', '1');
      set.run('live_interval_seconds', '60');
      set.run('live_sweep_enabled', '1');
    },
  },
  {
    version: 6,
    name: 'remember completed tasks the sweep deleted',
    up(db) {
      db.exec(`
        CREATE TABLE completions (
          task_gid TEXT PRIMARY KEY,
          project_gid TEXT NOT NULL,
          parent_gid TEXT,
          name TEXT NOT NULL,
          section_name TEXT,
          assignee_name TEXT,
          completed INTEGER NOT NULL DEFAULT 1,
          completed_at TEXT,
          num_subtasks INTEGER NOT NULL DEFAULT 0,
          deleted_at TEXT NOT NULL,
          run_id INTEGER
        );
        CREATE INDEX completions_project ON completions(project_gid, deleted_at);
      `);
    },
  },
  {
    version: 7,
    name: 'market currencies, fx rates, bonus rule, monthly gmv pull',
    up(db) {
      const set = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
      set.run('report_currency', 'EUR');
      set.run('fx_to_eur', JSON.stringify({ GBP: 1.16, PLN: 0.235, AUD: 0.6 }));
      set.run('bonus_threshold', '30000');
      set.run('bonus_growth_below', '100');
      set.run('bonus_growth_above', '40');
      set.run('gmv_monthly_cron', '30 7 1 * *');
      db.prepare(`UPDATE settings SET value = 'EUR' WHERE key = 'gmv_currency' AND value = '$'`).run();

      // Shops carry their market currency: UK → GBP, PL → PLN, AU → AUD, everything else EUR.
      const shops = db.prepare('SELECT id, shop_name FROM account_shops').all() as { id: number; shop_name: string }[];
      const upd = db.prepare('UPDATE account_shops SET currency = ? WHERE id = ?');
      for (const s of shops) {
        const tokens = s.shop_name.toUpperCase().replace(/[()\-–_,]/g, ' ').split(/\s+/);
        const cur = tokens.includes('UK') || tokens.includes('GB') ? 'GBP' : tokens.includes('PL') ? 'PLN' : tokens.includes('AU') ? 'AUD' : 'EUR';
        upd.run(cur, s.id);
      }
    },
  },
  {
    version: 8,
    name: 'commission deals, settlement basis, AM share',
    up(db) {
      db.exec(`
        ALTER TABLE accounts ADD COLUMN commission_pct REAL;
        ALTER TABLE accounts ADD COLUMN commission_basis TEXT NOT NULL DEFAULT 'gmv';
        ALTER TABLE accounts ADD COLUMN settlement_pct REAL NOT NULL DEFAULT 100;

        CREATE TABLE settlements (
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          month TEXT NOT NULL,
          amount REAL NOT NULL,
          PRIMARY KEY (account_id, month)
        );
      `);
      db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('am_share_pct', '10')`).run();
    },
  },
  {
    version: 9,
    name: 'tiktok shop authorisations, promotions, gmv max settings',
    up(db) {
      db.exec(`
        CREATE TABLE tts_shops (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          region TEXT NOT NULL DEFAULT '',
          seller_type TEXT NOT NULL DEFAULT '',
          cipher TEXT NOT NULL DEFAULT '',
          account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          market TEXT,
          access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          access_expires_at INTEGER NOT NULL DEFAULT 0,
          refresh_expires_at INTEGER NOT NULL DEFAULT 0,
          seller_name TEXT,
          authorized_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE promotions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          activity_type TEXT NOT NULL DEFAULT 'DIRECT_DISCOUNT',
          product_level TEXT NOT NULL DEFAULT 'SHOP',
          discount_type TEXT NOT NULL DEFAULT 'PERCENTAGE_OFF',
          discount_value REAL,
          begin_at TEXT NOT NULL,
          end_at TEXT NOT NULL,
          participation TEXT NOT NULL DEFAULT 'BUYER_NO_LIMIT',
          products TEXT NOT NULL DEFAULT '{}',
          notes TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE promotion_targets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          promotion_id INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          market TEXT NOT NULL,
          tts_shop_id TEXT,
          status TEXT NOT NULL DEFAULT 'planned',
          tts_activity_id TEXT,
          tts_status TEXT,
          error_message TEXT,
          pushed_at TEXT,
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          UNIQUE(promotion_id, account_id, market)
        );

        CREATE TABLE gmv_max_settings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          market TEXT NOT NULL,
          campaign_type TEXT NOT NULL DEFAULT 'PRODUCT',
          campaign_name TEXT,
          daily_budget REAL,
          budget_currency TEXT NOT NULL DEFAULT 'EUR',
          bid_strategy TEXT NOT NULL DEFAULT 'MAX_GMV',
          target_roi REAL,
          status TEXT NOT NULL DEFAULT 'planned',
          product_scope TEXT NOT NULL DEFAULT 'ALL',
          notes TEXT,
          tts_campaign_id TEXT,
          last_pushed_at TEXT,
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          UNIQUE(account_id, market, campaign_type)
        );
      `);
      db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('tts_service_id', '')`).run();
    },
  },
  {
    version: 10,
    name: 'leads synced from the lead sheet',
    up(db) {
      db.exec(`
        CREATE TABLE leads (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          poc TEXT,
          stage TEXT,
          country TEXT,
          last_contact TEXT,
          notes TEXT,
          est_value REAL,
          priority TEXT,
          row_no INTEGER,
          sourced_by_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
          onboarding_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
          signed INTEGER NOT NULL DEFAULT 0,
          signed_at TEXT,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          removed_at TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX leads_onboarding ON leads(onboarding_id);
        CREATE INDEX leads_sourced ON leads(sourced_by_id);
      `);
      const set = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
      set.run('leads_sheet_id', '1iQ4bgteIU07h8j3rll6bM7wJkq1x52BZeqTVRD97FRA');
      set.run('leads_sheet_tab', 'Core Lead List');
      set.run('leads_sync_enabled', '1');
      set.run('leads_sync_seconds', '180');
      set.run('leads_points_signed', '1');
      set.run('leads_points_sourced', '1');
      set.run('leads_currency', 'GBP');
    },
  },
  {
    version: 11,
    name: 'bd pipeline: prospects, contacts, outreach checklist',
    up(db) {
      db.exec(`
        CREATE TABLE bd_prospects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          seller_id TEXT,
          shop_name TEXT NOT NULL,
          brand TEXT,
          market TEXT NOT NULL,
          category TEXT,
          gmv_7d REAL,
          gmv_total REAL,
          units_7d INTEGER,
          units_total INTEGER,
          currency TEXT NOT NULL DEFAULT 'EUR',
          shop_type TEXT,
          tiktok_handle TEXT,
          rating REAL,
          products INTEGER,
          domain TEXT,
          website TEXT,
          status TEXT NOT NULL DEFAULT 'new',
          owner_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
          notes TEXT,
          outreach_tts_am INTEGER NOT NULL DEFAULT 0,
          outreach_tts_am_at TEXT,
          outreach_gmail INTEGER NOT NULL DEFAULT 0,
          outreach_gmail_at TEXT,
          outreach_linkedin INTEGER NOT NULL DEFAULT 0,
          outreach_linkedin_at TEXT,
          source TEXT NOT NULL DEFAULT 'manual',
          pulled_at TEXT,
          archived INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE UNIQUE INDEX bd_prospects_seller ON bd_prospects(seller_id) WHERE seller_id IS NOT NULL;
        CREATE INDEX bd_prospects_market ON bd_prospects(market, status);

        CREATE TABLE bd_contacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          prospect_id INTEGER NOT NULL REFERENCES bd_prospects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          title TEXT,
          email TEXT,
          linkedin_url TEXT,
          phone TEXT,
          source TEXT NOT NULL DEFAULT 'manual',
          apollo_id TEXT,
          enriched INTEGER NOT NULL DEFAULT 0,
          notes TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX bd_contacts_prospect ON bd_contacts(prospect_id);
      `);
      const ins = db.prepare(`INSERT OR IGNORE INTO bd_prospects (seller_id, shop_name, brand, market, category, gmv_7d, gmv_total, units_7d, units_total, currency, shop_type, tiktok_handle, rating, products, source, pulled_at)
        VALUES (@seller_id, @shop_name, @brand, @market, @category, @gmv_7d, @gmv_total, @units_7d, @units_total, @currency, @shop_type, @tiktok_handle, @rating, @products, 'fastmoss', @pulled_at)`);
      for (const { launched_at: _l, gmv_started_at: _g, ...s } of SEED_SHOPS) ins.run({ ...s, pulled_at: SEED_PULLED_AT });
      // Decision makers found and revealed through Apollo at seed time (name, title, email, LinkedIn, Apollo id, note).
      const contact = db.prepare(`INSERT INTO bd_contacts (prospect_id, name, title, email, linkedin_url, source, apollo_id, enriched, notes) SELECT id, ?, ?, ?, ?, 'apollo', ?, ?, ? FROM bd_prospects WHERE seller_id = ?`);
      for (const c of SEED_CONTACTS) contact.run(c.name, c.title, c.email, c.linkedin_url, c.apollo_id, c.email || c.linkedin_url ? 1 : 0, c.note, c.seller_id);
      const dom = db.prepare(`UPDATE bd_prospects SET domain = ?, website = ? WHERE seller_id = ? AND domain IS NULL`);
      for (const [seller, domain] of Object.entries(SEED_DOMAINS)) dom.run(domain, domain, seller);
    },
  },
  {
    version: 12,
    name: 'cs and affiliate inbox, context library, auto-reply switches',
    up(db) {
      db.exec(`
        ALTER TABLE accounts ADD COLUMN auto_reply_cs INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE accounts ADD COLUMN auto_reply_affiliate INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE accounts ADD COLUMN reply_language TEXT;

        CREATE TABLE inbox_conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tts_shop_id TEXT NOT NULL REFERENCES tts_shops(id) ON DELETE CASCADE,
          channel TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          counterpart_name TEXT,
          counterpart_id TEXT,
          unread_count INTEGER NOT NULL DEFAULT 0,
          last_message_at TEXT,
          last_message_text TEXT,
          last_sender TEXT,
          last_message_id TEXT,
          can_send INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'open',
          language TEXT,
          synced_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(tts_shop_id, channel, conversation_id)
        );
        CREATE INDEX inbox_conversations_recent ON inbox_conversations(last_message_at DESC);

        CREATE TABLE inbox_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_ref INTEGER NOT NULL REFERENCES inbox_conversations(id) ON DELETE CASCADE,
          message_id TEXT NOT NULL,
          sender_role TEXT NOT NULL,
          sender_name TEXT,
          type TEXT NOT NULL DEFAULT 'TEXT',
          text TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(conversation_ref, message_id)
        );

        CREATE TABLE inbox_replies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_ref INTEGER NOT NULL REFERENCES inbox_conversations(id) ON DELETE CASCADE,
          text TEXT NOT NULL,
          mode TEXT NOT NULL DEFAULT 'draft',
          created_by TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          sent_at TEXT,
          tts_message_id TEXT,
          error_message TEXT,
          in_reply_to TEXT
        );
        CREATE INDEX inbox_replies_conv ON inbox_replies(conversation_ref, created_at DESC);

        CREATE TABLE context_library (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          language TEXT NOT NULL DEFAULT '*',
          scope TEXT NOT NULL DEFAULT 'both',
          account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE cruva_outreach (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
          creator_handle TEXT NOT NULL,
          summary TEXT NOT NULL,
          occurred_at TEXT,
          source TEXT NOT NULL DEFAULT 'import',
          UNIQUE(account_id, creator_handle, summary)
        );
        CREATE INDEX cruva_outreach_handle ON cruva_outreach(creator_handle);
      `);
      const set = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
      set.run('auto_reply_master', '0');
      set.run('inbox_enabled', '1');
      set.run('inbox_poll_seconds', '120');
      set.run('auto_reply_max_age_hours', '48');
      const lib = db.prepare(`INSERT INTO context_library (language, scope, title, body) VALUES (?, ?, ?, ?)`);
      lib.run('*', 'both', 'Voice and rules', 'You reply on behalf of the brand\'s own TikTok Shop team (never mention an agency). Be warm, short and concrete: one to four sentences, no bullet lists, no emojis unless the other person uses them. Never invent order details, tracking numbers, stock levels or discounts that are not in the context. If something needs a human (refund disputes, damaged goods, legal or health claims, anything you are unsure of), say the team will follow up within one working day and stop there.');
      lib.run('*', 'cs', 'Customer service basics', 'Thank the buyer, acknowledge the issue in one line, then give the next step. For delivery questions point to the tracking in their TikTok order page and give the usual delivery window for the market. For returns explain they can start it from Orders > Return/Refund in the TikTok app within the return window. Ask for the order number only if it is not already in the conversation.');
      lib.run('*', 'affiliate', 'Affiliate basics', 'Creators are partners: thank them for the interest, confirm whether they are already on the open or targeted collaboration, and mention the commission and free sample process only if it is in the context. Ask for their TikTok username and which product they want to feature. If they ask for higher commission or paid deals, say the partnerships team will come back to them.');
      lib.run('en', 'both', 'English sign-off', 'Sign off with "Best, the [brand] team".');
      lib.run('de', 'both', 'Deutsch', 'Duze auf TikTok, freundlich und direkt. Abschluss: "Liebe Grüße, dein [brand] Team".');
      lib.run('fr', 'both', 'Français', 'Tutoiement chaleureux comme sur TikTok. Signature : "À bientôt, l\'équipe [brand]".');
      lib.run('it', 'both', 'Italiano', 'Tono amichevole, dai del tu. Firma: "A presto, il team [brand]".');
      lib.run('es', 'both', 'Español', 'Tono cercano, tutea. Firma: "Un saludo, el equipo de [brand]".');
    },
  },
  {
    version: 13,
    name: 'bd shop launch dates and outreach history, lead added-on date',
    up(db) {
      db.exec(`
        ALTER TABLE bd_prospects ADD COLUMN launched_at TEXT;
        ALTER TABLE bd_prospects ADD COLUMN gmv_started_at TEXT;
        ALTER TABLE leads ADD COLUMN added_on TEXT;

        CREATE TABLE bd_outreach_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          prospect_id INTEGER NOT NULL REFERENCES bd_prospects(id) ON DELETE CASCADE,
          channel TEXT,
          action TEXT NOT NULL,
          note TEXT,
          contact_name TEXT,
          actor TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX bd_outreach_log_prospect ON bd_outreach_log(prospect_id, created_at DESC);
      `);
      db.exec(`UPDATE leads SET added_on = substr(first_seen_at, 1, 10) WHERE added_on IS NULL`);
      // Backfill shop creation / first-sale dates pulled from FastMoss for the seeded shops.
      const upd = db.prepare(`UPDATE bd_prospects SET launched_at = COALESCE(launched_at, ?), gmv_started_at = COALESCE(gmv_started_at, ?) WHERE seller_id = ?`);
      for (const s of SEED_SHOPS) if (s.launched_at || s.gmv_started_at) upd.run(s.launched_at, s.gmv_started_at, s.seller_id);
      // Revealed Apollo contacts: update rows seeded with masked names, add the rest.
      const existing = db.prepare(`SELECT c.id FROM bd_contacts c JOIN bd_prospects p ON p.id = c.prospect_id WHERE p.seller_id = ? AND c.apollo_id = ?`);
      const updC = db.prepare(`UPDATE bd_contacts SET name = ?, title = ?, email = COALESCE(email, ?), linkedin_url = COALESCE(linkedin_url, ?), enriched = ?, notes = ? WHERE id = ?`);
      const insC = db.prepare(`INSERT INTO bd_contacts (prospect_id, name, title, email, linkedin_url, source, apollo_id, enriched, notes) SELECT id, ?, ?, ?, ?, 'apollo', ?, ?, ? FROM bd_prospects WHERE seller_id = ?`);
      for (const c of SEED_CONTACTS) {
        const row = existing.get(c.seller_id, c.apollo_id) as { id: number } | undefined;
        const enriched = c.email || c.linkedin_url ? 1 : 0;
        if (row) updC.run(c.name, c.title, c.email, c.linkedin_url, enriched, c.note, row.id);
        else insC.run(c.name, c.title, c.email, c.linkedin_url, c.apollo_id, enriched, c.note, c.seller_id);
      }
      const dom = db.prepare(`UPDATE bd_prospects SET domain = COALESCE(domain, ?), website = COALESCE(website, ?) WHERE seller_id = ?`);
      for (const [seller, domain] of Object.entries(SEED_DOMAINS)) dom.run(domain, domain, seller);
    },
  },
  {
    version: 14,
    name: 'bd email drafts, outreach voice examples, gmail link',
    up(db) {
      db.exec(`
        CREATE TABLE bd_email_drafts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          prospect_id INTEGER NOT NULL REFERENCES bd_prospects(id) ON DELETE CASCADE,
          contact_id INTEGER REFERENCES bd_contacts(id) ON DELETE SET NULL,
          to_name TEXT NOT NULL,
          to_email TEXT NOT NULL,
          subject TEXT NOT NULL,
          body TEXT NOT NULL,
          language TEXT NOT NULL DEFAULT 'en',
          style TEXT NOT NULL DEFAULT 'short',
          status TEXT NOT NULL DEFAULT 'draft',
          generator TEXT NOT NULL DEFAULT 'template',
          gmail_draft_id TEXT,
          gmail_message_id TEXT,
          gmail_url TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX bd_email_drafts_prospect ON bd_email_drafts(prospect_id, created_at DESC);

        CREATE TABLE outreach_examples (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          subject TEXT NOT NULL,
          body TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'cold',
          to_domain TEXT,
          sent_at TEXT,
          source TEXT NOT NULL DEFAULT 'manual',
          gmail_id TEXT UNIQUE,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
      `);
      const ins = db.prepare(`INSERT INTO outreach_examples (subject, body, kind, to_domain, sent_at, source) VALUES (?, ?, ?, ?, ?, 'seed')`);
      for (const e of SEED_EXAMPLES) ins.run(e.subject, e.body, e.kind, e.to_domain, e.sent_at);
      const set = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`);
      set.run('outreach_sender_name', SEED_SENDER_NAME);
      set.run('outreach_sender_title', SEED_SENDER_TITLE);
      set.run('outreach_booking_url', SEED_BOOKING_URL);
      set.run('outreach_pitch', SEED_PITCH);
      set.run('outreach_sent_query', SEED_SENT_QUERY);
    },
  },
  {
    version: 15,
    name: 'bd apollo organisation id',
    up(db) {
      db.exec(`ALTER TABLE bd_prospects ADD COLUMN apollo_org_id TEXT;`);
    },
  },
  {
    version: 16,
    name: 'bd decision makers from the Apollo enrichment run',
    up(db) {
      const shop = db.prepare(`UPDATE bd_prospects SET domain = COALESCE(domain, ?), website = COALESCE(website, ?), apollo_org_id = COALESCE(apollo_org_id, ?) WHERE seller_id = ?`);
      const existing = db.prepare(`SELECT c.id FROM bd_contacts c JOIN bd_prospects p ON p.id = c.prospect_id WHERE p.seller_id = ? AND c.apollo_id = ?`);
      const upd = db.prepare(`UPDATE bd_contacts SET name = ?, title = COALESCE(?, title), email = COALESCE(email, ?), linkedin_url = COALESCE(linkedin_url, ?), enriched = ?, notes = COALESCE(?, notes) WHERE id = ?`);
      const ins = db.prepare(`INSERT INTO bd_contacts (prospect_id, name, title, email, linkedin_url, source, apollo_id, enriched, notes) SELECT id, ?, ?, ?, ?, 'apollo', ?, ?, ? FROM bd_prospects WHERE seller_id = ?`);
      for (const s of SEED_ENRICHED) {
        shop.run(s.domain, s.domain, s.apollo_org_id, s.seller_id);
        for (const c of s.contacts) {
          const enriched = c.email || c.linkedin_url ? 1 : 0;
          const row = existing.get(s.seller_id, c.apollo_id) as { id: number } | undefined;
          if (row) upd.run(c.name, c.title, c.email, c.linkedin_url, enriched, c.note, row.id);
          else ins.run(c.name, c.title, c.email, c.linkedin_url, c.apollo_id, enriched, c.note, s.seller_id);
        }
      }
    },
  },
  {
    version: 17,
    name: 'bd sequences: linkedin steps, follow-ups, tts contacts, enterprise watchlist and alerts, call follow-ups, account monitor',
    up(db) {
      // Voice samples and the pitch block: headings as "Heading:" lines instead of *Heading* (asterisks leaked into Gmail).
      for (const h of ['Who we are', 'Credentials', 'What we do']) {
        db.prepare(`UPDATE outreach_examples SET body = replace(body, ?, ?)`).run(`*${h}*`, `${h}:`);
        db.prepare(`UPDATE settings SET value = replace(value, ?, ?) WHERE key = 'outreach_pitch'`).run(`*${h}*`, `${h}:`);
      }
      db.exec(`
        ALTER TABLE bd_contacts ADD COLUMN linkedin_status TEXT NOT NULL DEFAULT 'none';
        ALTER TABLE bd_contacts ADD COLUMN linkedin_requested_at TEXT;
        ALTER TABLE bd_contacts ADD COLUMN linkedin_connected_at TEXT;
        ALTER TABLE bd_contacts ADD COLUMN linkedin_messaged_at TEXT;

        ALTER TABLE bd_email_drafts ADD COLUMN kind TEXT NOT NULL DEFAULT 'cold';
        ALTER TABLE bd_email_drafts ADD COLUMN meeting_id TEXT;
        ALTER TABLE bd_email_drafts ADD COLUMN meeting_title TEXT;

        CREATE TABLE bd_followups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          prospect_id INTEGER NOT NULL REFERENCES bd_prospects(id) ON DELETE CASCADE,
          contact_id INTEGER REFERENCES bd_contacts(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          due_at TEXT NOT NULL,
          done_at TEXT,
          note TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX bd_followups_due ON bd_followups(done_at, due_at);

        CREATE TABLE tts_contacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          market TEXT NOT NULL,
          category TEXT,
          name TEXT NOT NULL,
          role TEXT,
          lark TEXT,
          email TEXT,
          notes TEXT,
          is_agency_manager INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE bd_watchlist (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          source TEXT NOT NULL DEFAULT 'manual',
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE bd_alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          prospect_id INTEGER NOT NULL REFERENCES bd_prospects(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          watch_name TEXT,
          message TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          dismissed_at TEXT,
          UNIQUE(prospect_id, kind, watch_name)
        );

        CREATE TABLE monitor_flags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
          shop_id TEXT,
          code TEXT NOT NULL,
          severity TEXT NOT NULL,
          message TEXT NOT NULL,
          detail TEXT,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          resolved_at TEXT,
          acknowledged_at TEXT
        );
        CREATE INDEX monitor_flags_open ON monitor_flags(resolved_at, account_id, code);
      `);
      const wl = db.prepare(`INSERT OR IGNORE INTO bd_watchlist (name, source) VALUES (?, 'seed')`);
      for (const n of SEED_WATCHLIST) wl.run(n);
    },
  },
  {
    version: 18,
    name: 'stock, incidents, client reports, cruva playbook, client copilot',
    up(db) {
      db.exec(`
        ALTER TABLE accounts ADD COLUMN slack_channel TEXT;
        ALTER TABLE accounts ADD COLUMN client_slack_channel TEXT;
        ALTER TABLE accounts ADD COLUMN client_domain TEXT;

        CREATE TABLE stock_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shop_id TEXT NOT NULL,
          account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          product_id TEXT NOT NULL,
          product_title TEXT NOT NULL,
          sku_id TEXT NOT NULL,
          sku_name TEXT,
          seller_sku TEXT,
          product_status TEXT,
          on_hand INTEGER NOT NULL DEFAULT 0,
          sold_7d INTEGER NOT NULL DEFAULT 0,
          sold_30d INTEGER NOT NULL DEFAULT 0,
          captured_at TEXT NOT NULL,
          UNIQUE(shop_id, sku_id)
        );
        CREATE INDEX stock_snapshots_shop ON stock_snapshots(shop_id);

        CREATE TABLE stock_overrides (
          shop_id TEXT NOT NULL,
          sku_id TEXT NOT NULL,
          velocity REAL,
          exclude INTEGER NOT NULL DEFAULT 0,
          note TEXT,
          PRIMARY KEY (shop_id, sku_id)
        );

        CREATE TABLE incidents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
          shop_id TEXT,
          kind TEXT NOT NULL,
          severity TEXT NOT NULL,
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          recommended_action TEXT NOT NULL,
          owner TEXT,
          owner_slack_id TEXT,
          source TEXT NOT NULL DEFAULT 'monitor',
          dedupe_key TEXT NOT NULL,
          slack_channel TEXT,
          slack_ts TEXT,
          posted_at TEXT,
          post_error TEXT,
          resolved_at TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX incidents_open ON incidents(resolved_at, dedupe_key);

        CREATE TABLE client_reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          period TEXT NOT NULL,
          period_start TEXT NOT NULL,
          period_end TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          data_json TEXT NOT NULL DEFAULT '{}',
          generator TEXT NOT NULL DEFAULT 'template',
          status TEXT NOT NULL DEFAULT 'draft',
          slack_channel TEXT,
          sent_at TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE cruva_playbook (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          key TEXT NOT NULL,
          language TEXT NOT NULL DEFAULT '*',
          name TEXT NOT NULL,
          description TEXT,
          config_json TEXT NOT NULL DEFAULT '{}',
          enabled INTEGER NOT NULL DEFAULT 1,
          source TEXT NOT NULL DEFAULT 'seed',
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          UNIQUE(kind, key, language)
        );

        CREATE TABLE cruva_setup (
          shop_id TEXT NOT NULL,
          playbook_key TEXT NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          remote_id TEXT,
          remote_name TEXT,
          checked_at TEXT,
          applied_at TEXT,
          note TEXT,
          PRIMARY KEY (shop_id, kind, playbook_key)
        );

        CREATE TABLE cruva_remote_items (
          shop_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          remote_id TEXT NOT NULL,
          name TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          raw_json TEXT,
          seen_at TEXT NOT NULL,
          PRIMARY KEY (shop_id, kind, remote_id)
        );

        CREATE TABLE copilot_questions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          source TEXT NOT NULL DEFAULT 'manual',
          channel TEXT,
          thread_ts TEXT,
          external_id TEXT,
          asked_by TEXT,
          question TEXT NOT NULL,
          answer TEXT,
          sources_json TEXT NOT NULL DEFAULT '[]',
          generator TEXT,
          status TEXT NOT NULL DEFAULT 'open',
          created_by TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          answered_at TEXT,
          sent_at TEXT
        );
        CREATE UNIQUE INDEX copilot_questions_external ON copilot_questions(source, external_id) WHERE external_id IS NOT NULL;

        CREATE TABLE copilot_evidence (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          ref TEXT NOT NULL,
          title TEXT NOT NULL,
          text TEXT NOT NULL,
          url TEXT,
          occurred_at TEXT,
          indexed_at TEXT NOT NULL,
          UNIQUE(kind, ref)
        );
        CREATE INDEX copilot_evidence_account ON copilot_evidence(account_id, kind);
      `);
    },
  },
  {
    version: 19,
    name: 'prospect company details and enrichment bookkeeping',
    up(db) {
      db.exec(`
        ALTER TABLE bd_prospects ADD COLUMN company_industry TEXT;
        ALTER TABLE bd_prospects ADD COLUMN company_employees INTEGER;
        ALTER TABLE bd_prospects ADD COLUMN company_linkedin TEXT;
        ALTER TABLE bd_prospects ADD COLUMN company_location TEXT;
        ALTER TABLE bd_prospects ADD COLUMN company_description TEXT;
        ALTER TABLE bd_prospects ADD COLUMN enriched_at TEXT;
        ALTER TABLE bd_prospects ADD COLUMN enrich_note TEXT;
      `);
    },
  },
  {
    version: 20,
    name: 'tiktok shop counterpart map seeded',
    up(db) {
      // One row per person and market; a person already added by hand (same name or email in that market) is left as is.
      const byName = db.prepare('SELECT 1 FROM tts_contacts WHERE lower(name) = lower(?) AND market = ?');
      const byEmail = db.prepare('SELECT 1 FROM tts_contacts WHERE email IS NOT NULL AND lower(email) = lower(?) AND market = ?');
      const ins = db.prepare('INSERT INTO tts_contacts (market, category, name, role, lark, email, notes, is_agency_manager) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const c of SEED_TTS_CONTACTS) {
        if (byName.get(c.name, c.market) || (c.email && byEmail.get(c.email, c.market))) continue;
        ins.run(c.market, c.category, c.name, c.role, c.lark, c.email, c.notes, c.is_agency_manager ? 1 : 0);
      }
    },
  },
  {
    version: 21,
    name: 'native AM checklist: items and ticks live here, Asana sweep tables dropped',
    up(db) {
      db.exec(`
        CREATE TABLE checklist_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
          parent_id INTEGER REFERENCES checklist_items(id) ON DELETE CASCADE,
          section TEXT NOT NULL DEFAULT '',
          name TEXT NOT NULL,
          guidance TEXT,
          role TEXT NOT NULL DEFAULT 'am',
          frequency TEXT NOT NULL DEFAULT 'daily',
          weekday INTEGER,
          position INTEGER NOT NULL DEFAULT 0,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX checklist_items_account ON checklist_items(account_id, parent_id, position);

        CREATE TABLE checklist_ticks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_id INTEGER NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          tick_date TEXT NOT NULL,
          done_by TEXT,
          done_at TEXT NOT NULL,
          note TEXT,
          UNIQUE(item_id, account_id, tick_date)
        );
        CREATE INDEX checklist_ticks_day ON checklist_ticks(account_id, tick_date);

        DROP TABLE IF EXISTS run_items;
        DROP TABLE IF EXISTS runs;
        DROP TABLE IF EXISTS rules;
        DROP TABLE IF EXISTS completions;
        DELETE FROM settings WHERE key IN ('live_enabled', 'live_interval_seconds', 'live_sweep_enabled');
      `);
      // The master template: what every board in Asana carried, now the default list for every account.
      const ins = db.prepare(`INSERT INTO checklist_items (account_id, parent_id, section, name, guidance, role, frequency, weekday, position) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?)`);
      let pos = 0;
      for (const item of CHECKLIST_TEMPLATE) {
        const parent = Number(ins.run(null, item.section, item.name, item.guidance, item.role, item.frequency, item.frequency === 'weekly' ? item.weekday ?? 1 : null, pos++).lastInsertRowid);
        let sub = 0;
        for (const st of item.subtasks) {
          const freq = st.frequency ?? 'daily';
          ins.run(parent, item.section, st.name, null, st.role ?? 'aa', freq, freq === 'weekly' ? st.weekday ?? 1 : null, sub++);
        }
      }
    },
  },
  {
    version: 22,
    name: 'unlock the switch-over day so ticks reach the record',
    up(db) {
      // The Asana-era check locked today's snapshot at 16:00 before the native checklist existed; ticks made
      // after the switch would otherwise never reach the Calendar, Analytics or Grades for that day.
      db.exec(`UPDATE checks SET final = 0 WHERE check_date >= date('now', '-1 day')`);
    },
  },
  {
    version: 23,
    name: 'shop source (cruva or windsor) on account_shops',
    up(db) {
      db.exec(`ALTER TABLE account_shops ADD COLUMN source TEXT NOT NULL DEFAULT 'cruva'`);
    },
  },
  {
    version: 24,
    name: 'account health: daily Windsor and Cruva pulls, AI assessments',
    up(db) {
      db.exec(`
        CREATE TABLE health_pulls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shop_id TEXT NOT NULL,
          account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          source TEXT NOT NULL,
          pull_date TEXT NOT NULL,
          pulled_at TEXT NOT NULL,
          ok INTEGER NOT NULL DEFAULT 1,
          error TEXT,
          metrics_json TEXT NOT NULL DEFAULT '{}',
          rows_json TEXT NOT NULL DEFAULT '{}',
          UNIQUE(shop_id, source, pull_date)
        );
        CREATE INDEX health_pulls_shop ON health_pulls(shop_id, source, pull_date);
        CREATE TABLE health_assessments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          assess_date TEXT NOT NULL,
          assessed_at TEXT NOT NULL,
          source TEXT NOT NULL,
          risk TEXT NOT NULL,
          summary TEXT NOT NULL,
          action TEXT NOT NULL,
          watch_json TEXT NOT NULL DEFAULT '[]',
          UNIQUE(account_id, assess_date)
        );
      `);
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
