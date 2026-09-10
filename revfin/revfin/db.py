"""SQLite schema and upserts. Everything keyed so re-syncs never duplicate."""

from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime
from pathlib import Path

from .config import Entity
from .util import iso, parse_ts, utcnow

SCHEMA = """
CREATE TABLE IF NOT EXISTS entities(
  slug TEXT PRIMARY KEY, name TEXT NOT NULL, base_currency TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts(
  id TEXT PRIMARY KEY, entity TEXT NOT NULL, name TEXT, currency TEXT NOT NULL,
  state TEXT, last_seen_balance REAL, last_synced TEXT);
CREATE TABLE IF NOT EXISTS transactions(
  id TEXT PRIMARY KEY, entity TEXT NOT NULL, type TEXT, state TEXT,
  created_at TEXT NOT NULL, completed_at TEXT, reference TEXT,
  merchant_name TEXT, mcc TEXT, raw_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_transactions_entity_created ON transactions(entity, created_at);
CREATE TABLE IF NOT EXISTS legs(
  transaction_id TEXT NOT NULL, leg_index INTEGER NOT NULL, account_id TEXT NOT NULL,
  amount REAL NOT NULL, currency TEXT NOT NULL, counterparty_id TEXT, counterparty_name TEXT,
  balance_after REAL, PRIMARY KEY(transaction_id, leg_index));
CREATE INDEX IF NOT EXISTS ix_legs_account ON legs(account_id);
CREATE TABLE IF NOT EXISTS balance_snapshots(
  entity TEXT NOT NULL, account_id TEXT NOT NULL, taken_at TEXT NOT NULL,
  balance REAL NOT NULL, currency TEXT NOT NULL,
  PRIMARY KEY(entity, account_id, taken_at));
CREATE TABLE IF NOT EXISTS categories(
  transaction_id TEXT PRIMARY KEY, category TEXT NOT NULL, rule_id TEXT);
CREATE TABLE IF NOT EXISTS counterparties(
  id TEXT PRIMARY KEY, entity TEXT NOT NULL, name TEXT, raw_json TEXT);
CREATE TABLE IF NOT EXISTS fx_rates(
  entity TEXT NOT NULL, taken_at TEXT NOT NULL, from_currency TEXT NOT NULL,
  to_currency TEXT NOT NULL, rate REAL NOT NULL, source TEXT,
  PRIMARY KEY(entity, taken_at, from_currency, to_currency));
CREATE TABLE IF NOT EXISTS sync_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, started_at TEXT NOT NULL,
  finished_at TEXT, since TEXT, until TEXT, accounts INTEGER, transactions INTEGER,
  status TEXT, error TEXT);
"""

_DESCRIPTION_PREFIX = re.compile(r"^(payment|transfer|refund)\s+(to|from)\s+", re.IGNORECASE)


def counterparty_name_from_leg(leg: dict, names: dict[str, str]) -> str | None:
    cp = leg.get("counterparty") or {}
    cp_id = cp.get("id")
    if cp_id and names.get(cp_id):
        return names[cp_id]
    description = leg.get("description")
    if description:
        return _DESCRIPTION_PREFIX.sub("", description).strip() or None
    return None


