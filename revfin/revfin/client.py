"""Thin HTTP wrapper over the Revolut Business API.

Only GET endpoints are exposed. There is deliberately no way to POST a
payment or transfer from here.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator
from datetime import datetime

import httpx

from .auth import AuthError, TokenProvider
from .config import Entity, Settings
from .util import iso, parse_ts

PAGE_SIZE = 1000
MAX_RETRIES = 5


class ApiError(Exception):
    def __init__(self, status_code: int, detail: str, path: str):
        super().__init__(f"Revolut API {status_code} on {path}: {detail}")
        self.status_code = status_code
        self.detail = detail
        self.path = path


class RevolutClient:
    def __init__(
        self,
        settings: Settings,
        entity: Entity,
        tokens: TokenProvider,
        http: httpx.Client | None = None,
        max_retries: int = MAX_RETRIES,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.settings = settings
        self.entity = entity
        self.tokens = tokens
        self.http = http or httpx.Client(timeout=30)
        self.max_retries = max_retries
        self.sleep = sleep
        self.requests_made = 0

    # -- transport ---------------------------------------------------------

    def get(self, path: str, params: dict | None = None):
        attempts = 0
        refreshed = False
        while True:
            token = self.tokens.access_token()
            headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
            try:
                response = self.http.get(self.settings.api_base + path, params=params, headers=headers)
            except httpx.HTTPError as exc:
                attempts += 1
                if attempts > self.max_retries:
                    raise ApiError(0, f"network error after {attempts - 1} retries ({exc.__class__.__name__})", path)
                self.sleep(min(2 ** attempts, 30))
                continue
            self.requests_made += 1

            if response.status_code == 401:
                if not refreshed:
                    refreshed = True
                    self.tokens.access_token(force_refresh=True)
                    continue
                raise AuthError(
                    f"Revolut rejected the access token for '{self.entity.slug}' even after a refresh.",
                    f"run `revfin auth {self.entity.slug}` to re-consent.",
                )
            if response.status_code == 403:
                raise AuthError(
                    f"Revolut returned 403 for '{self.entity.slug}' on {path}.",
                    "the API certificate may be revoked or the app lacks READ scope; check Revolut Business > "
                    f"Settings > APIs, then run `revfin auth {self.entity.slug}`.",
                )
            if response.status_code == 429 or response.status_code >= 500:
                attempts += 1
                if attempts > self.max_retries:
                    raise ApiError(response.status_code, f"gave up after {self.max_retries} retries", path)
                self.sleep(_retry_delay(response, attempts))
                continue
            if response.status_code >= 400:
                raise ApiError(response.status_code, _detail(response), path)
            try:
                return response.json()
            except ValueError as exc:
                raise ApiError(response.status_code, "non-JSON body", path) from exc

    # -- endpoints (READ scope) --------------------------------------------

    def accounts(self) -> list[dict]:
        return self.get("/accounts")

    def bank_details(self, account_id: str) -> list[dict]:
        return self.get(f"/accounts/{account_id}/bank-details")

    def counterparties(self) -> list[dict]:
        return self.get("/counterparties")

    def transaction(self, transaction_id: str) -> dict:
        return self.get(f"/transaction/{transaction_id}")

    def transactions(
        self, since: datetime, until: datetime, count: int = PAGE_SIZE, account: str | None = None
    ) -> list[dict]:
        params: dict = {"from": iso(since), "to": iso(until), "count": count}
        if account:
            params["account"] = account
        return self.get("/transactions", params)

    def rate(self, from_currency: str, to_currency: str, amount: float = 1) -> dict:
        return self.get("/rate", {"from": from_currency, "to": to_currency, "amount": amount})

    def iter_transactions(
        self, since: datetime, until: datetime, account: str | None = None, page_size: int = PAGE_SIZE
    ) -> Iterator[dict]:
        """Walk backwards from `until` by moving `to` to the oldest created_at seen.

        Revolut returns newest first, max 1000 per call. The boundary item is
        returned twice by the API; it is yielded once here and upserts make
        the rest idempotent anyway.
        """
        to = until
        seen: set[str] = set()
        while True:
            page = self.transactions(since, to, page_size, account)
            for tx in page:
                if tx["id"] in seen:
                    continue
                seen.add(tx["id"])
                yield tx
            if len(page) < page_size:
                return
            oldest = parse_ts(page[-1].get("created_at"))
            if oldest is None or oldest >= to:
                return  # no progress possible; avoid looping forever
            to = oldest


def _retry_delay(response: httpx.Response, attempt: int) -> float:
    header = response.headers.get("Retry-After")
    if header:
        try:
            return max(0.0, float(header))
        except ValueError:
            pass
    return float(min(2 ** attempt, 60))


def _detail(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text[:200]
    if isinstance(body, dict):
        return str(body.get("message") or body.get("error") or body)[:200]
    return str(body)[:200]
