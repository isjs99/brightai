"""OAuth 2 client-assertion flow for the Revolut Business API.

Secrets never leave this module in log output: the private key is read to
sign the JWT, tokens go to tokens.json (mode 600) and nothing else.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

import httpx
import jwt

from .config import ConfigError, Entity, Settings
from .util import parse_ts, utcnow

CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
JWT_AUDIENCE = "https://revolut.com"
JWT_LIFETIME_SECONDS = 60 * 60
# Refresh the access token this many seconds before Revolut says it expires.
ACCESS_TOKEN_SKEW_SECONDS = 120
SCOPE = "READ"


class AuthError(Exception):
    """Loud, non-retryable auth failure with a one-line fix."""

    def __init__(self, message: str, fix: str):
        super().__init__(message)
        self.message = message
        self.fix = fix

    def __str__(self) -> str:
        return f"{self.message} Fix: {self.fix}"


def build_client_assertion(entity: Entity, now: int | None = None) -> str:
    """RS256 JWT: iss = redirect domain, sub = client id, aud = https://revolut.com."""
    entity.require_credentials()
    assert entity.private_key_path is not None
    key = entity.private_key_path.read_bytes()
    issued = int(time.time()) if now is None else now
    claims = {
        "iss": entity.redirect_domain,
        "sub": entity.client_id,
        "aud": JWT_AUDIENCE,
        "iat": issued,
        "exp": issued + JWT_LIFETIME_SECONDS,
    }
    try:
        return jwt.encode(claims, key, algorithm="RS256")
    except (ValueError, TypeError) as exc:
        raise AuthError(
            f"Could not load the private key for '{entity.slug}' from {entity.private_key_path}.",
            f"point {entity.env_prefix}PRIVATE_KEY at the PEM produced by `openssl genrsa` (see README).",
        ) from exc


def consent_url(settings: Settings, entity: Entity) -> str:
    entity.require_credentials()
    query = urlencode(
        {
            "client_id": entity.client_id,
            "redirect_uri": entity.redirect_uri,
            "response_type": "code",
            "scope": SCOPE,
        }
    )
    return f"{settings.consent_base}?{query}"


def parse_authorisation_code(pasted: str) -> str:
    """Accept the full redirected URL or the bare code."""
    text = pasted.strip()
    if not text:
        raise AuthError("No authorisation code given.", "paste the full URL Revolut redirected you to.")
    if "://" in text or "?" in text:
        query = parse_qs(urlparse(text).query)
        codes = query.get("code")
        if not codes or not codes[0]:
            raise AuthError(
                "The pasted URL has no ?code= parameter.",
                "paste the whole address bar contents after approving in Revolut.",
            )
        return codes[0]
    return text


class TokenStore:
    """tokens.json: {slug: {refresh_token, access_token, expires_at, ...}}."""

    def __init__(self, path: Path):
        self.path = path
        self._data: dict[str, dict] = {}
        if path.exists():
            try:
                self._data = json.loads(path.read_text() or "{}")
            except json.JSONDecodeError as exc:
                raise AuthError(
                    f"{path} is not valid JSON.",
                    "delete the file and run `revfin auth <entity>` again.",
                ) from exc

    def get(self, slug: str) -> dict | None:
        return self._data.get(slug)

    def slugs(self) -> list[str]:
        return list(self._data)

    def update(self, slug: str, token_response: dict, now: datetime | None = None) -> dict:
        now = now or utcnow()
        record = dict(self._data.get(slug, {}))
        access = token_response.get("access_token")
        if not access:
            raise AuthError(
                "Revolut's token response had no access_token.",
                "try again; if it persists check the Business API app status in Revolut.",
            )
        expires_in = int(token_response.get("expires_in") or 2400)
        record["access_token"] = access
        record["expires_at"] = (now + timedelta(seconds=expires_in)).isoformat()
        if token_response.get("refresh_token"):
            record["refresh_token"] = token_response["refresh_token"]
            record["refresh_obtained_at"] = now.isoformat()
        record["updated_at"] = now.isoformat()
        self._data[slug] = record
        self.save()
        return record

    def clear(self, slug: str) -> None:
        self._data.pop(slug, None)
        self.save()

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        with open(tmp, "w") as fh:
            json.dump(self._data, fh, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)


