"""Cash-basis P&L from the ledger: monthly by line, per entity and consolidated.

"Cash basis" means a line is what actually hit the bank in that month. No
accruals, no invoices raised but unpaid. That is the right basis for a
bank-feed P&L and it reconciles to the balances exactly.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime

from .config import EXCLUDED_FROM_PNL, PNL_SECTIONS, Entity, PnlLine, Settings
from .db import DB
from .fx import Converter, GroupConverter
from .summary import COUNTED_STATES
from .util import iso, month_bounds, parse_ts, shift_month, utcnow

SECTION_LABELS = {
    "revenue": "Revenue",
    "cost_of_sales": "Cost of sales",
    "opex": "Operating expenses",
    "tax": "Tax",
    "equity": "Owner and equity",
}
COST_SECTIONS = ("cost_of_sales", "opex", "tax")

# (key, label, kind) kind: money | pct | count | months
ANALYTICS = [
    ("revenue", "Revenue", "money"),
    ("revenue_mom_pct", "Revenue change vs prior month", "pct"),
    ("revenue_t3m", "Revenue, trailing 3 month average", "money"),
    ("revenue_ytd", "Revenue, year to date", "money"),
    ("cost_of_sales", "Cost of sales", "money"),
    ("gross_profit", "Gross profit", "money"),
    ("gross_margin_pct", "Gross margin", "pct"),
    ("opex", "Operating expenses", "money"),
    ("opex_pct_revenue", "Opex as share of revenue", "pct"),
    ("payroll_pct_revenue", "Payroll as share of revenue", "pct"),
    ("operating_result", "Operating result", "money"),
    ("tax", "Tax paid", "money"),
    ("net_result", "Net cash result", "money"),
    ("net_margin_pct", "Net margin", "pct"),
    ("net_result_ytd", "Net cash result, year to date", "money"),
    ("cumulative_net", "Cumulative net since start", "money"),
    ("active_clients", "Paying clients in month", "count"),
    ("top_client_share_pct", "Largest client share of revenue", "pct"),
    ("uncategorised_spend", "Uncategorised spend", "money"),
    ("cash_end", "Cash at month end", "money"),
    ("net_burn", "Net burn (0 when cash positive)", "money"),
    ("runway_months", "Runway at trailing 3 month burn", "months"),
]


@dataclass
class LineSeries:
    key: str
    label: str
    section: str
    values: dict[str, float] = field(default_factory=dict)

    def total(self) -> float:
        return round(sum(self.values.values()), 2)


@dataclass
class EntityPnl:
    slug: str
    name: str
    currency: str
    months: list[str]
    lines: list[LineSeries]
    sections: dict[str, dict[str, float]]
    clients: dict[str, dict[str, float]]
    client_meta: dict[str, dict]
    vendors: dict[str, dict]
    cash: dict[str, dict[str, float | None]]
    cash_currency: dict[str, str]
    cash_total: dict[str, float | None]
    analytics: dict[str, dict[str, float | None]]
    fx_notes: list[str]

    # Signed helpers: revenue positive, costs positive numbers (outflow magnitude).
    def revenue(self, m: str) -> float:
        return round(self.sections["revenue"].get(m, 0.0), 2)

    def cost(self, section: str, m: str) -> float:
        return round(-self.sections[section].get(m, 0.0), 2)

    def gross_profit(self, m: str) -> float:
        return round(self.revenue(m) - self.cost("cost_of_sales", m), 2)

    def operating_result(self, m: str) -> float:
        return round(self.gross_profit(m) - self.cost("opex", m), 2)

    def net_result(self, m: str) -> float:
        return round(self.operating_result(m) - self.cost("tax", m), 2)

    def net_after_equity(self, m: str) -> float:
        return round(self.net_result(m) - self.cost("equity", m), 2)


@dataclass
class PnlModel:
    generated_at: datetime
    months: list[str]
    group_currency: str
    entities: list[EntityPnl]
    group: EntityPnl
    ledger: list[dict]
    uncategorised: list[dict]
    lines_map: list[PnlLine]
    fx_notes: list[str]

    def all_views(self) -> list[EntityPnl]:
        return [*self.entities, self.group]

    def to_json(self) -> dict:
        def view(v: EntityPnl) -> dict:
            return {
                "name": v.name,
                "currency": v.currency,
                "lines": {l.key: {"label": l.label, "section": l.section, "values": l.values, "total": l.total()} for l in v.lines},
                "sections": v.sections,
                "derived": {
                    m: {"gross_profit": v.gross_profit(m), "operating_result": v.operating_result(m), "net_result": v.net_result(m)}
                    for m in v.months
                },
                "clients": v.clients,
                "vendors": {k: {"category": d["category"], "total": d["total"]} for k, d in v.vendors.items()},
                "cash_total": v.cash_total,
                "analytics": v.analytics,
                "fx_notes": v.fx_notes,
            }

        return {
            "generated_at": self.generated_at.isoformat(),
            "months": self.months,
            "group_currency": self.group_currency,
            "entities": {e.slug: view(e) for e in self.entities},
            "group": view(self.group),
            "ledger_rows": len(self.ledger),
            "uncategorised_rows": len(self.uncategorised),
        }


def _who(row: dict) -> str:
    return row.get("counterparty_name") or row.get("merchant_name") or "unknown"


def _months_between(first: str, last: str) -> list[str]:
    months = [first]
    while months[-1] < last:
        months.append(shift_month(months[-1], 1))
    return months


def build_pnl(
    settings: Settings, db: DB, start_month: str | None = None, end_month: str | None = None, now: datetime | None = None
) -> PnlModel:
    now = now or utcnow()
    group_fx = GroupConverter(settings, db)
    line_lookup = {l.category: l for l in settings.pnl_lines}
    fx_notes: list[str] = []

    ledger: list[dict] = []
    per_entity_rows: dict[str, list[dict]] = {}
    for entity in settings.entities.values():
        fx = Converter(settings, db, entity)
        rows = db.leg_rows(entity.slug)
        for r in rows:
            r["entity_name"] = entity.name
            r["month"] = (r["created_at"] or "")[:7]
            r["base_currency"] = entity.base_currency
            r["amount_base"] = fx.to_base(r["amount"], r["currency"])
            r["amount_group"] = group_fx.convert(r["amount_base"], entity.base_currency)
            r["group_currency"] = settings.group_currency
            r["counted"] = r["state"] in COUNTED_STATES and r["category"] not in EXCLUDED_FROM_PNL
            line = line_lookup.get(r["category"])
            if r["category"] in EXCLUDED_FROM_PNL:
                r["pnl_section"], r["pnl_line"] = "excluded", r["category"]
            elif line:
                r["pnl_section"], r["pnl_line"] = line.section, line.label
            else:
                r["pnl_section"], r["pnl_line"] = "opex", r["category"]
            r["who"] = _who(r)
        per_entity_rows[entity.slug] = rows
        ledger.extend(rows)
        for ccy, info in sorted(fx.used_rates().items()):
            if ccy != entity.base_currency:
                fx_notes.append(f"{entity.slug}: {ccy}->{entity.base_currency} {info.rate:.4f} ({info.source})")
        for ccy in sorted(fx.unconverted):
            fx_notes.append(f"{entity.slug}: no rate for {ccy}, those legs are excluded from {entity.base_currency} figures")
    ledger.sort(key=lambda r: (r["created_at"], r["transaction_id"], r["leg_index"]))

    counted_months = sorted({r["month"] for r in ledger if r["counted"] and r["month"]})
    if not counted_months and not (start_month and end_month):
        first = last = now.strftime("%Y-%m")
    else:
        first = start_month or counted_months[0]
        last = end_month or counted_months[-1]
    months = _months_between(first, last)

    entities_pnl = [
        _build_view(settings, db, entity, per_entity_rows[entity.slug], months, "amount_base", entity.base_currency,
                    Converter(settings, db, entity), line_lookup)
        for entity in settings.entities.values()
    ]
    group = _build_group(settings, db, ledger, months, entities_pnl, group_fx, line_lookup)
    for ccy, info in sorted(group_fx.used_rates().items()):
        fx_notes.append(f"group: {ccy}->{settings.group_currency} {info.rate:.4f} ({info.source})")
    for ccy in sorted(group_fx.unconverted):
        fx_notes.append(f"group: no rate for {ccy}, that entity is excluded from the consolidated view")

    uncategorised = [r for r in ledger if r["counted"] and r["category"] == "uncategorised"]
    return PnlModel(now, months, settings.group_currency, entities_pnl, group, ledger, uncategorised, settings.pnl_lines, fx_notes)


def _build_view(
    settings: Settings, db: DB, entity: Entity | None, rows: list[dict], months: list[str], amount_key: str,
    currency: str, converter, line_lookup: dict[str, PnlLine], slug: str | None = None, name: str | None = None,
) -> EntityPnl:
    month_set = set(months)
    counted = [r for r in rows if r["counted"] and r["month"] in month_set and r.get(amount_key) is not None]

    lines: dict[str, LineSeries] = {
        l.category: LineSeries(l.category, l.label, l.section, {m: 0.0 for m in months}) for l in settings.pnl_lines
    }
    for r in counted:
        if r["category"] not in lines:
            lines[r["category"]] = LineSeries(r["category"], r["category"], "opex", {m: 0.0 for m in months})
        lines[r["category"]].values[r["month"]] = round(lines[r["category"]].values[r["month"]] + r[amount_key], 2)

    sections = {s: {m: 0.0 for m in months} for s in PNL_SECTIONS}
    for line in lines.values():
        for m, v in line.values.items():
            sections[line.section][m] = round(sections[line.section][m] + v, 2)

    clients: dict[str, dict[str, float]] = defaultdict(lambda: {m: 0.0 for m in months})
    client_meta: dict[str, dict] = {}
    vendors: dict[str, dict] = {}
    for r in counted:
        amt = r[amount_key]
        if r["pnl_section"] == "revenue" and amt > 0:
            clients[r["who"]][r["month"]] = round(clients[r["who"]][r["month"]] + amt, 2)
            meta = client_meta.setdefault(r["who"], {"first": r["created_at"][:10], "last": r["created_at"][:10], "receipts": 0})
            meta["first"] = min(meta["first"], r["created_at"][:10])
            meta["last"] = max(meta["last"], r["created_at"][:10])
            meta["receipts"] += 1
        elif r["pnl_section"] in COST_SECTIONS and amt < 0:
            v = vendors.setdefault(r["who"], {"category": r["category"], "months": {m: 0.0 for m in months}, "total": 0.0, "items": 0})
            v["months"][r["month"]] = round(v["months"][r["month"]] - amt, 2)
            v["total"] = round(v["total"] - amt, 2)
            v["items"] += 1
    vendors = dict(sorted(vendors.items(), key=lambda kv: -kv[1]["total"]))
    clients = dict(sorted(clients.items(), key=lambda kv: -sum(kv[1].values())))

    cash, cash_ccy, cash_total = ({}, {}, {m: None for m in months})
    if entity is not None:
        cash, cash_ccy, cash_total = _month_end_cash(settings, db, entity, months, converter)

    view = EntityPnl(
        slug=slug or entity.slug, name=name or entity.name, currency=currency, months=months,
        lines=list(lines.values()), sections=sections, clients=clients, client_meta=client_meta, vendors=vendors,
        cash=cash, cash_currency=cash_ccy, cash_total=cash_total, analytics={}, fx_notes=[],
    )
    view.analytics = _analytics(view)
    return view


def _build_group(settings, db, ledger, months, entities_pnl, group_fx, line_lookup) -> EntityPnl:
    view = _build_view(settings, db, None, ledger, months, "amount_group", settings.group_currency, group_fx, line_lookup,
                       slug="group", name="Group consolidated")
    # Cash: sum each entity's month-end total converted to the group currency.
    for m in months:
        total = None
        for e in entities_pnl:
            value = e.cash_total.get(m)
            if value is None:
                continue
            converted = group_fx.convert(value, e.currency)
            if converted is None:
                continue
            total = (total or 0.0) + converted
        view.cash_total[m] = None if total is None else round(total, 2)
    view.cash = {
        f"{e.name} ({e.currency})": {m: e.cash_total.get(m) for m in months} for e in entities_pnl
    }
    view.cash_currency = {f"{e.name} ({e.currency})": e.currency for e in entities_pnl}
    view.analytics = _analytics(view)
    return view


def _month_end_cash(settings: Settings, db: DB, entity: Entity, months: list[str], converter: Converter):
    """Month-end balance per account: newest of (snapshot <= month end, last completed leg <= month end)."""
    cash: dict[str, dict[str, float | None]] = {}
    currencies: dict[str, str] = {}
    totals: dict[str, float | None] = {}
    accounts = db.accounts_for(entity.slug)
    for m in months:
        _, end = month_bounds(m)
        total: float | None = None
        for account in accounts:
            label = settings.account_nicknames.get(account["id"], account["name"] or account["id"])
            label = f"{label} ({account['currency']})"
            currencies[label] = account["currency"]
            balance: float | None = None
            stamp = ""
            snap = db.snapshot_at(entity.slug, account["id"], end)
            if snap:
                balance, stamp = float(snap["balance"]), snap["taken_at"]
            leg = db.conn.execute(
                "SELECT l.balance_after, t.created_at FROM legs l JOIN transactions t ON t.id=l.transaction_id"
                " WHERE l.account_id=? AND t.state='completed' AND l.balance_after IS NOT NULL AND t.created_at < ?"
                " ORDER BY t.created_at DESC LIMIT 1",
                (account["id"], iso(end)),
            ).fetchone()
            if leg and (not stamp or (parse_ts(leg["created_at"]) or end) > (parse_ts(stamp) or end)):
                balance = float(leg["balance_after"])
            cash.setdefault(label, {})[m] = balance
            if balance is not None:
                converted = converter.to_base(balance, account["currency"])
                if converted is not None:
                    total = (total or 0.0) + converted
        totals[m] = None if total is None else round(total, 2)
    return cash, currencies, totals


def _pct(numerator: float | None, denominator: float | None) -> float | None:
    if numerator is None or not denominator:
        return None
    return round(numerator / denominator, 4)


def _analytics(v: EntityPnl) -> dict[str, dict[str, float | None]]:
    a: dict[str, dict[str, float | None]] = {key: {} for key, _, _ in ANALYTICS}
    cumulative = 0.0
    payroll = next((l for l in v.lines if l.key == "payroll"), None)
    uncategorised = next((l for l in v.lines if l.key == "uncategorised"), None)
    for i, m in enumerate(v.months):
        revenue = v.revenue(m)
        prev_rev = v.revenue(v.months[i - 1]) if i else None
        window = v.months[max(0, i - 2): i + 1]
        year_months = [x for x in v.months[: i + 1] if x[:4] == m[:4]]
        net = v.net_result(m)
        cumulative = round(cumulative + net, 2)
        gp = v.gross_profit(m)
        opex = v.cost("opex", m)
        a["revenue"][m] = revenue
        a["revenue_mom_pct"][m] = _pct(revenue - prev_rev, prev_rev) if prev_rev else None
        a["revenue_t3m"][m] = round(sum(v.revenue(x) for x in window) / len(window), 2)
        a["revenue_ytd"][m] = round(sum(v.revenue(x) for x in year_months), 2)
        a["cost_of_sales"][m] = v.cost("cost_of_sales", m)
        a["gross_profit"][m] = gp
        a["gross_margin_pct"][m] = _pct(gp, revenue)
        a["opex"][m] = opex
        a["opex_pct_revenue"][m] = _pct(opex, revenue)
        a["payroll_pct_revenue"][m] = _pct(-payroll.values.get(m, 0.0), revenue) if payroll else None
        a["operating_result"][m] = v.operating_result(m)
        a["tax"][m] = v.cost("tax", m)
        a["net_result"][m] = net
        a["net_margin_pct"][m] = _pct(net, revenue)
        a["net_result_ytd"][m] = round(sum(v.net_result(x) for x in year_months), 2)
        a["cumulative_net"][m] = cumulative
        month_clients = {c: vals.get(m, 0.0) for c, vals in v.clients.items() if vals.get(m, 0.0) > 0}
        a["active_clients"][m] = len(month_clients)
        a["top_client_share_pct"][m] = _pct(max(month_clients.values()), revenue) if month_clients else None
        a["uncategorised_spend"][m] = round(-min(uncategorised.values.get(m, 0.0), 0.0), 2) if uncategorised else 0.0
        cash_end = v.cash_total.get(m)
        a["cash_end"][m] = cash_end
        burn = round(-net, 2) if net < 0 else 0.0
        a["net_burn"][m] = burn
        burns = [a["net_burn"][x] for x in window]
        avg_burn = sum(burns) / len(burns) if burns else 0.0
        a["runway_months"][m] = round(cash_end / avg_burn, 1) if cash_end is not None and avg_burn > 0 else None
    return a