class DB:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        if str(self.path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.path))
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript(SCHEMA)

    def close(self) -> None:
        self.conn.close()

    # -- writes -------------------------------------------------------------

    def upsert_entity(self, entity: Entity) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO entities(slug, name, base_currency) VALUES (?,?,?)",
            (entity.slug, entity.name, entity.base_currency),
        )
        self.conn.commit()

    def upsert_account(self, entity_slug: str, account: dict, synced_at: datetime) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO accounts(id, entity, name, currency, state, last_seen_balance, last_synced)"
            " VALUES (?,?,?,?,?,?,?)",
            (
                account["id"],
                entity_slug,
                account.get("name"),
                account.get("currency"),
                account.get("state"),
                float(account.get("balance") or 0),
                synced_at.isoformat(),
            ),
        )

    def insert_snapshot(self, entity_slug: str, account: dict, taken_at: datetime) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO balance_snapshots(entity, account_id, taken_at, balance, currency)"
            " VALUES (?,?,?,?,?)",
            (entity_slug, account["id"], taken_at.isoformat(), float(account.get("balance") or 0), account.get("currency")),
        )

    def upsert_counterparty(self, entity_slug: str, cp: dict) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO counterparties(id, entity, name, raw_json) VALUES (?,?,?,?)",
            (cp["id"], entity_slug, cp.get("name"), json.dumps(cp, separators=(",", ":"))),
        )

    def upsert_transaction(self, entity_slug: str, tx: dict, counterparty_names: dict[str, str]) -> None:
        merchant = tx.get("merchant") or {}
        self.conn.execute(
            "INSERT OR REPLACE INTO transactions(id, entity, type, state, created_at, completed_at, reference,"
            " merchant_name, mcc, raw_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                tx["id"],
                entity_slug,
                tx.get("type"),
                tx.get("state"),
                tx.get("created_at"),
                tx.get("completed_at"),
                tx.get("reference"),
                merchant.get("name"),
                merchant.get("category_code"),
                json.dumps(tx, separators=(",", ":")),
            ),
        )
        # Legs are replaced wholesale so a pending -> completed change with a
        # different leg count cannot leave stale rows behind.
        self.conn.execute("DELETE FROM legs WHERE transaction_id=?", (tx["id"],))
        for index, leg in enumerate(tx.get("legs") or []):
            cp = leg.get("counterparty") or {}
            self.conn.execute(
                "INSERT INTO legs(transaction_id, leg_index, account_id, amount, currency, counterparty_id,"
                " counterparty_name, balance_after) VALUES (?,?,?,?,?,?,?,?)",
                (
                    tx["id"],
                    index,
                    leg.get("account_id"),
                    float(leg.get("amount") or 0),
                    leg.get("currency"),
                    cp.get("id"),
                    counterparty_name_from_leg(leg, counterparty_names),
                    float(leg["balance"]) if leg.get("balance") is not None else None,
                ),
            )

    def upsert_category(self, transaction_id: str, category: str, rule_id: str | None) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO categories(transaction_id, category, rule_id) VALUES (?,?,?)",
            (transaction_id, category, rule_id),
        )

    def upsert_fx_rate(
        self, entity_slug: str, taken_at: datetime, from_ccy: str, to_ccy: str, rate: float, source: str
    ) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO fx_rates(entity, taken_at, from_currency, to_currency, rate, source)"
            " VALUES (?,?,?,?,?,?)",
            (entity_slug, taken_at.isoformat(), from_ccy, to_ccy, float(rate), source),
        )

    def start_sync(self, entity_slug: str, started_at: datetime, since: datetime, until: datetime) -> int:
        cur = self.conn.execute(
            "INSERT INTO sync_log(entity, started_at, since, until, status) VALUES (?,?,?,?,'running')",
            (entity_slug, started_at.isoformat(), since.isoformat(), until.isoformat()),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    def finish_sync(self, sync_id: int, accounts: int, transactions: int, error: str | None = None) -> None:
        self.conn.execute(
            "UPDATE sync_log SET finished_at=?, accounts=?, transactions=?, status=?, error=? WHERE id=?",
            (utcnow().isoformat(), accounts, transactions, "error" if error else "ok", error, sync_id),
        )
        self.conn.commit()

    def commit(self) -> None:
        self.conn.commit()

    # -- reads --------------------------------------------------------------

    def last_successful_sync(self, entity_slug: str) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT * FROM sync_log WHERE entity=? AND status='ok' ORDER BY id DESC LIMIT 1", (entity_slug,)
        ).fetchone()

    def last_sync(self, entity_slug: str) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT * FROM sync_log WHERE entity=? ORDER BY id DESC LIMIT 1", (entity_slug,)
        ).fetchone()

    def accounts_for(self, entity_slug: str) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT * FROM accounts WHERE entity=? ORDER BY currency, name", (entity_slug,)
        ).fetchall()

    def account_ids_by_entity(self) -> dict[str, set[str]]:
        result: dict[str, set[str]] = {}
        for row in self.conn.execute("SELECT id, entity FROM accounts"):
            result.setdefault(row["entity"], set()).add(row["id"])
        return result

    def counterparty_names(self, entity_slug: str) -> dict[str, str]:
        return {
            row["id"]: row["name"]
            for row in self.conn.execute("SELECT id, name FROM counterparties WHERE entity=?", (entity_slug,))
            if row["name"]
        }

    def count(self, table: str, entity_slug: str | None = None) -> int:
        if entity_slug and table in ("transactions", "accounts", "balance_snapshots", "counterparties"):
            return self.conn.execute(f"SELECT COUNT(*) FROM {table} WHERE entity=?", (entity_slug,)).fetchone()[0]
        return self.conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]

    def transactions_with_legs(self, entity_slug: str) -> list[tuple[dict, list[dict]]]:
        """Raw transaction dicts plus their stored legs, for re-categorisation."""
        txs = self.conn.execute(
            "SELECT id, raw_json FROM transactions WHERE entity=? ORDER BY created_at", (entity_slug,)
        ).fetchall()
        legs_by_tx: dict[str, list[dict]] = {}
        for leg in self.conn.execute(
            "SELECT l.* FROM legs l JOIN transactions t ON t.id=l.transaction_id WHERE t.entity=?"
            " ORDER BY l.transaction_id, l.leg_index",
            (entity_slug,),
        ):
            legs_by_tx.setdefault(leg["transaction_id"], []).append(dict(leg))
        return [(json.loads(row["raw_json"]), legs_by_tx.get(row["id"], [])) for row in txs]

    def leg_rows(self, entity_slug: str, start: datetime | None = None, end: datetime | None = None) -> list[dict]:
        """One row per leg joined to its transaction, account and category."""
        sql = (
            "SELECT t.id AS transaction_id, t.entity, t.type, t.state, t.created_at, t.completed_at,"
            " t.reference, t.merchant_name, t.mcc, l.leg_index, l.account_id, a.name AS account_name,"
            " l.amount, l.currency, l.counterparty_id, l.counterparty_name, l.balance_after,"
            " COALESCE(c.category, 'uncategorised') AS category, c.rule_id"
            " FROM legs l JOIN transactions t ON t.id=l.transaction_id"
            " LEFT JOIN accounts a ON a.id=l.account_id"
            " LEFT JOIN categories c ON c.transaction_id=t.id"
            " WHERE t.entity=?"
        )
        params: list = [entity_slug]
        if start is not None:
            sql += " AND t.created_at >= ?"
            params.append(iso(start))
        if end is not None:
            sql += " AND t.created_at < ?"
            params.append(iso(end))
        sql += " ORDER BY t.created_at, t.id, l.leg_index"
        return [dict(row) for row in self.conn.execute(sql, params)]

    def snapshot_at(self, entity_slug: str, account_id: str, at: datetime) -> sqlite3.Row | None:
        """Latest snapshot taken at or before `at`."""
        return self.conn.execute(
            "SELECT * FROM balance_snapshots WHERE entity=? AND account_id=? AND taken_at<=?"
            " ORDER BY taken_at DESC LIMIT 1",
            (entity_slug, account_id, at.isoformat()),
        ).fetchone()

    def latest_fx_rate(self, entity_slug: str, from_ccy: str, to_ccy: str) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT * FROM fx_rates WHERE entity=? AND from_currency=? AND to_currency=?"
            " ORDER BY taken_at DESC LIMIT 1",
            (entity_slug, from_ccy, to_ccy),
        ).fetchone()

    def counterparties_seen_before(self, entity_slug: str, before: datetime) -> set[str]:
        rows = self.conn.execute(
            "SELECT DISTINCT LOWER(COALESCE(l.counterparty_name, t.merchant_name)) AS name"
            " FROM legs l JOIN transactions t ON t.id=l.transaction_id"
            " WHERE t.entity=? AND t.created_at < ?",
            (entity_slug, iso(before)),
        )
        return {row["name"] for row in rows if row["name"]}

    def newest_created_at(self, entity_slug: str) -> datetime | None:
        row = self.conn.execute(
            "SELECT MAX(created_at) AS m FROM transactions WHERE entity=?", (entity_slug,)
        ).fetchone()
        return parse_ts(row["m"]) if row and row["m"] else None
