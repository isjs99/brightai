import json

import pytest

from revfin.mcp_server import INSTRUCTIONS, TOOL_NAMES, Tools, build_server, desktop_config
from revfin.fixtures import load_fixtures


@pytest.fixture
def tools(settings, db, home):
    load_fixtures(settings, db, home / "fixtures")
    db.close()
    return Tools(home)


def test_status_and_balances(tools):
    status = tools.revfin_status()
    assert status["env"] == "sandbox" and {e["slug"] for e in status["entities"]} == {"uk", "de"}
    uk = next(e for e in status["entities"] if e["slug"] == "uk")
    assert uk["stored"]["transactions"] == 52 and uk["token"]["state"] == "missing"
    balances = tools.revfin_balances("uk")
    assert len(balances) == 4 and any(b["balance"] == 38420.55 for b in balances)


def test_summary_and_pnl(tools):
    text = tools.revfin_summary("2026-08", as_of="2026-09-10")
    assert "# Finance summary, August 2026" in text and "```json" in text
    pnl = tools.revfin_pnl("2026-07", "2026-08", entity="uk")
    assert pnl["months"] == ["2026-07", "2026-08"]
    assert pnl["derived"]["2026-08"]["net_result"] == 3002.01
    group = tools.revfin_pnl(entity="group")
    assert group["group"]["currency"] == "GBP"
    with pytest.raises(ValueError, match="month must look like"):
        tools.revfin_summary("August")


def test_transactions_filters(tools):
    res = tools.revfin_transactions("2026-08-01", "2026-08-31", entity="uk", search="acme")
    assert res["total_matching"] == 2 and all("Acme" in r["counterparty_name"] for r in res["rows"])
    big = tools.revfin_transactions("2026-08-01", "2026-08-31", min_abs_amount=5000)
    assert {r["counterparty_name"] or r["merchant_name"] for r in big["rows"]} >= {"Studio Lightbox Ltd", "Acme Beauty Ltd"}
    capped = tools.revfin_transactions("2026-01-01", "2026-12-31", limit=3)
    assert capped["returned"] == 3 and capped["total_matching"] > 3


def test_uncategorised_then_add_rule(tools, home):
    unc = tools.revfin_uncategorised()
    names = [g["name"] for g in unc["groups"]]
    assert names[0] == "Studio Lightbox Ltd" and "Bloom & Wild" in names
    result = tools.revfin_add_category_rule("lightbox", "office_rent", counterparty_name="studio lightbox", direction="out")
    assert result["added"]["match"] == {"counterparty_name": "studio lightbox", "direction": "out"}
    assert result["category_counts"]["uk"]["office_rent"] == 5  # 4 months of WeWork + Lightbox
    assert "id: lightbox" in (home / "config.yaml").read_text()
    after = tools.revfin_uncategorised()
    assert "Studio Lightbox Ltd" not in [g["name"] for g in after["groups"]]
    with pytest.raises(ValueError, match="already exists"):
        tools.revfin_add_category_rule("lightbox", "office_rent", counterparty_name="x")
    with pytest.raises(ValueError, match="at least one"):
        tools.revfin_add_category_rule("empty", "software")
    # config.yaml stays loadable after every change
    assert tools.revfin_categorise("uk")["uk"]["office_rent"] == 5


def test_sync_without_token_reports_action(tools):
    res = tools.revfin_sync("uk")
    assert res["uk"]["ok"] is False and "revfin auth uk" in res["uk"]["action"]


def test_workbook_and_sheets_without_setup(tools, tmp_path):
    out = tools.revfin_export_workbook(path=str(tmp_path / "p.xlsx"))
    assert (tmp_path / "p.xlsx").exists() and out["ledger_rows"] == 71
    res = tools.revfin_push_to_google_sheets()
    assert res["ok"] is False and "REVFIN_SHEET_ID" in res["error"]


@pytest.mark.asyncio
async def test_server_registers_every_tool_and_calls_one(home):
    server = build_server(home)
    listed = {t.name for t in await server.list_tools()}
    assert listed == set(TOOL_NAMES)
    assert server.instructions == INSTRUCTIONS
    result = await server.call_tool("revfin_status", {})
    payload = result[0] if isinstance(result, tuple) else result
    text = json.dumps(payload, default=str)
    assert "sandbox" in text


def test_desktop_config_points_at_home(settings):
    cfg = desktop_config(settings)
    entry = cfg["mcpServers"]["revfin"]
    assert entry["args"] == ["mcp"] and entry["env"]["REVFIN_HOME"] == str(settings.home)
