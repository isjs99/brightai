"""Load hand-made fixture JSON into the database so `summary` can be tested
without a live Revolut account. Layout: fixtures/<entity-slug>/*.json."""

from __future__ import annotations

import json
from pathlib import Path

from .categorise import Categoriser, legs_from_tx
from .config import Settings
from .db import DB
from .util import parse_ts, utcnow


def load_fixtures(settings: Settings, db: DB, directory: Path, entity_slug: str | None = None) -> dict[str, dict]:
    loaded: dict[str, dict] = {}
    for entity in settings.select_entities(entity_slug):
        folder = directory / entity.slug
        if not folder.is_dir():
            continue
        now = utcnow()
        db.upsert_entity(entity)
        accounts = _read(folder / "accounts.json")
        for account in accounts:
            db.upsert_account(entity.slug, account, now)
        snapshots = _read(folder / "balance_snapshots.json")
        for snap in snapshots:
            taken = parse_ts(snap["taken_at"])
            assert taken is not None
            db.insert_snapshot(entity.slug, {"id": snap["account_id"], "balance": snap["balance"], "currency": snap["currency"]}, taken)
        if not snapshots:
            for account in accounts:
                db.insert_snapshot(entity.slug, account, now)
        names: dict[str, str] = {}
        for cp in _read(folder / "counterparties.json"):
            db.upsert_counterparty(entity.slug, cp)
            if cp.get("name"):
                names[cp["id"]] = cp["name"]
        for rate in _read(folder / "fx_rates.json"):
            taken = parse_ts(rate.get("taken_at")) or now
            db.upsert_fx_rate(entity.slug, taken, rate["from"], rate["to"], float(rate["rate"]), rate.get("source", "fixture"))
        db.commit()
        loaded[entity.slug] = {"accounts": len(accounts), "transactions": len(_read(folder / "transactions.json"))}

    # Second pass so intercompany detection can see every entity's accounts.
    categoriser = Categoriser(settings, db.account_ids_by_entity())
    for slug in loaded:
        folder = directory / slug
        names = db.counterparty_names(slug)
        txs = _read(folder / "transactions.json")
        sync_id = db.start_sync(slug, utcnow(), parse_ts(txs[-1]["created_at"]) if txs else utcnow(), utcnow())
        for tx in txs:
            db.upsert_transaction(slug, tx, names)
            category, rule_id = categoriser.categorise(slug, tx, legs_from_tx(tx, names))
            db.upsert_category(tx["id"], category, rule_id)
        db.finish_sync(sync_id, loaded[slug]["accounts"], len(txs))
    db.commit()
    return loaded


def _read(path: Path) -> list:
    if not path.exists():
        return []
    return json.loads(path.read_text())
