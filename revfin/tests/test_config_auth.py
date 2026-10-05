import json
import os
import stat
from datetime import timedelta

import jwt
import pytest

from revfin import config as config_mod
from revfin.auth import (
    AuthError, TokenProvider, TokenStore, build_client_assertion, consent_url, exchange_code,
    parse_authorisation_code, token_health,
)
from revfin.util import utcnow


def test_load_config_reads_entities_and_env(settings, home):
    assert set(settings.entities) == {"uk", "de"}
    uk = settings.entity("uk")
    assert uk.base_currency == "GBP"
    assert uk.client_id == "client-uk-123"
    assert uk.private_key_path == (home / "secrets/uk-privatekey.pem").resolve()
    assert uk.redirect_domain == "brightform.co"
    assert settings.env == "sandbox"
    assert settings.api_base.startswith("https://sandbox-b2b")
    assert settings.rules and settings.rules[0].category == "payroll"
    assert settings.fx_rates[("EUR", "GBP")] == pytest.approx(0.85)


def test_dotenv_does_not_override_real_environment(home, monkeypatch):
    monkeypatch.setenv("REVOLUT_ENV", "production")
    s = config_mod.load(home)
    assert s.is_production and s.api_base == config_mod.PRODUCTION_API


def test_unknown_entity_is_a_config_error(settings):
    with pytest.raises(config_mod.ConfigError, match="Unknown entity 'fr'"):
        settings.entity("fr")


def test_missing_credentials_are_reported_not_guessed(home, monkeypatch):
    (home / ".env").write_text("REVOLUT_ENV=sandbox\n")
    s = config_mod.load(home)
    missing = s.entity("uk").missing_credentials()
    assert "REVOLUT_UK_CLIENT_ID" in missing and "REVOLUT_UK_PRIVATE_KEY" in missing


def test_client_assertion_claims(settings, home):
    uk = settings.entity("uk")
    token = build_client_assertion(uk, now=1_700_000_000)
    public = (home / "secrets/uk-public.pem").read_bytes()
    claims = jwt.decode(token, public, algorithms=["RS256"], audience="https://revolut.com", options={"verify_exp": False})
    assert claims["iss"] == "brightform.co"
    assert claims["sub"] == "client-uk-123"
    assert claims["aud"] == "https://revolut.com"
    assert claims["exp"] - claims["iat"] == 3600
    assert jwt.get_unverified_header(token)["alg"] == "RS256"


def test_consent_url_requests_read_scope_only(settings):
    url = consent_url(settings, settings.entity("uk"))
    assert url.startswith("https://sandbox-business.revolut.com/app-confirm?")
    assert "scope=READ" in url and "WRITE" not in url and "PAY" not in url
    assert "client_id=client-uk-123" in url


def test_parse_authorisation_code_accepts_url_or_bare_code():
    assert parse_authorisation_code("https://brightform.co/revolut-callback?code=oa_abc123&state=x") == "oa_abc123"
    assert parse_authorisation_code("  oa_abc123 ") == "oa_abc123"
    with pytest.raises(AuthError, match="no \\?code="):
        parse_authorisation_code("https://brightform.co/revolut-callback?error=denied")


def test_exchange_code_stores_refresh_token_with_0600(settings, fake):
    store = TokenStore(settings.tokens_path)
    record = exchange_code(settings, settings.entity("uk"), "oa_code", store, fake.client())
    assert record["refresh_token"] == "refresh-secret-abc"
    mode = stat.S_IMODE(os.stat(settings.tokens_path).st_mode)
    assert mode == 0o600
    on_disk = json.loads(settings.tokens_path.read_text())
    assert on_disk["uk"]["refresh_token"] == "refresh-secret-abc"
    sent = fake.token_requests[0]
    assert sent["grant_type"] == "authorization_code" and sent["code"] == "oa_code"
    assert sent["client_assertion_type"] == "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"


def test_token_provider_uses_cache_then_refreshes(settings, fake, authed_store):
    provider = TokenProvider(settings, settings.entity("uk"), authed_store, fake.client())
    assert provider.access_token() == "access-cached"
    assert fake.token_requests == []
    # Expire it and the next call refreshes invisibly.
    record = authed_store.get("uk")
    record["expires_at"] = (utcnow() - timedelta(minutes=1)).isoformat()
    authed_store.save()
    assert provider.access_token() == "access-1"
    assert fake.token_requests[-1]["grant_type"] == "refresh_token"
    assert provider.refreshes == 1


def test_refresh_failure_is_loud_and_says_how_to_fix(settings, fake, authed_store):
    fake.refresh_status = 400
    provider = TokenProvider(settings, settings.entity("uk"), authed_store, fake.client())
    with pytest.raises(AuthError) as excinfo:
        provider.access_token(force_refresh=True)
    text = str(excinfo.value)
    assert "revfin auth uk" in text
    assert "refresh-secret-abc" not in text


def test_missing_token_tells_user_to_auth(settings, fake):
    provider = TokenProvider(settings, settings.entity("de"), TokenStore(settings.tokens_path), fake.client())
    with pytest.raises(AuthError, match="revfin auth de"):
        provider.access_token()
    assert token_health(TokenStore(settings.tokens_path), "de")["state"] == "missing"
