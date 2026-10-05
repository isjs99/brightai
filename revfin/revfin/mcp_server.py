"""revfin as an MCP server, so Claude Desktop / Cowork / Code can query the
finance data directly. Read-only against Revolut; the only things it writes
are the local database, exports, and category rules in config.yaml.

Run with `revfin mcp`. Tools are plain functions so they can be tested
without a transport.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from . import __version__
from .auth import AuthError, TokenProvider, TokenStore, token_health
from .categorise import recategorise
from .client import ApiError, RevolutClient
from .config import ConfigError, Settings
from .config import load as load_settings
from .db import DB
from .export import export_rows
from .pnl import build_pnl
from .summary import write_summary
from .sync import sync_entity
from .util import parse_date, utcnow
from .workbook import build_workbook, write_xlsx

INSTRUCTIONS = (
    "Brightform finance data from Revolut Business, read-only. Entities: uk (GBP) and de (EUR). "
    "Start with revfin_status. Use revfin_summary for a month narrative, revfin_pnl for figures, "
    "revfin_transactions to drill in, revfin_uncategorised then revfin_add_category_rule to improve tagging. "
    "Amounts are signed from the account's view: positive = money in. Cash basis, not accruals."
)


class Tools:
    """Holds settings; each public method is registered as an MCP tool."""

    def __init__(self, home: str | os.PathLike | None = None):
        self.home = home
        self.settings: Settings = load_settings(home)

    def _reload(self) -> Settings:
        self.settings = load_settings(self.home)
        return self.settings

    def _db(self) -> DB:
        return DB(self.settings.db_path)

    # -- tools --------------------------------------------------------------

    def revfin_status(self) -> dict:
        """Entities, credential and token health, last sync time and row counts. Call this first."""
        s = self.settings
        store = TokenStore(s.tokens_path)
        db = self._db()
        try:
            entities = []
            for ent in s.entities.values():
                last = db.last_sync(ent.slug)
                entities.append({
                    "slug": ent.slug, "name": ent.name, "base_currency": ent.base_currency,
                    "credentials_missing": ent.missing_credentials(),
                    "token": token_health(store, ent.slug),
                    "last_sync": None if not last else {
                        "status": last["status"], "finished_at": last["finished_at"], "since": last["since"],
                        "transactions": last["transactions"], "error": last["error"]},
                    "stored": {"accounts": db.count("accounts", ent.slug), "transactions": db.count("transactions", ent.slug)},
                })
        finally:
            db.close()
        return {"revfin": __version__, "env": s.env, "db": str(s.db_path), "group_currency": s.group_currency,
                "entities": entities, "sheet_id_set": bool(s.sheet_id())}

    def revfin_sync(self, entity: str | None = None, since: str | None = None) -> dict:
        """Pull fresh accounts, balances and transactions from Revolut (read-only API calls).
        entity: uk or de (default all). since: YYYY-MM-DD (default: last sync minus 3 days)."""
        s = self.settings
        db = self._db()
        store = TokenStore(s.tokens_path)
        results: dict[str, Any] = {}
        try:
            for ent in s.select_entities(entity):
                if not entity and ent.missing_credentials() and not store.get(ent.slug):
                    results[ent.slug] = {"skipped": "not set up yet (no credentials, no token)"}
                    continue
                try:
                    client = RevolutClient(s, ent, TokenProvider(s, ent, store))
                    r = sync_entity(s, db, ent, client, since)
                    results[ent.slug] = {"ok": True, "accounts": r.accounts, "transactions": r.transactions,
                                         "since": r.since.date().isoformat(), "fx_rates": r.fx_rates, "api_calls": r.requests}
                except AuthError as exc:
                    results[ent.slug] = {"ok": False, "auth_error": str(exc),
                                         "action": f"the user must run `revfin auth {ent.slug}` in Terminal"}
                except ApiError as exc:
                    results[ent.slug] = {"ok": False, "api_error": str(exc)}
        finally:
            db.close()
        return results

    def revfin_balances(self, entity: str | None = None) -> list[dict]:
        """Current balance per account from the last sync."""
        s = self.settings
        db = self._db()
        try:
            out = []
            for ent in s.select_entities(entity):
                for r in db.accounts_for(ent.slug):
                    out.append({"entity": ent.slug, "account_id": r["id"],
                                "name": s.account_nicknames.get(r["id"], r["name"]), "currency": r["currency"],
                                "balance": r["last_seen_balance"], "state": r["state"], "synced_at": r["last_synced"]})
            return out
        finally:
            db.close()

    def revfin_summary(self, month: str | None = None, entity: str | None = None, as_of: str | None = None) -> str:
        """Markdown finance summary for a month (YYYY-MM, default current): cash position, in/out by
        category, top counterparties, client receipts, unusual items, uncategorised list, runway, JSON block."""
        s = self.settings
        month = month or utcnow().strftime("%Y-%m")
        _check_month(month)
        anchor = parse_date(as_of).replace(hour=23, minute=59, second=59) if as_of else None
        db = self._db()
        try:
            return write_summary(s, db, s.select_entities(entity), month, anchor)
        finally:
            db.close()

    def revfin_pnl(self, from_month: str | None = None, to_month: str | None = None, entity: str | None = None) -> dict:
        """Cash-basis P&L figures by month: lines by section, derived results, clients, vendors, month-end
        cash and analytics (MoM, T3M, YTD, margins, concentration, burn, runway). entity: uk, de or group
        (default: everything)."""
        s = self.settings
        for m in (from_month, to_month):
            if m:
                _check_month(m)
        db = self._db()
        try:
            model = build_pnl(s, db, from_month, to_month)
        finally:
            db.close()
        data = model.to_json()
        data["fx_notes"] = model.fx_notes
        if entity == "group":
            return {"months": data["months"], "group": data["group"], "fx_notes": data["fx_notes"]}
        if entity:
            if entity not in data["entities"]:
                raise ValueError(f"unknown entity '{entity}'; use one of {list(data['entities'])} or 'group'")
            return {"months": data["months"], "entity": entity, **data["entities"][entity], "fx_notes": data["fx_notes"]}
        return data

    def revfin_transactions(
        self, from_date: str, to_date: str, entity: str | None = None, category: str | None = None,
        search: str | None = None, min_abs_amount: float | None = None, limit: int = 200,
    ) -> dict:
        """Transaction legs between two dates (YYYY-MM-DD, inclusive). Optional filters: category,
        case-insensitive search across counterparty, merchant and reference, minimum absolute amount."""
        s = self.settings
        start = parse_date(from_date)
        end = parse_date(to_date).replace(hour=23, minute=59, second=59)
        pattern = re.compile(re.escape(search), re.IGNORECASE) if search else None
        db = self._db()
        try:
            rows: list[dict] = []
            for ent in s.select_entities(entity):
                rows.extend(export_rows(s, db, ent, start, end))
        finally:
            db.close()
        if category:
            rows = [r for r in rows if r["category"] == category]
        if pattern:
            rows = [r for r in rows if pattern.search(" ".join(str(r.get(k) or "") for k in ("counterparty_name", "merchant_name", "reference")))]
        if min_abs_amount is not None:
            rows = [r for r in rows if abs(r["amount"]) >= min_abs_amount]
        total = len(rows)
        rows = rows[: max(1, min(int(limit), 2000))]
        keep = ("date", "entity", "transaction_id", "leg_index", "type", "state", "account_name", "amount", "currency",
                "amount_base", "base_currency", "counterparty_name", "merchant_name", "reference", "category", "rule_id")
        return {"total_matching": total, "returned": len(rows), "rows": [{k: r.get(k) for k in keep} for r in rows]}

    def revfin_uncategorised(self, from_date: str | None = None, entity: str | None = None, limit: int = 100) -> dict:
        """Legs still tagged uncategorised, grouped by counterparty/merchant with totals, newest first.
        Use the groups to propose rules for revfin_add_category_rule."""
        s = self.settings
        start = parse_date(from_date) if from_date else parse_date(s.default_since)
        end = utcnow().replace(hour=23, minute=59, second=59)
        db = self._db()
        try:
            rows: list[dict] = []
            for ent in s.select_entities(entity):
                rows.extend(r for r in export_rows(s, db, ent, start, end) if r["category"] == "uncategorised")
        finally:
            db.close()
        groups: dict[str, dict] = {}
        for r in rows:
            key = r["counterparty_name"] or r["merchant_name"] or "unknown"
            g = groups.setdefault(key, {"name": key, "count": 0, "total_base": 0.0, "currencies": set(), "types": set(),
                                        "references": set(), "entities": set(), "last": ""})
            g["count"] += 1
            g["total_base"] = round(g["total_base"] + (r["amount_base"] or 0), 2)
            g["currencies"].add(r["currency"])
            g["types"].add(r["type"])
            g["entities"].add(r["entity"])
            if r["reference"]:
                g["references"].add(r["reference"][:60])
            g["last"] = max(g["last"], r["date"])
        ordered = sorted(groups.values(), key=lambda g: -abs(g["total_base"]))[: int(limit)]
        for g in ordered:
            for k in ("currencies", "types", "references", "entities"):
                g[k] = sorted(g[k])[:8]
        return {"legs": len(rows), "groups": ordered,
                "categories_available": sorted({l.category for l in s.pnl_lines} | {"contractor", "client_receipt", "owner", "intercompany"})}

    def revfin_add_category_rule(
        self, rule_id: str, category: str, merchant_name: str | None = None, counterparty_name: str | None = None,
        reference: str | None = None, type: str | None = None, direction: str | None = None,
    ) -> dict:
        """Append a category rule to config.yaml and re-tag every stored transaction. Match fields are
        case-insensitive regexes; at least one is required. direction: in or out. Returns the new category
        counts. Ask the user before adding a rule that affects revenue (client_receipt)."""
        s = self.settings
        if not re.fullmatch(r"[a-z0-9_]+", rule_id):
            raise ValueError("rule_id must be lowercase letters, digits and underscores")
        if not re.fullmatch(r"[a-z0-9_]+", category):
            raise ValueError("category must be a lowercase slug like software or client_receipt")
        if any(r.id == rule_id for r in s.rules):
            raise ValueError(f"rule id '{rule_id}' already exists")
        match: dict[str, str] = {}
        for key, value in (("merchant_name", merchant_name), ("counterparty_name", counterparty_name), ("reference", reference)):
            if value:
                re.compile(value)  # raises re.error on a bad pattern
                match[key] = value
        if type:
            match["type"] = type
        if direction:
            if direction not in ("in", "out"):
                raise ValueError("direction must be 'in' or 'out'")
            match["direction"] = direction
        if not match:
            raise ValueError("give at least one of merchant_name, counterparty_name, reference, type")

        path = s.home / "config.yaml"
        original = path.read_text()
        match_text = ", ".join(f"{k}: {json.dumps(v)}" for k, v in match.items())
        block = f"  - id: {rule_id}\n    category: {category}\n    match: {{ {match_text} }}\n"
        path.write_text(original.rstrip("\n") + "\n" + block)
        try:
            new_settings = self._reload()
            if not any(r.id == rule_id for r in new_settings.rules):
                raise ConfigError("config.yaml no longer ends with the categories list; add the rule by hand")
        except ConfigError:
            path.write_text(original)
            self._reload()
            raise
        db = self._db()
        try:
            counts = {ent.slug: recategorise(new_settings, db, ent.slug) for ent in new_settings.entities.values()}
        finally:
            db.close()
        return {"added": {"id": rule_id, "category": category, "match": match}, "category_counts": counts}

    def revfin_categorise(self, entity: str | None = None) -> dict:
        """Re-apply the rules in config.yaml to stored transactions (no API calls)."""
        s = self._reload()
        db = self._db()
        try:
            return {ent.slug: recategorise(s, db, ent.slug) for ent in s.select_entities(entity)}
        finally:
            db.close()

    def revfin_export_workbook(self, from_month: str | None = None, to_month: str | None = None, path: str | None = None) -> dict:
        """Write the P&L workbook (.xlsx with P&L, analytics, clients, vendors, cash, ledger tabs) and return its path."""
        s = self.settings
        db = self._db()
        try:
            model = build_pnl(s, db, from_month, to_month)
        finally:
            db.close()
        out = Path(path) if path else s.exports_dir / f"pnl-{model.months[0]}-to-{model.months[-1]}.xlsx"
        if not out.is_absolute():
            out = s.exports_dir / out
        write_xlsx(build_workbook(model, s.account_nicknames), out)
        return {"path": str(out), "months": model.months, "ledger_rows": len(model.ledger)}

    def revfin_push_to_google_sheets(self, from_month: str | None = None, to_month: str | None = None) -> dict:
        """Build the P&L and write every tab into the configured Google Sheet (REVFIN_SHEET_ID). Needs the
        service account set up per the README; returns setup instructions if it is not."""
        from .sheets import SheetsApi, SheetsError, load_service, push_workbook, resolve_target

        s = self.settings
        try:
            sid, key = resolve_target(s, None)
            service = load_service(key)
        except (ConfigError, SheetsError) as exc:
            return {"ok": False, "error": str(exc), "setup": "README.md, section 'Google Sheets setup'"}
        db = self._db()
        try:
            model = build_pnl(s, db, from_month, to_month)
        finally:
            db.close()
        stats = push_workbook(SheetsApi(service, sid), build_workbook(model, s.account_nicknames))
        stats.update({"ok": True, "url": f"https://docs.google.com/spreadsheets/d/{sid}/edit", "months": model.months})
        return stats


def _check_month(month: str) -> None:
    try:
        datetime.strptime(month, "%Y-%m")
    except ValueError:
        raise ValueError(f"month must look like 2026-08, got {month!r}") from None


TOOL_NAMES = [
    "revfin_status", "revfin_sync", "revfin_balances", "revfin_summary", "revfin_pnl", "revfin_transactions",
    "revfin_uncategorised", "revfin_add_category_rule", "revfin_categorise", "revfin_export_workbook",
    "revfin_push_to_google_sheets",
]


def build_server(home: str | os.PathLike | None = None):
    from mcp.server.mcpserver import MCPServer

    tools = Tools(home)
    server = MCPServer(name="revfin", version=__version__, instructions=INSTRUCTIONS)
    for name in TOOL_NAMES:
        server.tool(name=name)(getattr(tools, name))
    return server


def desktop_config(settings: Settings) -> dict:
    """The claude_desktop_config.json entry for this install, with absolute paths."""
    import shutil
    import sys

    exe = Path(sys.executable).parent / "revfin"
    command = str(exe) if exe.exists() else (shutil.which("revfin") or "revfin")
    return {"mcpServers": {"revfin": {"command": command, "args": ["mcp"], "env": {"REVFIN_HOME": str(settings.home)}}}}
