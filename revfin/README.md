# revfin

Read-only Revolut Business finance reader for Brightform. It pulls accounts,
balances and transactions from one or more Revolut Business accounts into a
local SQLite file and writes clean CSV / JSON / markdown exports that Claude
turns into the monthly finance brief.

The script is the data layer. Claude is the report layer. They stay separate.

What it will never do: move money. It only ever asks Revolut for `READ`
scope, only calls GET endpoints, and there is no code path that could POST a
payment.

## Layout

```
revfin/
  revfin/            the package
    cli.py           typer entrypoint (revfin ...)
    config.py        config.yaml + .env loader, one block per entity
    auth.py          JWT client assertion, code exchange, refresh, tokens.json
    client.py        GET-only HTTP wrapper with 429 / 5xx backoff
    sync.py          accounts, counterparties, transactions, FX -> SQLite
    db.py            schema and upserts
    categorise.py    rule-based tagging
    fx.py            convert to each entity's reporting currency
    export.py        CSV / JSON / markdown transaction exports
    summary.py       the monthly markdown summary Claude reads
    fixtures.py      load hand-made API payloads for offline testing
  config.yaml        entities, nicknames, FX fallbacks, category rules
  .env.example       copy to .env, fill in, never commit
  fixtures/          sample payloads for the uk and de entities
  scripts/           cron / launchd helpers
  tests/             pytest suite against a fake Revolut
  data/              (gitignored) revfin.db and exports/
  tokens.json        (gitignored) refresh + access tokens, mode 600
  secrets/           (gitignored) private keys
```

## Install

Python 3.11 or newer.

```
cd revfin
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
revfin --help
```

Try it offline first:

```
revfin load-fixtures
revfin balances
revfin summary --month 2026-08 --as-of 2026-09-10 --print
```

## One-time setup per entity (about 15 minutes, no coding)

You need this once for the UK company and once for the DE company. Revolut
treats them as separate businesses, so each gets its own certificate and its
own consent, even though the same person administers both.

### 1. Make a key pair on your Mac

Open Terminal, `cd` into this `revfin` folder, then:

```
mkdir -p secrets
openssl genrsa -out secrets/uk-privatekey.pem 2048
openssl req -new -x509 -key secrets/uk-privatekey.pem -out secrets/uk-publiccert.cer -days 1825 \
  -subj "/CN=brightform.co"
```

For the DE entity repeat with `de-` in the file names. The `secrets/` folder
is gitignored. The `.pem` file is the private key: never email it, never
paste it into a chat, never upload it anywhere. Only the `.cer` file goes to
Revolut.

### 2. Upload the certificate in Revolut Business

1. Log in to https://business.revolut.com as an owner or admin of the entity.
2. Go to **Settings** (bottom left) > **APIs** > **Business API**.
3. Click **Add certificate** (on some plans the button says **Add API certificate**).
4. **Certificate title**: `revfin` (anything memorable).
5. **X509 public key**: open `secrets/uk-publiccert.cer` in a text editor, copy
   everything including the `-----BEGIN CERTIFICATE-----` and
   `-----END CERTIFICATE-----` lines, and paste it in.
6. **OAuth redirect URI**: `https://brightform.co/revolut-callback`. It does not
   need to be a real page. It only needs to be an HTTPS address on a domain we
   control; Revolut will send the browser there with a code in the URL and
   the page can 404.
7. Save. Revolut shows a **Client ID**. Copy it.

The **Enable API access** step happens at the consent stage below; do not
generate an access token in the Revolut UI, revfin does that.

### 3. Fill in .env

```
cp .env.example .env
```

Then edit `.env`:

```
REVOLUT_ENV=sandbox                 # switch to production when the sandbox run looks right
REVOLUT_UK_CLIENT_ID=<client id from step 2>
REVOLUT_UK_PRIVATE_KEY=secrets/uk-privatekey.pem
REVOLUT_UK_REDIRECT_URI=https://brightform.co/revolut-callback
```

