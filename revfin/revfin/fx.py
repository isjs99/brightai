"""Convert leg amounts to an entity's reporting currency.

Rate lookup order: latest rate synced from Revolut's /rate endpoint, then
fx.rates in config.yaml (either direction), then none (flagged, not guessed).
"""

from __future__ import annotations

from dataclasses import dataclass

from .config import Entity, Settings
from .db import DB


@dataclass
class RateInfo:
    rate: float
    source: str  # "revolut YYYY-MM-DD" or "config"


class Converter:
    def __init__(self, settings: Settings, db: DB, entity: Entity):
        self.settings = settings
        self.db = db
        self.entity = entity
        self.base = entity.base_currency
        self._cache: dict[str, RateInfo | None] = {}
        self.unconverted: set[str] = set()

    def rate(self, currency: str) -> RateInfo | None:
        if currency == self.base:
            return RateInfo(1.0, "base")
        if currency in self._cache:
            return self._cache[currency]
        info: RateInfo | None = None
        row = self.db.latest_fx_rate(self.entity.slug, currency, self.base)
        if row:
            info = RateInfo(float(row["rate"]), f"revolut {row['taken_at'][:10]}")
        else:
            direct = self.settings.fx_rates.get((currency, self.base))
            inverse = self.settings.fx_rates.get((self.base, currency))
            if direct:
                info = RateInfo(float(direct), "config")
            elif inverse:
                info = RateInfo(1.0 / float(inverse), "config")
        self._cache[currency] = info
        if info is None:
            self.unconverted.add(currency)
        return info

    def to_base(self, amount: float | None, currency: str | None) -> float | None:
        if amount is None or not currency:
            return None
        info = self.rate(currency)
        if info is None:
            return None
        return round(amount * info.rate, 2)

    def used_rates(self) -> dict[str, RateInfo]:
        return {ccy: info for ccy, info in self._cache.items() if info is not None}


class GroupConverter:
    """Convert any entity's base-currency figures into the group reporting currency.

    Uses the newest synced rate from any entity, then config, then none.
    """

    def __init__(self, settings: Settings, db: DB, group_currency: str | None = None):
        self.settings = settings
        self.db = db
        self.currency = group_currency or settings.group_currency
        self._cache: dict[str, RateInfo | None] = {}
        self.unconverted: set[str] = set()

    def rate(self, currency: str) -> RateInfo | None:
        if currency == self.currency:
            return RateInfo(1.0, "base")
        if currency in self._cache:
            return self._cache[currency]
        info: RateInfo | None = None
        row = self.db.conn.execute(
            "SELECT rate, taken_at FROM fx_rates WHERE from_currency=? AND to_currency=? ORDER BY taken_at DESC LIMIT 1",
            (currency, self.currency),
        ).fetchone()
        inverse_row = None if row else self.db.conn.execute(
            "SELECT rate, taken_at FROM fx_rates WHERE from_currency=? AND to_currency=? ORDER BY taken_at DESC LIMIT 1",
            (self.currency, currency),
        ).fetchone()
        if row:
            info = RateInfo(float(row["rate"]), f"revolut {row['taken_at'][:10]}")
        elif inverse_row and float(inverse_row["rate"]):
            info = RateInfo(1.0 / float(inverse_row["rate"]), f"revolut {inverse_row['taken_at'][:10]} (inverted)")
        else:
            direct = self.settings.fx_rates.get((currency, self.currency))
            inverse = self.settings.fx_rates.get((self.currency, currency))
            if direct:
                info = RateInfo(float(direct), "config")
            elif inverse:
                info = RateInfo(1.0 / float(inverse), "config")
        self._cache[currency] = info
        if info is None:
            self.unconverted.add(currency)
        return info

    def convert(self, amount: float | None, currency: str | None) -> float | None:
        if amount is None or not currency:
            return None
        info = self.rate(currency)
        return None if info is None else round(amount * info.rate, 2)

    def used_rates(self) -> dict[str, RateInfo]:
        return {ccy: info for ccy, info in self._cache.items() if info is not None and ccy != self.currency}
