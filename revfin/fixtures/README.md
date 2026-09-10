# Fixtures

Hand-shaped Revolut Business API payloads for testing without a live account.
One folder per entity slug, matching `config.yaml`:

- `accounts.json`: `GET /accounts` response
- `counterparties.json`: `GET /counterparties` response
- `transactions.json`: `GET /transactions` response (newest first, as Revolut returns it)
- `balance_snapshots.json`: revfin's own snapshot rows, so 7 and 30 day comparisons work
- `fx_rates.json`: rates as if pulled from `GET /rate`

Load them with `revfin load-fixtures`, then `revfin summary --month 2026-08 --as-of 2026-09-10 --print`.

The UK set covers June to September 2026 and deliberately includes: an FX
exchange (two legs), an internal move to savings, an intercompany transfer to
the DE entity, a first-time counterparty over the large-outgoing threshold, a
declined card payment, a reverted transfer, a pending card payment, and two
uncategorised items. Ads double from July to August to trigger the
month-on-month swing check.
