import pytest

from revfin.auth import AuthError, TokenProvider
from revfin.client import ApiError, RevolutClient
from revfin.sync import resolve_since, sync_entity
from revfin.util import parse_date, utcnow
from tests.conftest import FakeRevolut, utc


def make_client(settings, fake, store, **kw):
    http = fake.client()
    return RevolutClient(settings, settings.entity("uk"), TokenProvider(settings, settings.entity("uk"), store, http), http,
                         sleep=lambda _s: None, **kw)


def test_pagination_walks_all_pages_without_duplicates(settings, authed_store):
    fake = FakeRevolut(page_size=7)
    fake.valid_tokens.add("access-cached")
    client = make_client(settings, fake, authed_store)
    txs = list(client.iter_transactions(utc(2026, 1, 1), utc(2026, 12, 31), page_size=7))
    ids = [t["id"] for t in txs]
    assert len(ids) == len(set(ids)) == len(fake.transactions)
    tx_calls = [r for r in fake.requests if r.url.path.endswith("/transactions")]
    assert len(tx_calls) >= 8  # 52 transactions / 7 per page, boundary item repeated


def test_429_backs_off_with_retry_after_then_succeeds(settings, fake, authed_store):
    sleeps = []
    http = fake.client()
    client = RevolutClient(settings, settings.entity("uk"),
                           TokenProvider(settings, settings.entity("uk"), authed_store, http), http, sleep=sleeps.append)
    fake.fail_next = [(429, {"Retry-After": "3"}), (503, {})]
    assert len(client.accounts()) == 4
    assert sleeps[0] == 3.0 and len(sleeps) == 2


def test_gives_up_after_five_retries(settings, fake, authed_store):
    client = make_client(settings, fake, authed_store)
    fake.fail_next = [(429, {})] * 6
    with pytest.raises(ApiError, match="gave up after 5 retries"):
        client.accounts()


def test_401_triggers_one_refresh_then_fails_loud(settings, fake, authed_store):
    fake.valid_tokens.clear()  # cached token no longer accepted
    client = make_client(settings, fake, authed_store)
    assert len(client.accounts()) == 4
    assert client.tokens.refreshes == 1
    fake.valid_tokens.clear()
    fake.refresh_status = 401
    with pytest.raises(AuthError, match="revfin auth uk"):
        client.accounts()


def test_sync_twice_is_idempotent_and_updates_state(settings, db, fake, authed_store):
    uk = settings.entity("uk")
    first = sync_entity(settings, db, uk, make_client(settings, fake, authed_store), since="2026-01-01")
    assert first.accounts == 4 and first.transactions == len(fake.transactions)
    assert first.fx_rates == {"EUR->GBP": pytest.approx(0.852), "USD->GBP": pytest.approx(0.781)}
    counts = (db.count("transactions"), db.count("legs"), db.count("categories"), db.count("accounts"))

    # Flip the pending Figma payment to completed, as Revolut would on the next pull.
    pending = next(t for t in fake.transactions if t["state"] == "pending")
    pending["state"] = "completed"
    pending["completed_at"] = "2026-09-01T00:00:00Z"

    second = sync_entity(settings, db, uk, make_client(settings, fake, authed_store), since="2026-01-01")
    assert second.transactions == first.transactions
    assert (db.count("transactions"), db.count("legs"), db.count("categories"), db.count("accounts")) == counts
    row = db.conn.execute("SELECT state FROM transactions WHERE id=?", (pending["id"],)).fetchone()
    assert row["state"] == "completed"
    # One snapshot per account per sync; two syncs in the same second collapse to one.
    assert db.count("balance_snapshots") in (4, 8)
    assert db.last_successful_sync("uk")["status"] == "ok"


def test_since_defaults_to_last_sync_minus_overlap(settings, db, fake, authed_store):
    uk = settings.entity("uk")
    assert resolve_since(settings, db, uk, None) == parse_date(settings.default_since)
    result = sync_entity(settings, db, uk, make_client(settings, fake, authed_store), since="2026-06-01")
    nxt = resolve_since(settings, db, uk, None)
    assert (result.until - nxt).days == settings.sync_overlap_days
    assert resolve_since(settings, db, uk, "2026-02-03") == utc(2026, 2, 3)


def test_failed_sync_is_logged_and_reraised(settings, db, fake, authed_store):
    fake.refresh_status = 400
    fake.valid_tokens.clear()
    with pytest.raises(AuthError):
        sync_entity(settings, db, settings.entity("uk"), make_client(settings, fake, authed_store))
    last = db.last_sync("uk")
    assert last["status"] == "error" and "AuthError" in last["error"]
    assert "refresh-secret-abc" not in last["error"]
