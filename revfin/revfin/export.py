"""CSV / JSON / markdown transaction exports. One row per leg."""

from __future__ import annotations

import csv
import io
import json
from datetime import datetime

from .config import Entity, Settings
from .db import DB
from .fx import Converter
from .util import fmt_money

COLUMNS = [
    "entity", "date", "created_at", "completed_at", "transaction_id", "leg_index", "type", "state",
    "account_id", "account_name", "amount", "currency", "amount_base", "base_currency",
    "counterparty_name", "counterparty_id", "merchant_name", "mcc", "reference", "category", "rule_id",
    "balance_after",
]


def export_rows(settings: Settings, db: DB, entity: Entity, start: datetime, end: datetime) -> list[dict]:
    fx = Converter(settings, db, entity)
    rows: list[dict] = []
    for leg in db.leg_rows(entity.slug, start, end):
        rows.append(
            {
                "entity": entity.slug,
                "date": (leg["created_at"] or "")[:10],
                "created_at": leg["created_at"],
                "completed_at": leg["completed_at"],
                "transaction_id": leg["transaction_id"],
                "leg_index": leg["leg_index"],
                "type": leg["type"],
                "state": leg["state"],
                "account_id": leg["account_id"],
                "account_name": settings.account_nicknames.get(leg["account_id"], leg["account_name"]),
                "amount": leg["amount"],
                "currency": leg["currency"],
                "amount_base": fx.to_base(leg["amount"], leg["currency"]),
                "base_currency": entity.base_currency,
                "counterparty_name": leg["counterparty_name"],
                "counterparty_id": leg["counterparty_id"],
                "merchant_name": leg["merchant_name"],
                "mcc": leg["mcc"],
                "reference": leg["reference"],
                "category": leg["category"],
                "rule_id": leg["rule_id"],
                "balance_after": leg["balance_after"],
            }
        )
    return rows


def to_csv(rows: list[dict]) -> str:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=COLUMNS, lineterminator="\n")
    writer.writeheader()
    for row in rows:
        writer.writerow({k: ("" if row.get(k) is None else row.get(k)) for k in COLUMNS})
    return buf.getvalue()


def to_json(rows: list[dict]) -> str:
    return json.dumps(rows, indent=2)


def to_markdown(rows: list[dict], title: str) -> str:
    lines = [f"# {title}", "", f"{len(rows)} rows, one per leg. Amounts are signed from the account's view.", ""]
    lines.append("| Date | Entity | Account | Type | State | Amount | In base | Counterparty / merchant | Reference | Category |")
    lines.append("|---|---|---|---|---|---:|---:|---|---|---|")
    for r in rows:
        who = r["counterparty_name"] or r["merchant_name"] or ""
        lines.append(
            "| {date} | {entity} | {acct} | {type} | {state} | {amt} | {base} | {who} | {ref} | {cat} |".format(
                date=r["date"],
                entity=r["entity"],
                acct=_cell(r["account_name"]),
                type=r["type"] or "",
                state=r["state"] or "",
                amt=fmt_money(r["amount"], r["currency"]),
                base=fmt_money(r["amount_base"], r["base_currency"]) if r["amount_base"] is not None else "n/a",
                who=_cell(who),
                ref=_cell(r["reference"]),
                cat=r["category"],
            )
        )
    return "\n".join(lines) + "\n"


def _cell(value) -> str:
    return str(value or "").replace("|", "\\|").replace("\n", " ")


def render(rows: list[dict], fmt: str, title: str) -> str:
    if fmt == "csv":
        return to_csv(rows)
    if fmt == "json":
        return to_json(rows)
    if fmt == "md":
        return to_markdown(rows, title)
    raise ValueError(f"unknown format {fmt!r}; use csv, json or md")
