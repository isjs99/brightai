"""Monthly markdown summary: the hand-off document for Claude.

Plain markdown, under 300 lines, thousands separators and currency codes on
every number, and a JSON block at the bottom with the same figures.
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime

from .categorise import NON_FLOW_CATEGORIES, UNCATEGORISED
from .config import Entity, Settings
from .db import DB
from .fx import Converter
from .util import days_ago, fmt_money, fmt_signed, iso, month_bounds, month_label, shift_month, utcnow

COUNTED_STATES = {"completed", "pending"}
FAILED_STATES = {"declined", "reverted", "failed"}
MAX_LINES = 300
TOP_N = 8
MAX_UNCATEGORISED = 15
MAX_NEW_COUNTERPARTIES = 10
MAX_LIST = 10
MIN_SWING_BASE = 100.0


def _who(row: dict) -> str:
    return row.get("counterparty_name") or row.get("merchant_name") or "unknown"


def summarise_entity(settings: Settings, db: DB, entity: Entity, month: str, as_of: datetime) -> tuple[list[str], dict]:
    fx = Converter(settings, db, entity)
    base = entity.base_currency
    start, end = month_bounds(month)
    prev_month = shift_month(month, -1)
    prev_start, prev_end = month_bounds(prev_month)
    burn_start, _ = month_bounds(shift_month(month, -2))
    nick = settings.account_nicknames

    # -- cash position -------------------------------------------------------
    cash_rows: list[dict] = []
    totals = {"now": 0.0, "d7": 0.0, "d30": 0.0}
    for account in db.accounts_for(entity.slug):
        points = {}
        for key, at in (("now", as_of), ("d7", days_ago(as_of, 7)), ("d30", days_ago(as_of, 30))):
            snap = db.snapshot_at(entity.slug, account["id"], at)
            points[key] = float(snap["balance"]) if snap else None
        if points["now"] is None:
            points["now"] = float(account["last_seen_balance"] or 0)
        now_base = fx.to_base(points["now"], account["currency"])
        cash_rows.append(
            {
                "account_id": account["id"],
                "name": nick.get(account["id"], account["name"]),
                "currency": account["currency"],
                "now": points["now"],
                "d7": points["d7"],
                "d30": points["d30"],
                "now_base": now_base,
            }
        )
        for key in totals:
            converted = fx.to_base(points[key], account["currency"])
            if converted is not None:
                totals[key] += converted

    # -- flows ----------------------------------------------------------------
    rows = db.leg_rows(entity.slug, burn_start, end)
    for r in rows:
        r["amount_base"] = fx.to_base(r["amount"], r["currency"])
        r["month"] = r["created_at"][:7]
        r["counted"] = r["state"] in COUNTED_STATES and r["category"] not in NON_FLOW_CATEGORIES

    this_rows = [r for r in rows if iso(start) <= r["created_at"] < iso(end)]
    prev_rows = [r for r in rows if iso(prev_start) <= r["created_at"] < iso(prev_end)]

    def flows(subset: list[dict]) -> dict:
        money_in = sum(r["amount_base"] or 0 for r in subset if r["counted"] and r["amount"] > 0)
        money_out = sum(-(r["amount_base"] or 0) for r in subset if r["counted"] and r["amount"] < 0)
        return {"in": round(money_in, 2), "out": round(money_out, 2), "net": round(money_in - money_out, 2)}

    this_flow, prev_flow = flows(this_rows), flows(prev_rows)

    by_cat: dict[str, dict] = defaultdict(lambda: {"in": 0.0, "out": 0.0, "count": 0})
    prev_by_cat: dict[str, float] = defaultdict(float)
    who_in: dict[str, float] = defaultdict(float)
    who_out: dict[str, float] = defaultdict(float)
    clients: dict[str, float] = defaultdict(float)
    for r in this_rows:
        if not r["counted"]:
            continue
        amt = r["amount_base"] or 0
        cat = by_cat[r["category"]]
        cat["count"] += 1
        if amt > 0:
            cat["in"] += amt
            who_in[_who(r)] += amt
            if r["category"] == "client_receipt":
                clients[_who(r)] += amt
        else:
            cat["out"] += -amt
            who_out[_who(r)] += -amt
    for r in prev_rows:
        if r["counted"]:
            prev_by_cat[r["category"]] += abs(r["amount_base"] or 0)

    internal = [r for r in this_rows if r["category"] == "internal"]
    exchanges = [r for r in this_rows if r["category"] == "fx" and r["state"] in COUNTED_STATES]
    intercompany = [r for r in this_rows if r["category"] == "intercompany" and r["state"] in COUNTED_STATES]
    intercompany_net = round(sum(r["amount_base"] or 0 for r in intercompany), 2)
    pending = [r for r in this_rows if r["state"] == "pending"]

    # -- unusual ----------------------------------------------------------------
    threshold = settings.unusual_threshold
    large = [r for r in this_rows if r["counted"] and r["amount_base"] is not None and r["amount_base"] <= -threshold]
    seen_before = db.counterparties_seen_before(entity.slug, start)
    new_names: dict[str, float] = defaultdict(float)
    for r in this_rows:
        name = _who(r)
        if r["counted"] and name != "unknown" and name.lower() not in seen_before:
            new_names[name] += r["amount_base"] or 0
    failed = [r for r in this_rows if r["state"] in FAILED_STATES]
    swings = []
    for cat in sorted(set(by_cat) | set(prev_by_cat)):
        if cat in NON_FLOW_CATEGORIES:
            continue
        now_total = by_cat[cat]["in"] + by_cat[cat]["out"] if cat in by_cat else 0.0
        prev_total = prev_by_cat.get(cat, 0.0)
        if max(now_total, prev_total) < MIN_SWING_BASE:
            continue
        pct = None if prev_total == 0 else (now_total - prev_total) / prev_total * 100
        if pct is None or abs(pct) > settings.unusual_mom_pct:
            swings.append({"category": cat, "this": round(now_total, 2), "prev": round(prev_total, 2),
                           "pct": None if pct is None else round(pct, 1)})

    uncategorised = [r for r in this_rows if r["category"] == UNCATEGORISED and r["state"] in COUNTED_STATES]

    # -- runway -------------------------------------------------------------------
    months = [shift_month(month, -2), prev_month, month]
    net_by_month = {m: flows([r for r in rows if r["month"] == m])["net"] for m in months}
    avg_net = sum(net_by_month.values()) / len(months)
    avg_burn = round(-avg_net, 2) if avg_net < 0 else 0.0
    runway_months = round(totals["now"] / avg_burn, 1) if avg_burn > 0 else None

    # -- markdown -------------------------------------------------------------------
    L: list[str] = []
    L.append(f"## {entity.name} ({entity.slug}), reporting in {base}")
    L.append("")
    rate_bits = [f"{ccy}->{base} {info.rate:.4f} ({info.source})" for ccy, info in sorted(fx.used_rates().items()) if ccy != base]
    if rate_bits:
        L.append("FX used: " + ", ".join(rate_bits) + ".")
    if fx.unconverted:
        L.append(f"No FX rate for: {', '.join(sorted(fx.unconverted))}. Those amounts are left out of {base} totals.")
    last = db.last_successful_sync(entity.slug)
    L.append(f"Last successful sync: {last['finished_at'][:16].replace('T', ' ')} UTC." if last else "No successful sync recorded.")
    L.append("")

    L.append(f"### Cash position as of {as_of.date().isoformat()}")
    L.append("")
    L.append("| Account | Currency | Now | 7 days ago | 30 days ago | Now in " + base + " |")
    L.append("|---|---|---:|---:|---:|---:|")
    for c in cash_rows:
        L.append(
            f"| {c['name'] or c['account_id']} | {c['currency']} | {fmt_money(c['now'])} | {fmt_money(c['d7'])} | "
            f"{fmt_money(c['d30'])} | {fmt_money(c['now_base'])} |"
        )
    L.append(
        f"| **Total in {base}** | | **{fmt_money(totals['now'])}** | {fmt_money(totals['d7'])} | {fmt_money(totals['d30'])} | |"
    )
    L.append("")

    L.append(f"### Money in vs out, {month_label(month)}")
    L.append("")
    L.append(f"- In: {fmt_money(this_flow['in'], base)} (prev month {fmt_money(prev_flow['in'], base)})")
    L.append(f"- Out: {fmt_money(this_flow['out'], base)} (prev month {fmt_money(prev_flow['out'], base)})")
    L.append(f"- Net: {fmt_signed(this_flow['net'], base)} (prev month {fmt_signed(prev_flow['net'], base)})")
    excluded = [
        f"{len(internal) // 2 or len(internal)} internal transfers" if internal else None,
        f"{len(exchanges) // 2 or len(exchanges)} FX exchanges" if exchanges else None,
        f"intercompany net {fmt_signed(intercompany_net, base)} across {len(intercompany)} leg(s)" if intercompany else None,
    ]
    excluded = [e for e in excluded if e]
    L.append("- Excluded from in/out: " + (", ".join(excluded) if excluded else "nothing") + ".")
    if pending:
        L.append(f"- {len(pending)} pending items are included and may still change.")
    L.append("")

    L.append("#### By category")
    L.append("")
    L.append("| Category | In | Out | Items | Prev month total |")
    L.append("|---|---:|---:|---:|---:|")
    for cat, v in sorted(by_cat.items(), key=lambda kv: -(kv[1]["in"] + kv[1]["out"])):
        L.append(f"| {cat} | {fmt_money(v['in'])} | {fmt_money(v['out'])} | {v['count']} | {fmt_money(prev_by_cat.get(cat, 0.0))} |")
    L.append("")

    top_in = sorted(who_in.items(), key=lambda kv: -kv[1])[:TOP_N]
    top_out = sorted(who_out.items(), key=lambda kv: -kv[1])[:TOP_N]
    L.append(f"#### Top counterparties in ({base})")
    L.append("")
    L.extend(f"- {name}: {fmt_money(amt)}" for name, amt in top_in) if top_in else L.append("- none")
    L.append("")
    L.append(f"#### Top counterparties out ({base})")
    L.append("")
    L.extend(f"- {name}: {fmt_money(amt)}" for name, amt in top_out) if top_out else L.append("- none")
    L.append("")

    L.append(f"#### Client receipts by client ({base})")
    L.append("")
    if clients:
        L.extend(f"- {name}: {fmt_money(amt)}" for name, amt in sorted(clients.items(), key=lambda kv: -kv[1])[:TOP_N])
        L.append(f"- Total: {fmt_money(sum(clients.values()))}")
    else:
        L.append("- none tagged client_receipt this month")
    L.append("")

    L.append("### Unusual items")
    L.append("")
    if large:
        L.append(f"Single outgoing legs over {fmt_money(threshold, base)}:")
        for r in large[:MAX_LIST]:
            L.append(f"- {r['created_at'][:10]} {_who(r)}: {fmt_money(r['amount'], r['currency'])} ({r['category']}, {r['state']})")
    if new_names:
        L.append(f"Counterparties seen for the first time this month ({len(new_names)}):")
        for name, amt in sorted(new_names.items(), key=lambda kv: -abs(kv[1]))[:MAX_NEW_COUNTERPARTIES]:
            L.append(f"- {name}: {fmt_signed(amt, base)}")
    if failed:
        L.append("Declined or reverted:")
        for r in failed[:MAX_LIST]:
            L.append(f"- {r['created_at'][:10]} {_who(r)}: {fmt_money(r['amount'], r['currency'])} ({r['state']})")
    if swings:
        L.append(f"Month-on-month category change over {settings.unusual_mom_pct:g}%:")
        for s in swings[:MAX_LIST]:
            change = "new this month" if s["pct"] is None else f"{s['pct']:+.0f}%"
            L.append(f"- {s['category']}: {fmt_money(s['prev'], base)} -> {fmt_money(s['this'], base)} ({change})")
    if not (large or new_names or failed or swings):
        L.append("- nothing flagged")
    L.append("")

    L.append(f"### Uncategorised ({len(uncategorised)} legs)")
    L.append("")
    if uncategorised:
        L.append("| Date | Counterparty / merchant | Reference | Amount |")
        L.append("|---|---|---|---:|")
        for r in uncategorised[:MAX_UNCATEGORISED]:
            L.append(f"| {r['created_at'][:10]} | {_who(r)} | {(r['reference'] or '')[:40]} | {fmt_money(r['amount'], r['currency'])} |")
        if len(uncategorised) > MAX_UNCATEGORISED:
            L.append(f"| ... | {len(uncategorised) - MAX_UNCATEGORISED} more in the CSV export | | |")
        L.append("")
        L.append("Propose a rule for each in config.yaml under `categories` and run `revfin categorise`.")
    else:
        L.append("- everything tagged")
    L.append("")

    L.append("### Runway")
    L.append("")
    trail = ", ".join(f"{month_label(m)} {fmt_signed(net_by_month[m], base)}" for m in months)
    L.append(f"- Net by month: {trail}")
    if runway_months is not None:
        L.append(f"- Average burn {fmt_money(avg_burn, base)}/month against cash {fmt_money(totals['now'], base)}: about {runway_months:g} months.")
    else:
        L.append(f"- Cash positive over the last 3 months (average net {fmt_signed(round(avg_net, 2), base)}/month), no burn to estimate.")
    L.append("")

    figures = {
        "name": entity.name,
        "base_currency": base,
        "as_of": as_of.date().isoformat(),
        "cash": {"now": round(totals["now"], 2), "d7": round(totals["d7"], 2), "d30": round(totals["d30"], 2),
                 "accounts": [{k: c[k] for k in ("name", "currency", "now", "d7", "d30", "now_base")} for c in cash_rows]},
        "flows": {"this": this_flow, "prev": prev_flow},
        "by_category": {k: {"in": round(v["in"], 2), "out": round(v["out"], 2), "count": v["count"]} for k, v in by_cat.items()},
        "top_in": [[n, round(a, 2)] for n, a in top_in],
        "top_out": [[n, round(a, 2)] for n, a in top_out],
        "clients": {n: round(a, 2) for n, a in clients.items()},
        "intercompany_net": intercompany_net,
        "unusual": {
            "large_outgoing": [[r["created_at"][:10], _who(r), r["amount"], r["currency"]] for r in large],
            "new_counterparties": {n: round(a, 2) for n, a in new_names.items()},
            "failed": len(failed),
            "swings": swings,
        },
        "uncategorised": len(uncategorised),
        "pending": len(pending),
        "runway": {"net_by_month": net_by_month, "avg_burn": avg_burn, "months": runway_months},
        "fx": {ccy: {"rate": info.rate, "source": info.source} for ccy, info in fx.used_rates().items() if ccy != base},
        "unconverted_currencies": sorted(fx.unconverted),
    }
    return L, figures


def write_summary(
    settings: Settings, db: DB, entities: list[Entity], month: str, as_of: datetime | None = None
) -> str:
    generated = utcnow()
    as_of = as_of or generated
    lines = [f"# Finance summary, {month_label(month)}", ""]
    lines.append(
        f"Generated {generated.strftime('%Y-%m-%d %H:%M')} UTC by revfin from Revolut Business ({settings.env}). "
        "Read-only data; amounts are signed from the account's point of view."
    )
    lines.append("")
    figures: dict = {"month": month, "generated_at": generated.isoformat(), "as_of": as_of.date().isoformat(),
                     "env": settings.env, "entities": {}}
    for entity in entities:
        section, fig = summarise_entity(settings, db, entity, month, as_of)
        lines.extend(section)
        figures["entities"][entity.slug] = fig

    body = "\n".join(lines)
    json_block = json.dumps(figures, indent=2)
    if body.count("\n") + json_block.count("\n") + 6 > MAX_LINES:
        json_block = json.dumps(figures, separators=(",", ":"))
    return f"{body}\n## Data\n\n```json\n{json_block}\n```\n"