Sandbox note: the sandbox is a separate site (https://sandbox-business.revolut.com)
with its own login, certificate upload and client ID. Do steps 1 and 2 there
first, then repeat on the real site when you flip `REVOLUT_ENV=production`.

### 4. Consent

```
revfin auth uk
```

It prints a URL. Open it in the browser where you are logged in to Revolut
Business, approve the request (it asks for **read** access only; if you ever
see it asking for write or payment permissions, stop and say so), pass 2FA,
and you will land on the redirect address with `?code=...` at the end. Copy
the whole address bar and paste it back into the terminal (the input is
hidden). revfin exchanges the code and stores the refresh token in
`tokens.json` with permissions `600`.

Then:

```
revfin sync --entity uk
revfin balances
revfin status
```

Repeat with `de` for the German entity.

### If auth breaks later

Refresh tokens can expire or be revoked (some plans force re-consent every
90 days, and deleting the certificate in Revolut kills it instantly). revfin
does not retry silently. It prints one red line like:

```
[uk] AUTH FAILED: Revolut rejected the refresh token for 'uk' (401: ...). It has expired or been revoked. Fix: run `revfin auth uk` to re-consent.
```

Do what it says. Nothing else needs changing.

## Commands

```
revfin auth <entity>                        one-time consent, stores the refresh token
revfin sync [--entity X] [--since 2026-01-01]
revfin balances [--entity X]
revfin export --from 2026-08-01 --to 2026-08-31 [--entity X] [--format csv|json|md] [--stdout]
revfin summary [--month 2026-08] [--entity X] [--as-of 2026-09-10] [--print]
revfin status
revfin categorise [--entity X]              re-apply config.yaml rules, no API calls
revfin load-fixtures [--dir fixtures]       offline data for testing summary
revfin pnl [--from 2026-01] [--to 2026-09] [--xlsx path] [--json path]
revfin sheets check                          confirm the service account can reach the sheet
revfin sheets push [--sheet-id ID_OR_URL]    build the P&L and write every tab into Google Sheets
```

`sync` defaults to "since the last successful sync minus 3 days" so
pending transactions that later complete, change amount or get reverted are
picked up. Everything is upserted on transaction id, so running it twice
never duplicates a row.

`summary` writes `data/exports/summary-YYYY-MM.md`: cash per account now vs
7 and 30 days ago, money in vs out by category with the previous month
alongside, top counterparties, client receipts by client, unusual items,
the uncategorised list, a runway estimate, and a JSON block at the bottom
with the same figures. All entities in one file, each in its own reporting
currency with the FX rates used stated at the top of its section.

## P&L workbook and Google Sheets

`revfin pnl` builds a cash-basis P&L from the whole ledger and writes an
`.xlsx` with these tabs. `revfin sheets push` writes the identical tabs into
a Google Sheet, replacing the contents each time so the sheet URL never
changes.

| Tab | What is in it |
|---|---|
| Overview | latest month vs prior for every view, FX used, tab index |
| P&L Group, P&L UK, P&L DE | monthly lines by section (revenue, cost of sales, opex, tax, owner), gross profit and margin, operating result, net cash result, cumulative net, cash at month end, two charts |
| Analytics | revenue MoM, trailing 3 month, YTD, gross and net margin, opex and payroll as share of revenue, paying clients, largest client share, uncategorised spend, cash, net burn, runway |
| Clients | revenue by client by month with share, first and last receipt |
| Vendors | spend by payee by month with category |
| Cash | month-end balance per account and totals, chart |
| Uncategorised | legs still needing a rule |
| Ledger | every transaction leg with entity-currency and group-currency amounts |
| Mapping | category to P&L line, from config.yaml |

Cash basis means a line is what hit the bank that month. The Group view
converts each entity into `pnl.group_currency` (GBP) at the latest synced
rate. Intercompany transfers, FX exchanges and own-account moves are never
income or spend. The category to line mapping is the `pnl.lines` block in
config.yaml; edit it to restructure the P&L.

### Google Sheets setup (once, about 10 minutes)

The push uses a Google service account, a robot identity that is an editor
on one spreadsheet and nothing else. No browser login on the scheduled run.

1. Go to https://console.cloud.google.com, create a project (call it `revfin`).
2. **APIs & Services > Library**, search "Google Sheets API", click **Enable**.
3. **IAM & Admin > Service Accounts > Create service account**. Name `revfin`. No roles needed. Create.
4. Open the service account, **Keys > Add key > Create new key > JSON**. It downloads a file. Move it to `secrets/google-service-account.json` in this folder.
5. Copy the service account's email (looks like `revfin@revfin-123456.iam.gserviceaccount.com`).
6. Open the target Google Sheet, **Share**, paste that email, set **Editor**, untick "notify", Share.
7. In `.env`:

```
GOOGLE_SERVICE_ACCOUNT_FILE=secrets/google-service-account.json
REVFIN_SHEET_ID=<the long id from the sheet URL, between /d/ and /edit>
```

Then:

```
revfin sheets check
revfin sheets push
```

`check` prints the service account email if you need it again, and says
whether the sheet is reachable. A 403 means step 6 was missed.

## Multi-currency and FX

Each entity reports in its `base_currency` from config.yaml. Foreign-currency
legs are converted with, in order: the rate synced from Revolut's `/rate`
endpoint on the last sync, the fallback in `fx.rates` in config.yaml, or not
at all (the summary then says which currency it could not convert rather
than guessing).

FX exchanges between your own accounts have two legs in different
currencies. They are tagged `fx` and never counted as income or spend.
Transfers between the same entity's own accounts are tagged `internal` and
also excluded. Transfers between the UK and DE entities are tagged
`intercompany` and shown as a net figure, outside in/out.

## Categories

Rules live in `config.yaml` under `categories`. Each rule is a regex (case
insensitive) on `merchant_name`, `counterparty_name` or `reference`, with
optional `type` and `direction: in|out`. First match wins. Built-ins run
first: `fee` -> `bank_fee`, `exchange` -> `fx`, own-account transfer ->
`internal`, other-entity transfer -> `intercompany`.

Anything unmatched is `uncategorised` and listed in the summary. The loop
is: Claude or a human proposes a rule, you add it to config.yaml, run
`revfin categorise`, done. No re-sync needed.

## Scheduled run

`scripts/sync-and-summarise.sh` runs `sync`, then `summary` for the current
month, then `sheets push` if `REVFIN_SHEET_ID` is set in `.env`. It exits
non-zero on an auth failure so the scheduler notices.

- Mac: copy `scripts/com.brightform.revfin.plist` to `~/Library/LaunchAgents/`,
  fix the two paths inside, then `launchctl load ~/Library/LaunchAgents/com.brightform.revfin.plist`.
  It runs at 07:30 every day and logs to `data/revfin.log`.
- VPS: `crontab -e` and add `30 7 * * * /path/to/revfin/scripts/sync-and-summarise.sh >> /path/to/revfin/data/revfin.log 2>&1`.

The report step is separate on purpose: Claude Code or Cowork reads
`data/exports/summary-YYYY-MM.md` plus the CSV export, cross-references
Cruva payouts if wanted, and writes the brief. A `revfin report` command
that calls the Claude API directly is possible later as its own module; it
is not shipped in this version.

## Security checklist

- `.env`, `tokens.json`, `secrets/`, `data/` and every `*.pem` / `*.cer` are gitignored at the repo root. Check with `git status --ignored`.
- The consent URL requests `scope=READ` and nothing else. The client exposes only GET methods.
- `tokens.json` is written with mode 600 via an atomic rename.
- Log output never includes tokens, codes or key material. The test suite greps for them.
- To audit the history: `git log -p | grep -c "BEGIN PRIVATE KEY"` should print 0.

## Tests

```
pytest
```

The suite runs the whole flow (auth, sync with pagination, 429 backoff,
401 refresh, idempotent re-sync, categorisation, summary, exports, CLI)
against an in-process fake Revolut built from the fixtures. No network.
