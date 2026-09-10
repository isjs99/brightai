"""revfin command line. Read-only against Revolut Business."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Optional

import httpx
import typer

from . import __version__
from .auth import AuthError, TokenProvider, TokenStore, consent_url, exchange_code, parse_authorisation_code, token_health
from .categorise import recategorise
from .client import ApiError, RevolutClient
from .config import ConfigError, Settings
from .config import load as load_settings
from .db import DB
from .export import export_rows, render
from .fixtures import load_fixtures
from .pnl import build_pnl
from .sheets import SheetsApi, SheetsError, load_service, push_workbook, resolve_target, service_account_email
from .summary import write_summary
from .sync import sync_entity
from .util import fmt_money, parse_date, utcnow
from .workbook import build_workbook, write_xlsx

app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    help="Read-only Revolut Business finance reader. Pulls accounts, balances and transactions into "
    "SQLite and writes exports for Claude to report on.",
)

EXIT_AUTH = 2
EXIT_ERROR = 1


class State:
    settings: Settings
    # Swapped out by tests to point at a fake Revolut.
    http_factory: Callable[[], httpx.Client] = staticmethod(lambda: httpx.Client(timeout=30))


state = State()


def log(msg: str) -> None:
    typer.echo(msg, err=True)


def fail(msg: str, code: int = EXIT_ERROR) -> None:
    typer.secho(msg, err=True, fg=typer.colors.RED)
    raise typer.Exit(code)


def _version_callback(value: bool) -> None:
    if value:
        typer.echo(f"revfin {__version__}")
        raise typer.Exit()


@app.callback()
def main(
    home: Optional[Path] = typer.Option(None, "--home", help="Directory with config.yaml and .env (default: auto-detect / $REVFIN_HOME)."),
    version: bool = typer.Option(False, "--version", callback=_version_callback, is_eager=True, help="Print version and exit."),
) -> None:
    try:
        state.settings = load_settings(home)
    except ConfigError as exc:
        fail(f"Config error: {exc}")


def _db() -> DB:
    return DB(state.settings.db_path)


def _client(entity, store: TokenStore) -> RevolutClient:
    http = state.http_factory()
    return RevolutClient(state.settings, entity, TokenProvider(state.settings, entity, store, http), http)


@app.command()
def auth(entity: str = typer.Argument(..., help="Entity slug from config.yaml, e.g. uk")) -> None:
    """One-time consent flow: prints the consent URL, then stores the refresh token."""
    s = state.settings
    try:
        ent = s.entity(entity)
        ent.require_credentials()
        url = consent_url(s, ent)
    except (ConfigError, AuthError) as exc:
        fail(str(exc), EXIT_AUTH)
        return
    typer.echo(f"Environment: {s.env}")
    typer.echo("1. Open this URL in the browser where you are logged in to Revolut Business:")
    typer.echo("")
    typer.echo(f"   {url}")
    typer.echo("")
    typer.echo("2. Approve with 2FA. The scope requested is READ only.")
    typer.echo(f"3. You will land on {ent.redirect_uri}?code=... (the page may 404, that is fine).")
    pasted = typer.prompt("4. Paste the full redirected URL here", hide_input=True)
    try:
        code = parse_authorisation_code(pasted)
        store = TokenStore(s.tokens_path)
        exchange_code(s, ent, code, store, state.http_factory())
    except AuthError as exc:
        fail(str(exc), EXIT_AUTH)
        return
    typer.secho(f"Stored refresh token for '{entity}' in {s.tokens_path} (mode 600).", fg=typer.colors.GREEN)
    typer.echo(f"Next: revfin sync --entity {entity}")


@app.command()
def sync(
    entity: Optional[str] = typer.Option(None, "--entity", "-e", help="Only this entity (default: all)."),
    since: Optional[str] = typer.Option(None, "--since", help="YYYY-MM-DD. Default: last sync minus the overlap window."),
) -> None:
    """Pull accounts, balances and transactions into the local database."""
    s = state.settings
    db = _db()
    store = TokenStore(s.tokens_path)
    failures = 0
    try:
        for ent in s.select_entities(entity):
            if not entity and ent.missing_credentials() and not store.get(ent.slug):
                log(f"[{ent.slug}] skipped: not set up yet (no credentials in .env, no token). See README.")
                continue
            try:
                result = sync_entity(s, db, ent, _client(ent, store), since, log)
            except AuthError as exc:
                failures += 1
                typer.secho(f"[{ent.slug}] AUTH FAILED: {exc}", err=True, fg=typer.colors.RED)
                continue
            except ApiError as exc:
                failures += 1
                typer.secho(f"[{ent.slug}] API error: {exc}", err=True, fg=typer.colors.RED)
                continue
            fx = ", ".join(f"{k} {v:.4f}" for k, v in result.fx_rates.items()) or "none"
            typer.echo(
                f"[{ent.slug}] ok: {result.accounts} accounts, {result.transactions} transactions since "
                f"{result.since.date()}, {result.requests} API calls, fx: {fx}"
            )
            for err in result.fx_errors:
                log(f"[{ent.slug}] fx rate skipped: {err}")
    finally:
        db.close()
    if failures:
        raise typer.Exit(EXIT_AUTH)


@app.command()
def balances(entity: Optional[str] = typer.Option(None, "--entity", "-e")) -> None:
    """Current balance per account, from the last sync."""
    s = state.settings
    db = _db()
    try:
        for ent in s.select_entities(entity):
            rows = db.accounts_for(ent.slug)
            typer.echo(f"{ent.name} ({ent.slug})")
            if not rows:
                typer.echo("  no accounts synced yet: run `revfin sync`")
                continue
            width = max(len(s.account_nicknames.get(r["id"], r["name"] or r["id"])) for r in rows)
            for r in rows:
                name = s.account_nicknames.get(r["id"], r["name"] or r["id"])
                synced = (r["last_synced"] or "")[:16].replace("T", " ")
                typer.echo(f"  {name:<{width}}  {fmt_money(r['last_seen_balance'], r['currency']):>20}  {r['state'] or '':<8} synced {synced}")
    finally:
        db.close()


@app.command()
def export(
    from_: str = typer.Option(..., "--from", help="YYYY-MM-DD inclusive"),
    to: str = typer.Option(..., "--to", help="YYYY-MM-DD inclusive"),
    entity: Optional[str] = typer.Option(None, "--entity", "-e"),
    fmt: str = typer.Option("csv", "--format", "-f", help="csv, json or md"),
    out: Optional[Path] = typer.Option(None, "--out", "-o", help="File path (default: data/exports/...)."),
    stdout: bool = typer.Option(False, "--stdout", help="Print instead of writing a file."),
) -> None:
    """Export one row per transaction leg for a date range."""
    s = state.settings
    if fmt not in ("csv", "json", "md"):
        fail("--format must be csv, json or md")
    start = parse_date(from_)
    end = parse_date(to)
    if len(to) == 10:
        end = end.replace(hour=23, minute=59, second=59)
    db = _db()
    try:
        rows = []
        for ent in s.select_entities(entity):
            rows.extend(export_rows(s, db, ent, start, end))
    finally:
        db.close()
    title = f"Transactions {from_} to {to}" + (f" ({entity})" if entity else "")
    content = render(rows, fmt, title)
    if stdout:
        typer.echo(content, nl=False)
        return
    path = out or s.exports_dir / f"transactions-{from_}-to-{to}{'-' + entity if entity else ''}.{fmt}"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    typer.echo(f"wrote {len(rows)} rows to {path}")


@app.command()
def summary(
    month: Optional[str] = typer.Option(None, "--month", "-m", help="YYYY-MM (default: current month)."),
    entity: Optional[str] = typer.Option(None, "--entity", "-e"),
    out: Optional[Path] = typer.Option(None, "--out", "-o", help="File path (default: data/exports/summary-YYYY-MM.md)."),
    as_of: Optional[str] = typer.Option(None, "--as-of", help="YYYY-MM-DD to anchor the cash position (default: now)."),
    print_: bool = typer.Option(False, "--print", "-p", help="Also print the markdown to stdout."),
) -> None:
    """Markdown summary for a month: balances, in/out by category, top counterparties, unusual items."""
    s = state.settings
    month = month or utcnow().strftime("%Y-%m")
    try:
        datetime.strptime(month, "%Y-%m")
    except ValueError:
        fail("--month must look like 2026-08")
    anchor = parse_date(as_of).replace(hour=23, minute=59, second=59) if as_of else None
    db = _db()
    try:
        content = write_summary(s, db, s.select_entities(entity), month, anchor)
    finally:
        db.close()
    path = out or s.exports_dir / f"summary-{month}{'-' + entity if entity else ''}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    if print_:
        typer.echo(content, nl=False)
    typer.echo(f"wrote {path} ({content.count(chr(10))} lines)", err=print_)


@app.command()
def status() -> None:
    """Last sync times and token health per entity."""
    s = state.settings
    db = _db()
    store = TokenStore(s.tokens_path)
    typer.echo(f"env: {s.env}  api: {s.api_base}")
    typer.echo(f"db: {s.db_path}  tokens: {s.tokens_path}")
    try:
        for ent in s.entities.values():
            typer.echo(f"{ent.name} ({ent.slug}), base {ent.base_currency}")
            missing = ent.missing_credentials()
            typer.echo("  credentials: " + ("ok" if not missing else "missing " + ", ".join(missing)))
            health = token_health(store, ent.slug)
            typer.echo(f"  token: {health['state']}, {health['detail']}")
            last = db.last_sync(ent.slug)
            if last:
                when = (last["finished_at"] or last["started_at"])[:16].replace("T", " ")
                detail = f"{last['status']} at {when} UTC"
                if last["status"] == "ok":
                    detail += f", {last['transactions']} transactions since {(last['since'] or '')[:10]}"
                else:
                    detail += f", {last['error']}"
                typer.echo(f"  last sync: {detail}")
            else:
                typer.echo("  last sync: never")
            typer.echo(
                f"  stored: {db.count('accounts', ent.slug)} accounts, {db.count('transactions', ent.slug)} transactions, "
                f"{db.count('balance_snapshots', ent.slug)} balance snapshots"
            )
    finally:
        db.close()


@app.command()
def categorise(entity: Optional[str] = typer.Option(None, "--entity", "-e")) -> None:
    """Re-apply config.yaml category rules to stored transactions (no API calls)."""
    s = state.settings
    db = _db()
    try:
        for ent in s.select_entities(entity):
            counts = recategorise(s, db, ent.slug)
            summary_text = ", ".join(f"{k} {v}" for k, v in sorted(counts.items(), key=lambda kv: -kv[1])) or "no transactions"
            typer.echo(f"[{ent.slug}] {summary_text}")
    finally:
        db.close()


def _month_or_none(value: Optional[str], flag: str) -> Optional[str]:
    if value is None:
        return None
    try:
        datetime.strptime(value, "%Y-%m")
    except ValueError:
        fail(f"{flag} must look like 2026-08")
    return value


@app.command()
def pnl(
    from_: Optional[str] = typer.Option(None, "--from", help="First month YYYY-MM (default: first month with data)."),
    to: Optional[str] = typer.Option(None, "--to", help="Last month YYYY-MM (default: last month with data)."),
    xlsx: Optional[Path] = typer.Option(None, "--xlsx", help="Workbook path (default: data/exports/pnl-<from>-<to>.xlsx)."),
    json_path: Optional[Path] = typer.Option(None, "--json", help="Also write the figures as JSON here."),
    no_xlsx: bool = typer.Option(False, "--no-xlsx", help="Skip the workbook, just print the table."),
) -> None:
    """Cash-basis P&L by month per entity and consolidated, with analytics, as an .xlsx workbook."""
    s = state.settings
    start, end = _month_or_none(from_, "--from"), _month_or_none(to, "--to")
    db = _db()
    try:
        model = build_pnl(s, db, start, end)
    finally:
        db.close()
    _print_pnl_table(model)
    if json_path:
        json_path.parent.mkdir(parents=True, exist_ok=True)
        json_path.write_text(__import__("json").dumps(model.to_json(), indent=2))
        typer.echo(f"wrote {json_path}")
    if not no_xlsx:
        path = xlsx or s.exports_dir / f"pnl-{model.months[0]}-to-{model.months[-1]}.xlsx"
        write_xlsx(build_workbook(model, s.account_nicknames), path)
        typer.echo(f"wrote {path} ({len(model.ledger)} ledger rows, {len(model.months)} months)")


def _print_pnl_table(model) -> None:
    for v in model.all_views():
        typer.echo(f"{v.name} ({v.currency})")
        header = f"  {'':<22}" + "".join(f"{m:>12}" for m in model.months)
        typer.echo(header)
        for label, fn in (("Revenue", v.revenue), ("Gross profit", v.gross_profit),
                          ("Operating result", v.operating_result), ("Net cash result", v.net_result)):
            typer.echo(f"  {label:<22}" + "".join(f"{fn(m):>12,.0f}" for m in model.months))
        typer.echo(f"  {'Cash at month end':<22}" + "".join(
            f"{v.cash_total.get(m):>12,.0f}" if v.cash_total.get(m) is not None else f"{'n/a':>12}" for m in model.months))
    if model.fx_notes:
        typer.echo("FX: " + "; ".join(model.fx_notes))


sheets_app = typer.Typer(help="Google Sheets: push the P&L workbook into a spreadsheet.", no_args_is_help=True)
app.add_typer(sheets_app, name="sheets")


@sheets_app.command("check")
def sheets_check(sheet_id: Optional[str] = typer.Option(None, "--sheet-id")) -> None:
    """Verify credentials and access to the target spreadsheet without writing anything."""
    s = state.settings
    try:
        sid, key = resolve_target(s, sheet_id)
        email = service_account_email(key)
        typer.echo(f"service account: {email or 'unreadable key file'} ({key})")
        api = SheetsApi(load_service(key), sid)
        meta = api.get()
    except (ConfigError, SheetsError) as exc:
        fail(str(exc))
        return
    except Exception as exc:  # googleapiclient.errors.HttpError and friends
        fail(f"Google refused: {str(exc)[:300]}\nIf it says 403, share the sheet with the service account email above as Editor.")
        return
    tabs = ", ".join(sh["properties"]["title"] for sh in meta.get("sheets", []))
    typer.secho(f"ok: '{meta['properties']['title']}' is reachable. Tabs: {tabs}", fg=typer.colors.GREEN)


@sheets_app.command("push")
def sheets_push(
    sheet_id: Optional[str] = typer.Option(None, "--sheet-id", help="Spreadsheet id or URL (default: REVFIN_SHEET_ID)."),
    from_: Optional[str] = typer.Option(None, "--from", help="First month YYYY-MM."),
    to: Optional[str] = typer.Option(None, "--to", help="Last month YYYY-MM."),
) -> None:
    """Build the P&L and write every tab into the Google Sheet (replaces tab contents, keeps the sheet id)."""
    s = state.settings
    start, end = _month_or_none(from_, "--from"), _month_or_none(to, "--to")
    try:
        sid, key = resolve_target(s, sheet_id)
        service = load_service(key)
    except (ConfigError, SheetsError) as exc:
        fail(str(exc))
        return
    db = _db()
    try:
        model = build_pnl(s, db, start, end)
    finally:
        db.close()
    tabs = build_workbook(model, s.account_nicknames)
    typer.echo(f"pushing {len(tabs)} tabs, months {model.months[0]} to {model.months[-1]}")
    try:
        stats = push_workbook(SheetsApi(service, sid), tabs, log)
    except Exception as exc:
        fail(f"Google refused: {str(exc)[:300]}\nRun `revfin sheets check` to diagnose.")
        return
    typer.secho(
        f"done: {stats['tabs']} tabs, {stats['rows']} rows, {stats['charts']} charts in '{stats['title']}'"
        f"  https://docs.google.com/spreadsheets/d/{sid}/edit",
        fg=typer.colors.GREEN,
    )


@app.command("load-fixtures")
def load_fixtures_cmd(
    directory: Path = typer.Option(None, "--dir", help="Fixture folder (default: <home>/fixtures)."),
    entity: Optional[str] = typer.Option(None, "--entity", "-e"),
) -> None:
    """Load hand-made fixture JSON into the database for testing without a live account."""
    s = state.settings
    directory = directory or s.home / "fixtures"
    db = _db()
    try:
        loaded = load_fixtures(s, db, directory, entity)
    finally:
        db.close()
    if not loaded:
        fail(f"no fixture folders found under {directory}")
    for slug, info in loaded.items():
        typer.echo(f"[{slug}] loaded {info['accounts']} accounts, {info['transactions']} transactions from {directory / slug}")


if __name__ == "__main__":
    app()
