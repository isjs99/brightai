"""Shared fixtures: a temp project home with config + keys, and a fake Revolut."""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from revfin import config as config_mod
from revfin.auth import TokenStore
from revfin.db import DB
from revfin.util import parse_ts

REPO = Path(__file__).resolve().parent.parent
FIXTURES = REPO / "fixtures"


@pytest.fixture
def home(tmp_path: Path, monkeypatch) -> Path:
    """Copy config.yaml and fixtures into a temp dir with generated keys and a .env."""
    shutil.copy(REPO / "config.yaml", tmp_path / "config.yaml")
    shutil.copytree(FIXTURES, tmp_path / "fixtures")
    secrets = tmp_path / "secrets"
    secrets.mkdir()
    env_lines = ["REVOLUT_ENV=sandbox"]
    for slug in ("uk", "de"):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        pem = key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()
        )
        (secrets / f"{slug}-privatekey.pem").write_bytes(pem)
        pub = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        (secrets / f"{slug}-public.pem").write_bytes(pub)
        env_lines += [
            f"REVOLUT_{slug.upper()}_CLIENT_ID=client-{slug}-123",
            f"REVOLUT_{slug.upper()}_PRIVATE_KEY=secrets/{slug}-privatekey.pem",
            f"REVOLUT_{slug.upper()}_REDIRECT_URI=https://brightform.co/revolut-callback",
        ]
    (tmp_path / ".env").write_text("\n".join(env_lines) + "\n")
    for var in list(__import__("os").environ):
        if var.startswith("REVOLUT_") or var == "REVFIN_HOME":
            monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("REVFIN_HOME", str(tmp_path))
    return tmp_path


@pytest.fixture
def settings(home: Path):
    return config_mod.load(home)


@pytest.fixture
def db(settings) -> DB:
    database = DB(settings.db_path)
    yield database
    database.close()


class FakeRevolut:
    """httpx.MockTransport handler that behaves like the Business API on fixture data."""

    def __init__(self, entity_slug: str = "uk", page_size: int = 1000):
        folder = FIXTURES / entity_slug
        self.accounts = json.loads((folder / "accounts.json").read_text())
        self.counterparties = json.loads((folder / "counterparties.json").read_text())
        self.transactions = sorted(
            json.loads((folder / "transactions.json").read_text()), key=lambda t: t["created_at"], reverse=True
        )
        self.page_size = page_size
        self.token_requests: list[dict] = []
        self.requests: list[httpx.Request] = []
        self.access_tokens_issued = 0
        self.fail_next: list[tuple[int, dict]] = []  # (status, headers) queued failures
        self.refresh_status = 200
        self.valid_tokens: set[str] = set()
        self.expires_in = 2400

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def client(self) -> httpx.Client:
        return httpx.Client(transport=self.transport())

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path.split("/api/1.0", 1)[-1]
        if path == "/auth/token":
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            self.token_requests.append(form)
            if form.get("grant_type") == "refresh_token" and self.refresh_status != 200:
                return httpx.Response(self.refresh_status, json={"error": "invalid_grant", "error_description": "refresh token expired"})
            self.access_tokens_issued += 1
            token = f"access-{self.access_tokens_issued}"
            self.valid_tokens.add(token)
            body = {"access_token": token, "token_type": "bearer", "expires_in": self.expires_in}
            if form.get("grant_type") == "authorization_code":
                body["refresh_token"] = "refresh-secret-abc"
            return httpx.Response(200, json=body)

        if self.fail_next:
            status, headers = self.fail_next.pop(0)
            return httpx.Response(status, headers=headers, json={"message": "induced failure"})

        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer ") or auth[7:] not in self.valid_tokens:
            return httpx.Response(401, json={"message": "unauthorised"})

        if path == "/accounts":
            return httpx.Response(200, json=self.accounts)
        if path == "/counterparties":
            return httpx.Response(200, json=self.counterparties)
        if path == "/rate":
            params = request.url.params
            rates = {("EUR", "GBP"): 0.852, ("USD", "GBP"): 0.781, ("GBP", "EUR"): 1.174}
            rate = rates.get((params["from"], params["to"]))
            if rate is None:
                return httpx.Response(400, json={"message": "unsupported"})
            return httpx.Response(200, json={"from": {"amount": 1, "currency": params["from"]},
                                             "to": {"amount": rate, "currency": params["to"]}, "rate": rate})
        if path == "/transactions":
            params = request.url.params
            since = parse_ts(params["from"])
            until = parse_ts(params["to"])
            count = min(int(params.get("count", 1000)), self.page_size)
            page = [t for t in self.transactions if since <= parse_ts(t["created_at"]) <= until]
            if params.get("account"):
                page = [t for t in page if any(l["account_id"] == params["account"] for l in t["legs"])]
            return httpx.Response(200, json=page[:count])
        if path.startswith("/transaction/"):
            tx_id = path.rsplit("/", 1)[-1]
            for t in self.transactions:
                if t["id"] == tx_id:
                    return httpx.Response(200, json=t)
            return httpx.Response(404, json={"message": "not found"})
        return httpx.Response(404, json={"message": f"no route {path}"})


@pytest.fixture
def fake() -> FakeRevolut:
    return FakeRevolut()


@pytest.fixture
def authed_store(settings, fake: FakeRevolut) -> TokenStore:
    """A token store as if `revfin auth uk` had already run."""
    store = TokenStore(settings.tokens_path)
    fake.valid_tokens.add("access-cached")
    store.update("uk", {"access_token": "access-cached", "expires_in": 2400, "refresh_token": "refresh-secret-abc"})
    return store


def utc(y, m, d, hh=0, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=timezone.utc)
