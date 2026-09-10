"""Pull accounts, counterparties, transactions and FX rates into SQLite."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from .categorise import Categoriser, legs_from_tx
from .client import ApiError, RevolutClient
from .config import Entity, Settings
from .db import DB
from .util import parse_date, utcnow

Log = Callable[[str], None]


@dataclass
class SyncResult:
    entity: str
    since: datetime
    until: datetime
    accounts: int = 0
    transactions: int = 0
    fx_rates: dict[str, float] = field(default_factory=dict)
    fx_errors: list[str] = field(default_factory=list)
    requests: int = 0


def resolve_since(settings: Settings, db: DB, entity: Entity, explicit: str | None) -> datetime:
    """--since wins; otherwise last successful sync minus the overlap; otherwise default_since."""
    if explicit:
        return parse_date(explicit)
    last = db.last_successful_sync(entity.slug)
    if last and last["until"]:
        return parse_date(last["until"]) - timedelta(days=settings.sync_overlap_days)
    return parse_date(settings.default_since)


def sync_entity(
    settings: Settings,
    db: DB,
    entity: Entity,
    client: RevolutClient,
    since: str | None = None,
    log: Log = lambda _msg: None,
) -> SyncResult:
    started = utcnow()
    since_dt = resolve_since(settings, db, entity, since)
    result = SyncResult(entity=entity.slug, since=since_dt, until=started)
    sync_id = db.start_sync(entity.slug, started, since_dt, started)
    try:
        db.upsert_entity(entity)

        accounts = client.accounts()
        for account in accounts:
            db.upsert_account(entity.slug, account, started)
            db.insert_snapshot(entity.slug, account, started)
        db.commit()
        result.accounts = len(accounts)
        log(f"[{entity.slug}] {len(accounts)} accounts, balances snapshotted")

        names: dict[str, str] = {}
        try:
            for cp in client.counterparties():
                db.upsert_counterparty(entity.slug, cp)
                if cp.get("name"):
                    names[cp["id"]] = cp["name"]
            db.commit()
        except ApiError as exc:
            log(f"[{entity.slug}] counterparties unavailable ({exc.status_code}); using leg descriptions")
            names = db.counterparty_names(entity.slug)

        categoriser = Categoriser(settings, db.account_ids_by_entity())
        log(f"[{entity.slug}] pulling transactions from {since_dt.date()} to {started.date()}")
        count = 0
        for tx in client.iter_transactions(since_dt, started):
            db.upsert_transaction(entity.slug, tx, names)
            category, rule_id = categoriser.categorise(entity.slug, tx, legs_from_tx(tx, names))
            db.upsert_category(tx["id"], category, rule_id)
            count += 1
            if count % 500 == 0:
                db.commit()
                log(f"[{entity.slug}] {count} transactions so far")
        db.commit()
        result.transactions = count
        log(f"[{entity.slug}] {count} transactions upserted")

        _sync_fx(db, entity, client, accounts, started, result)
        db.commit()
        result.requests = client.requests_made
        db.finish_sync(sync_id, result.accounts, result.transactions)
        return result
    except Exception as exc:
        db.finish_sync(sync_id, result.accounts, result.transactions, error=f"{exc.__class__.__name__}: {exc}")
        raise


def _sync_fx(
    db: DB, entity: Entity, client: RevolutClient, accounts: list[dict], at: datetime, result: SyncResult
) -> None:
    """Best effort: one /rate call per foreign currency held. Never fails the sync."""
    currencies = sorted({a.get("currency") for a in accounts if a.get("currency")} - {entity.base_currency})
    for currency in currencies:
        try:
            payload = client.rate(currency, entity.base_currency)
            rate = payload.get("rate")
            if rate is None and payload.get("to") and payload.get("from"):
                rate = float(payload["to"]["amount"]) / float(payload["from"]["amount"])
            if rate is None:
                raise ValueError("no rate in response")
            db.upsert_fx_rate(entity.slug, at, currency, entity.base_currency, float(rate), "revolut")
            result.fx_rates[f"{currency}->{entity.base_currency}"] = float(rate)
        except (ApiError, ValueError, KeyError, ZeroDivisionError) as exc:
            result.fx_errors.append(f"{currency}->{entity.base_currency}: {exc}")
