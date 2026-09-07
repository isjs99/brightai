# Brightform Ops Console (clickable mockup)

Single-file web mockup of the Brightform Ops product (spec v3.0), built from real Cruva data.

- `src/app.html` is the template, `data/cruva-*.json` the Cruva pull (58 shops, 8 Aug to 6 Sep 2026),
  `build.mjs` merges them into `index.html`. Run `node build.mjs` after editing either.
- Three pages: Accounts (with bulk rules from the selection bar), Alerts, Analytics. Each account has
  Today and Setup (Commercials, Targets, Rules, Autonomy, Voice and knowledge, Routing).
- Settings are live state: ad caps, ROAS floors, product ranges, sample quotas per country, follower
  minimums, value ceilings and pricing rules change what the run does on Today and in bulk previews.
- Real from Cruva: brands, markets, GMV and changes, videos, views, sample funnel and queue, products,
  prices, stock, shop score, pending sample requests. Sample data: messages, returns, orders, run times.
