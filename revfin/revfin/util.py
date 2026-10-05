"""Small shared helpers: time parsing, money formatting, month maths."""

from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta, timezone


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(dt: datetime) -> str:
    """ISO 8601 with a trailing Z, the form Revolut accepts and returns."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(value: str | None) -> datetime | None:
    """Parse Revolut timestamps ("2026-08-03T09:12:44.123Z") into aware datetimes."""
    if not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def parse_date(value: str) -> datetime:
    """Accept YYYY-MM-DD or a full ISO timestamp; return an aware UTC datetime."""
    if len(value) == 10:
        return datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    dt = parse_ts(value)
    assert dt is not None
    return dt


def month_bounds(month: str) -> tuple[datetime, datetime]:
    """'2026-08' -> (2026-08-01T00:00Z, 2026-09-01T00:00Z)."""
    year, mon = (int(p) for p in month.split("-"))
    start = datetime(year, mon, 1, tzinfo=timezone.utc)
    end = datetime(year + (mon == 12), 1 if mon == 12 else mon + 1, 1, tzinfo=timezone.utc)
    return start, end


def shift_month(month: str, delta: int) -> str:
    year, mon = (int(p) for p in month.split("-"))
    idx = year * 12 + (mon - 1) + delta
    return f"{idx // 12:04d}-{idx % 12 + 1:02d}"


def month_label(month: str) -> str:
    year, mon = (int(p) for p in month.split("-"))
    return f"{calendar.month_name[mon]} {year}"


def fmt_money(amount: float | None, currency: str | None = None) -> str:
    if amount is None:
        return "n/a"
    text = f"{amount:,.2f}"
    return f"{text} {currency}" if currency else text


def fmt_signed(amount: float | None, currency: str | None = None) -> str:
    if amount is None:
        return "n/a"
    sign = "+" if amount > 0 else ""
    return sign + fmt_money(amount, currency)


def days_ago(now: datetime, days: int) -> datetime:
    return now - timedelta(days=days)


def as_date(dt: datetime | None) -> date | None:
    return dt.date() if dt else None
