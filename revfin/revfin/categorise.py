"""Rule-based tagging. Built-ins first (fee, exchange, internal, intercompany),
then the regex rules from config.yaml in order; first match wins.

Nothing clever here on purpose. Anything unmatched is 'uncategorised' and
gets listed in the summary so a human or Claude can propose a rule.
"""

from __future__ import annotations

import re

from .config import Entity, Rule, Settings
from .db import DB

UNCATEGORISED = "uncategorised"
# Categories the summary keeps out of money-in / money-out totals.
NON_FLOW_CATEGORIES = {"fx", "internal", "intercompany"}


class Categoriser:
    def __init__(
        self,
        settings: Settings,
        own_accounts: dict[str, set[str]] | None = None,
    ):
        self.rules: list[Rule] = settings.rules
        self.entities: dict[str, Entity] = settings.entities
        self.own_accounts: dict[str, set[str]] = own_accounts or {}
        self._intercompany: dict[str, re.Pattern] = {}
        for slug, entity in self.entities.items():
            pattern = entity.intercompany_pattern or re.escape(entity.name)
            self._intercompany[slug] = re.compile(pattern, re.IGNORECASE)

    def categorise(self, entity_slug: str, tx: dict, legs: list[dict]) -> tuple[str, str | None]:
        tx_type = (tx.get("type") or "").lower()
        if tx_type == "fee":
            return "bank_fee", "builtin:fee"
        if tx_type == "exchange":
            return "fx", "builtin:exchange"

        own = self.own_accounts.get(entity_slug, set())
        leg_accounts = {leg.get("account_id") for leg in legs}
        if tx_type == "transfer" and len(legs) >= 2 and leg_accounts and leg_accounts <= own:
            return "internal", "builtin:internal"

        if self._is_intercompany(entity_slug, tx, legs):
            return "intercompany", "builtin:intercompany"

        merchant = ((tx.get("merchant") or {}).get("name")) or ""
        reference = tx.get("reference") or ""
        names = [leg.get("counterparty_name") or "" for leg in legs]
        amounts = [float(leg.get("amount") or 0) for leg in legs]

        for rule in self.rules:
            if rule.type and rule.type.lower() != tx_type:
                continue
            if rule.direction == "in" and not any(a > 0 for a in amounts):
                continue
            if rule.direction == "out" and not any(a < 0 for a in amounts):
                continue
            if rule.merchant_name and not rule.merchant_name.search(merchant):
                continue
            if rule.counterparty_name and not any(rule.counterparty_name.search(n) for n in names):
                continue
            if rule.reference and not rule.reference.search(reference):
                continue
            return rule.category, rule.id
        return UNCATEGORISED, None

    def _is_intercompany(self, entity_slug: str, tx: dict, legs: list[dict]) -> bool:
        raw_legs = tx.get("legs") or []
        for slug, pattern in self._intercompany.items():
            if slug == entity_slug:
                continue
            other_accounts = self.own_accounts.get(slug, set())
            for leg in raw_legs:
                cp = leg.get("counterparty") or {}
                if cp.get("account_id") and cp["account_id"] in other_accounts:
                    return True
            for leg in legs:
                if leg.get("counterparty_name") and pattern.search(leg["counterparty_name"]):
                    return True
        return False


def legs_from_tx(tx: dict, counterparty_names: dict[str, str]) -> list[dict]:
    """Shape raw API legs like the stored `legs` rows the categoriser expects."""
    from .db import counterparty_name_from_leg

    return [
        {
            "account_id": leg.get("account_id"),
            "amount": float(leg.get("amount") or 0),
            "currency": leg.get("currency"),
            "counterparty_name": counterparty_name_from_leg(leg, counterparty_names),
        }
        for leg in tx.get("legs") or []
    ]


def recategorise(settings: Settings, db: DB, entity_slug: str) -> dict[str, int]:
    """Re-apply the rules to every stored transaction (after editing config.yaml)."""
    categoriser = Categoriser(settings, db.account_ids_by_entity())
    counts: dict[str, int] = {}
    for tx, legs in db.transactions_with_legs(entity_slug):
        category, rule_id = categoriser.categorise(entity_slug, tx, legs)
        db.upsert_category(tx["id"], category, rule_id)
        counts[category] = counts.get(category, 0) + 1
    db.commit()
    return counts
