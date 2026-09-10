"""Push workbook tabs into a Google Sheet with a service account.

Setup is in the README under "Google Sheets". The service account only needs
to be an editor on the one spreadsheet; it cannot see anything else in Drive.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .config import ConfigError, Settings
from .workbook import INT_FORMAT, NUMBER_FORMAT, PERCENT_FORMAT, Chart, Tab

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
VALUES_CHUNK = 4000


class SheetsError(Exception):
    pass


def load_service(service_account_file: Path):
    """Build an authenticated Sheets API service. Imports lazily so the base CLI stays light."""
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
    except ImportError as exc:
        raise SheetsError("Google libraries missing. Run: pip install -e '.[pnl]'") from exc
    if not service_account_file.exists():
        raise SheetsError(
            f"Service account key not found at {service_account_file}. "
            "Download the JSON key from Google Cloud and set GOOGLE_SERVICE_ACCOUNT_FILE in .env (see README)."
        )
    creds = service_account.Credentials.from_service_account_file(str(service_account_file), scopes=SCOPES)
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


def service_account_email(service_account_file: Path) -> str | None:
    import json

    try:
        return json.loads(service_account_file.read_text()).get("client_email")
    except (OSError, ValueError):
        return None


class SheetsApi:
    """Thin wrapper so tests can fake the four calls we use."""

    def __init__(self, service, spreadsheet_id: str):
        self.service = service
        self.spreadsheet_id = spreadsheet_id

    def get(self) -> dict:
        return self.service.spreadsheets().get(spreadsheetId=self.spreadsheet_id, fields="properties.title,sheets(properties,charts.chartId)").execute()

    def batch_update(self, requests: list[dict]) -> dict:
        if not requests:
            return {}
        return self.service.spreadsheets().batchUpdate(spreadsheetId=self.spreadsheet_id, body={"requests": requests}).execute()

    def values_clear(self, range_: str) -> None:
        self.service.spreadsheets().values().clear(spreadsheetId=self.spreadsheet_id, range=range_, body={}).execute()

    def values_update(self, range_: str, values: list[list]) -> None:
        self.service.spreadsheets().values().update(
            spreadsheetId=self.spreadsheet_id, range=range_, valueInputOption="RAW", body={"values": values}
        ).execute()


def _cell(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, float) and value != value:  # NaN
        return ""
    return value


def _grid(sheet_id: int, r0: int, r1: int, c0: int, c1: int) -> dict:
    """Half-open GridRange."""
    return {"sheetId": sheet_id, "startRowIndex": r0, "endRowIndex": r1, "startColumnIndex": c0, "endColumnIndex": c1}


def _chart_request(sheet_id: int, chart: Chart) -> dict:
    kind = "COLUMN" if chart.kind == "column" else "LINE"
    return {
        "addChart": {
            "chart": {
                "spec": {
                    "title": chart.title,
                    "basicChart": {
                        "chartType": kind,
                        "legendPosition": "BOTTOM_LEGEND",
                        "headerCount": 1,
                        "domains": [{"domain": {"sourceRange": {"sources": [
                            _grid(sheet_id, chart.header_row, chart.header_row + 1, chart.first_col, chart.last_col + 1)]}}}],
                        "series": [
                            {"series": {"sourceRange": {"sources": [_grid(sheet_id, row, row + 1, chart.first_col, chart.last_col + 1)]}},
                             "targetAxis": "LEFT_AXIS"}
                            for row in chart.series_rows
                        ],
                    },
                },
                "position": {"overlayPosition": {
                    "anchorCell": {"sheetId": sheet_id, "rowIndex": chart.anchor_row, "columnIndex": chart.anchor_col},
                    "widthPixels": 720, "heightPixels": 340,
                }},
            }
        }
    }


def _format_requests(sheet_id: int, tab: Tab) -> list[dict]:
    n_rows = max(len(tab.rows), 1)
    n_cols = max((len(r) for r in tab.rows), default=1)
    reqs: list[dict] = [
        {"updateSheetProperties": {
            "properties": {"sheetId": sheet_id, "gridProperties": {"frozenRowCount": tab.freeze_rows, "frozenColumnCount": tab.freeze_cols}},
            "fields": "gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
        }},
        # Reset text formatting and number formats for the whole used area first.
        {"repeatCell": {"range": _grid(sheet_id, 0, n_rows, 0, n_cols),
                        "cell": {"userEnteredFormat": {"textFormat": {"bold": False}, "numberFormat": {"type": "NUMBER", "pattern": NUMBER_FORMAT}}},
                        "fields": "userEnteredFormat.textFormat.bold,userEnteredFormat.numberFormat"}},
    ]
    for row in sorted(tab.percent_rows):
        reqs.append({"repeatCell": {"range": _grid(sheet_id, row, row + 1, 0, n_cols),
                                    "cell": {"userEnteredFormat": {"numberFormat": {"type": "PERCENT", "pattern": PERCENT_FORMAT}}},
                                    "fields": "userEnteredFormat.numberFormat"}})
    for row in sorted(tab.int_rows):
        reqs.append({"repeatCell": {"range": _grid(sheet_id, row, row + 1, 0, n_cols),
                                    "cell": {"userEnteredFormat": {"numberFormat": {"type": "NUMBER", "pattern": INT_FORMAT}}},
                                    "fields": "userEnteredFormat.numberFormat"}})
    for row in sorted(tab.bold_rows):
        reqs.append({"repeatCell": {"range": _grid(sheet_id, row, row + 1, 0, n_cols),
                                    "cell": {"userEnteredFormat": {"textFormat": {"bold": True}}},
                                    "fields": "userEnteredFormat.textFormat.bold"}})
    for col, width in tab.col_widths.items():
        reqs.append({"updateDimensionProperties": {
            "range": {"sheetId": sheet_id, "dimension": "COLUMNS", "startIndex": col, "endIndex": col + 1},
            "properties": {"pixelSize": int(width * 7.5)}, "fields": "pixelSize"}})
    return reqs


def push_workbook(api: SheetsApi, tabs: list[Tab], log=lambda _m: None) -> dict:
    meta = api.get()
    existing = {s["properties"]["title"]: s for s in meta.get("sheets", [])}

    # 1. Create missing tabs, in order.
    add = [{"addSheet": {"properties": {"title": t.name, "index": i}}} for i, t in enumerate(tabs) if t.name not in existing]
    if add:
        api.batch_update(add)
        meta = api.get()
        existing = {s["properties"]["title"]: s for s in meta.get("sheets", [])}

    stats = {"tabs": 0, "rows": 0, "charts": 0}
    for tab in tabs:
        sheet = existing[tab.name]
        sheet_id = sheet["properties"]["sheetId"]
        # 2. Drop old charts and clear values, then write.
        removals = [{"deleteEmbeddedObject": {"objectId": c["chartId"]}} for c in sheet.get("charts", [])]
        api.batch_update(removals)
        api.values_clear(f"'{tab.name}'!A1:ZZ")
        values = [[_cell(v) for v in row] for row in tab.rows]
        for start in range(0, len(values), VALUES_CHUNK):
            chunk = values[start:start + VALUES_CHUNK]
            api.values_update(f"'{tab.name}'!A{start + 1}", chunk)
        # 3. Make sure the grid is big enough, then format and add charts.
        n_rows = len(tab.rows) + 40
        n_cols = max((len(r) for r in tab.rows), default=1) + 12
        reqs = [{"updateSheetProperties": {
            "properties": {"sheetId": sheet_id, "gridProperties": {"rowCount": max(n_rows, 100), "columnCount": max(n_cols, 26)}},
            "fields": "gridProperties.rowCount,gridProperties.columnCount"}}]
        reqs += _format_requests(sheet_id, tab)
        reqs += [_chart_request(sheet_id, c) for c in tab.charts]
        api.batch_update(reqs)
        stats["tabs"] += 1
        stats["rows"] += len(tab.rows)
        stats["charts"] += len(tab.charts)
        log(f"  {tab.name}: {len(tab.rows)} rows, {len(tab.charts)} charts")

    # 4. Remove Google's default empty "Sheet1" if we now have our own tabs.
    wanted = {t.name for t in tabs}
    stray = [s for title, s in existing.items() if title not in wanted and title.startswith("Sheet") and len(existing) > len(wanted)]
    for s in stray:
        api.batch_update([{"deleteSheet": {"sheetId": s["properties"]["sheetId"]}}])
    stats["title"] = meta.get("properties", {}).get("title")
    return stats


def resolve_target(settings: Settings, sheet_id: str | None) -> tuple[str, Path]:
    sid = sheet_id or settings.sheet_id()
    if not sid:
        raise ConfigError(f"No spreadsheet id. Pass --sheet-id or set {settings.sheet_id_env} in .env.")
    if "docs.google.com" in sid:
        sid = sid.split("/d/", 1)[1].split("/", 1)[0]
    key = settings.service_account_file()
    if not key:
        raise ConfigError(f"Set {settings.service_account_env} in .env to the service account JSON key path.")
    return sid, key
