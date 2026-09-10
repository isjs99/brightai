import json
import re

import pytest

from revfin.categorise import Categoriser, recategorise
from revfin.export import COLUMNS, export_rows, render
from revfin.fixtures import load_fixtures
from revfin.summary import MAX_LINES, write_summary
from tests.conftest import utc


def tx(type_, amount, currency="GBP", account="acc-uk-gbp-main", name=None, merchant=None, reference=None, cp_account=None):
    legs = [{"account_id": account, "amount": amount, "currency": currency, "counterparty_name": name}]
    raw = {"type": type_, "reference": reference, "merchant": {"name": merchant} if merchant else None,
           "legs": [{"account_id": account, "amount": amount, "currency": currency,
                     "counterparty": {"id": "x", "account_id": cp_account} if cp_account else None}]}
    return raw, legs


def test_builtin_and_rule_categories(settings):
    own = {"uk": {"acc-uk-gbp-main", "acc-uk-gbp-savings"}, "de": {"acc-de-eur-main"}}
    c = Categoriser(settings, own)
    assert c.categorise("uk", *tx("fee", -20))[0] == "bank_fee"
    assert c.categorise("uk", *tx("exchange", -100))[0] == "fx"
    raw, legs = tx("transfer", -500)
    raw["legs"].append({"account_id": "acc-uk-gbp-savings", "amount": 500, "currency": "GBP"})
    legs.append({"account_id": "acc-uk-gbp-savings", "amount": 500, "currency": "GBP"})
    assert c.categorise("uk", raw, legs)[0] == "internal"
    assert c.categorise("uk", *tx("transfer", -2000, name="Brightform Social Media UG (haftungsbeschraenkt)"))[0] == "intercompany"
    assert c.categorise("uk", *tx("transfer", -2000, name="Some Name", cp_account="acc-de-eur-main"))[0] == "intercompany"
    assert c.categorise("uk", *tx("transfer", -3200, name="A Smith", reference="Salary Aug")) == ("payroll", "payroll_ref")
    # direction: a salary *refund* coming in must not be tagged payroll
    assert c.categorise("uk", *tx("transfer", 3200, name="A Smith", reference="Salary Aug"))[0] != "payroll"
    assert c.categorise("uk", *tx("card_payment", -59.99, merchant="Adobe Systems"))[0] == "software"
    assert c.categorise("uk", *tx("transfer", 12000, name="Acme", reference="INV-1 retainer"))[0] == "client_receipt"
    assert c.categorise("uk", *tx("card_payment", -65, merchant="Bloom & Wild")) == ("uncategorised", None)


def test_recategorise_after_rule_change(settings, db, home):
    load_fixtures(settings, db, home / "fixtures")
    before = db.conn.execute("SELECT category FROM categories c JOIN transactions t ON t.id=c.transaction_id"
                             " WHERE t.merchant_name='Bloom & Wild'").fetchone()["category"]
    assert before == "uncategorised"
    (home / "config.yaml").write_text(
        (home / "config.yaml").read_text()
        + "  - id: gifts\n    category: owner\n    match: { merchant_name: \"bloom & wild\" }\n"
    )
    from revfin import config as config_mod
    counts = recategorise(config_mod.load(home), db, "uk")
    assert counts["owner"] == 1
    after = db.conn.execute("SELECT category FROM categories c JOIN transactions t ON t.id=c.transaction_id"
                            " WHERE t.merchant_name='Bloom & Wild'").fetchone()["category"]
    assert after == "owner"


@pytest.fixture
def loaded(settings, db, home):
    load_fixtures(settings, db, home / "fixtures")
    return db


def _json_block(text: str) -> dict:
    match = re.search(r"```json\n(.*?)\n```", text, re.S)
    assert match, "summary must end with a JSON block"
    return json.loads(match.group(1))