def _token_request(
    settings: Settings, entity: Entity, http: httpx.Client, fields: dict[str, str], what: str
) -> dict:
    form = {
        "client_id": entity.client_id,
        "client_assertion_type": CLIENT_ASSERTION_TYPE,
        "client_assertion": build_client_assertion(entity),
        **fields,
    }
    try:
        response = http.post(f"{settings.api_base}/auth/token", data=form, timeout=30)
    except httpx.HTTPError as exc:
        raise AuthError(
            f"Could not reach Revolut to {what} for '{entity.slug}' ({exc.__class__.__name__}).",
            "check your network and try again.",
        ) from exc

    if response.status_code in (400, 401):
        detail = _error_detail(response)
        if fields.get("grant_type") == "refresh_token":
            raise AuthError(
                f"Revolut rejected the refresh token for '{entity.slug}' ({response.status_code}{detail}). "
                "It has expired or been revoked.",
                f"run `revfin auth {entity.slug}` to re-consent.",
            )
        raise AuthError(
            f"Revolut rejected the authorisation code for '{entity.slug}' ({response.status_code}{detail}).",
            "codes are single use and short lived: open the consent URL again and paste the new redirect.",
        )
    if response.status_code == 403:
        raise AuthError(
            f"Revolut refused the client assertion for '{entity.slug}' (403).",
            "check the certificate is still enabled in Revolut Business > Settings > APIs and that "
            f"{entity.env_prefix}CLIENT_ID and the redirect URI domain match it.",
        )
    if response.status_code >= 400:
        raise AuthError(
            f"Revolut returned {response.status_code} while trying to {what} for '{entity.slug}'.",
            "wait a minute and retry; if it keeps failing check https://status.revolut.com.",
        )
    try:
        return response.json()
    except ValueError as exc:
        raise AuthError(
            f"Revolut returned a non-JSON token response for '{entity.slug}'.",
            "retry; if it persists check REVOLUT_ENV points at the right environment.",
        ) from exc


def _error_detail(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return ""
    if isinstance(body, dict):
        text = body.get("error_description") or body.get("message") or body.get("error")
        if text:
            return f": {str(text)[:120]}"
    return ""


def exchange_code(
    settings: Settings, entity: Entity, code: str, store: TokenStore, http: httpx.Client | None = None
) -> dict:
    client = http or httpx.Client()
    payload = _token_request(
        settings, entity, client, {"grant_type": "authorization_code", "code": code}, "exchange the code"
    )
    if not payload.get("refresh_token"):
        raise AuthError(
            "Revolut's response had no refresh_token.",
            "make sure the app was approved with READ scope and try `revfin auth` again.",
        )
    return store.update(entity.slug, payload)


class TokenProvider:
    """Hands out a valid access token, refreshing invisibly when it is near expiry."""

    def __init__(
        self, settings: Settings, entity: Entity, store: TokenStore, http: httpx.Client | None = None
    ):
        self.settings = settings
        self.entity = entity
        self.store = store
        self.http = http or httpx.Client()
        self.refreshes = 0

    def access_token(self, force_refresh: bool = False) -> str:
        record = self.store.get(self.entity.slug)
        if not record or not record.get("refresh_token"):
            raise AuthError(
                f"No Revolut token stored for '{self.entity.slug}'.",
                f"run `revfin auth {self.entity.slug}` to complete the one-time consent flow.",
            )
        if not force_refresh and record.get("access_token"):
            expires_at = parse_ts(record.get("expires_at"))
            if expires_at and (expires_at - utcnow()).total_seconds() > ACCESS_TOKEN_SKEW_SECONDS:
                return record["access_token"]
        try:
            self.entity.require_credentials()
        except ConfigError as exc:
            raise AuthError(str(exc), "fill in .env before syncing.") from exc
        payload = _token_request(
            self.settings,
            self.entity,
            self.http,
            {"grant_type": "refresh_token", "refresh_token": record["refresh_token"]},
            "refresh the access token",
        )
        self.refreshes += 1
        return self.store.update(self.entity.slug, payload)["access_token"]


def token_health(store: TokenStore, slug: str, now: datetime | None = None) -> dict:
    """Non-secret view of a stored token for `revfin status`."""
    now = now or utcnow()
    record = store.get(slug)
    if not record or not record.get("refresh_token"):
        return {"state": "missing", "detail": f"run `revfin auth {slug}`"}
    expires_at = parse_ts(record.get("expires_at"))
    obtained = record.get("refresh_obtained_at", "?")[:10]
    if expires_at and expires_at > now:
        mins = int((expires_at - now).total_seconds() // 60)
        return {"state": "ok", "detail": f"access token valid {mins} min, consent from {obtained}"}
    return {"state": "ok", "detail": f"access token expired, will refresh on next run, consent from {obtained}"}
