"""End-to-end through the typer app against the fake Revolut, checking secrets stay out of output."""

import json
import os
import stat

from typer.testing import CliRunner

from revfin import cli

runner = CliRunner()


def run(*args, **kw):
    return runner.invoke(cli.app, list(args), catch_exceptions=False, **kw)


def test_auth_then_sync_then_summary_leaks_no_secrets(home, fake, monkeypatch):
    monkeypatch.setattr(cli.state, "http_factory", fake.client)
    private_key = (home / "secrets/uk-privatekey.pem").read_text()

    result = run("auth", "uk", input="https://brightform.co/revolut-callback?code=oa_xyz\n")
    assert result.exit_code == 0, result.output
    assert "scope=READ" in result.output and "Stored refresh token" in result.output
    assert "oa_xyz" not in result.output and "refresh-secret-abc" not in result.output
    tokens_path = home / "tokens.json"
    assert stat.S_IMODE(os.stat(tokens_path).st_mode) == 0o600
    assert json.loads(tokens_path.read_text())["uk"]["refresh_token"] == "refresh-secret-abc"

    result = run("sync", "--entity", "uk")
    assert result.exit_code == 0, result.output
    assert "[uk] ok: 4 accounts, 52 transactions" in result.output
    assert "BEGIN" not in result.output and "refresh-secret-abc" not in result.output and "access-" not in result.output

    # Second sync only re-pulls the overlap window and must not change the stored row count.
    result = run("sync", "--entity", "uk")
    assert result.exit_code == 0 and "since 2026-09-07" in result.output

    result = run("status")
    assert result.exit_code == 0
    assert "credentials: ok" in result.output and "token: ok" in result.output
    assert "stored: 4 accounts, 52 transactions" in result.output and "refresh-secret-abc" not in result.output

    result = run("balances", "--entity", "uk")
    assert "38,420.55 GBP" in result.output

    result = run("summary", "--month", "2026-08", "--entity", "uk", "--as-of", "2026-09-10")
    assert result.exit_code == 0, result.output
    written = home / "data/exports/summary-2026-08-uk.md"
    assert written.exists() and "Studio Lightbox Ltd" in written.read_text()

    result = run("export", "--from", "2026-08-01", "--to", "2026-08-31", "--entity", "uk", "--format", "json")
    assert result.exit_code == 0 and "wrote 25 rows" in result.output

    # Nothing under the project dir should contain the private key except the key file itself.
    for path in home.rglob("*"):
        if path.is_file() and "secrets" not in path.parts and path.suffix not in (".db", ".db-wal", ".db-shm"):
            assert private_key not in path.read_text(errors="ignore"), path


def test_sync_without_token_fails_loud_with_fix(home, fake, monkeypatch):
    monkeypatch.setattr(cli.state, "http_factory", fake.client)
    result = run("sync", "--entity", "de")
    assert result.exit_code == 2
    assert "AUTH FAILED" in result.output and "revfin auth de" in result.output


def test_load_fixtures_and_categorise(home):
    assert run("load-fixtures").exit_code == 0
    result = run("categorise")
    assert result.exit_code == 0 and "[uk]" in result.output and "[de]" in result.output
    result = run("summary", "--month", "2026-08", "--as-of", "2026-09-10", "--print")
    assert result.exit_code == 0 and "## Data" in result.output


def test_sync_skips_entities_never_set_up_but_fails_configured_ones(home, fake, monkeypatch):
    monkeypatch.setattr(cli.state, "http_factory", fake.client)
    env = home / ".env"
    env.write_text("\n".join(l for l in env.read_text().splitlines() if not l.startswith("REVOLUT_DE_")) + "\n")
    result = run("sync")
    assert result.exit_code == 2
    assert "[de] skipped: not set up yet" in result.output
    assert "[uk] AUTH FAILED" in result.output and "revfin auth uk" in result.output