def test_summary_reads_sensibly_and_stays_short(settings, loaded):
    text = write_summary(settings, loaded, settings.select_entities(None), "2026-08", utc(2026, 9, 10, 23, 59))
    assert text.count("\n") < MAX_LINES
    assert "# Finance summary, August 2026" in text
    assert "| **Total in GBP** | | **49,635.27** |" in text
    assert "- In: 22,992.00 GBP (prev month 19,242.00 GBP)" in text
    assert "1 internal transfers, 1 FX exchanges, intercompany net -1,704.00 GBP" in text
    assert "Single outgoing legs over 5,000.00 GBP:" in text and "Studio Lightbox Ltd: -6,500.00 GBP" in text
    assert "ads: 1,200.00 GBP -> 2,400.00 GBP (+100%)" in text
    assert "2026-08-22 Amazon UK: -320.00 GBP (declined)" in text
    assert "Exchanged to GBP" not in text  # FX legs are not "new counterparties"
    assert "Brightform Social Media UG (haftungsbeschraenkt) (de), reporting in EUR" in text
    assert "intercompany net +2,000.00 EUR" in text
    fig = _json_block(text)
    uk = fig["entities"]["uk"]
    assert uk["flows"]["this"] == {"in": 22992.0, "out": 19989.99, "net": 3002.01}
    assert uk["cash"]["now"] == 49635.27 and uk["cash"]["d7"] == 59009.73
    assert uk["unusual"]["large_outgoing"][0][1] == "Studio Lightbox Ltd"
    assert uk["uncategorised"] == 3 and uk["pending"] == 1
    assert uk["fx"]["EUR"]["rate"] == pytest.approx(0.852)
    assert fig["entities"]["de"]["intercompany_net"] == 2000.0
    # exchange legs never count as income or spend
    assert "fx" not in uk["by_category"] and "internal" not in uk["by_category"]


def test_summary_runway_when_burning(settings, loaded, monkeypatch):
    # Pretend July and August had a big extra cost each so the average is negative.
    for i, month in enumerate(("2026-06", "2026-07", "2026-08")):
        loaded.upsert_transaction("uk", {
            "id": f"tx-burn-{i}", "type": "transfer", "state": "completed", "created_at": f"{month}-15T10:00:00Z",
            "reference": "Big contractor invoice",
            "legs": [{"account_id": "acc-uk-gbp-main", "amount": -30000, "currency": "GBP",
                      "counterparty": {"id": "cp-mia"}}],
        }, {"cp-mia": "Mia Chen"})
        loaded.upsert_category(f"tx-burn-{i}", "contractor", "contractor_ref")
    loaded.commit()
    text = write_summary(settings, loaded, [settings.entity("uk")], "2026-08", utc(2026, 9, 10))
    fig = _json_block(text)["entities"]["uk"]
    assert fig["runway"]["avg_burn"] > 0
    assert fig["runway"]["months"] == pytest.approx(fig["cash"]["now"] / fig["runway"]["avg_burn"], abs=0.1)
    assert "Average burn" in text and "months." in text


def test_uses_config_fx_when_no_synced_rate(settings, loaded):
    loaded.conn.execute("DELETE FROM fx_rates")
    loaded.commit()
    text = write_summary(settings, loaded, [settings.entity("uk")], "2026-08", utc(2026, 9, 10))
    assert "EUR->GBP 0.8500 (config)" in text


def test_export_formats(settings, loaded):
    rows = export_rows(settings, loaded, settings.entity("uk"), utc(2026, 8, 1), utc(2026, 9, 1))
    assert len(rows) == 25  # 21 single-leg transactions + exchange (2 legs) + internal move (2 legs)
    csv_text = render(rows, "csv", "t")
    assert csv_text.splitlines()[0] == ",".join(COLUMNS)
    assert len(csv_text.splitlines()) == 26
    glow = next(r for r in rows if r["counterparty_name"] == "Glow Skincare GmbH")
    assert glow["amount_base"] == pytest.approx(7242.0) and glow["base_currency"] == "GBP"
    assert json.loads(render(rows, "json", "t"))[0]["category"] == "office_rent"
    md = render(rows, "md", "August")
    assert md.startswith("# August") and "| 2026-08-18 | uk | Main GBP | transfer | completed | -6,500.00 GBP |" in md
    with pytest.raises(ValueError):
        render(rows, "xlsx", "t")
