# Brightform AM Ops (Asana sweep + checklists)

A small service that tidies up completed recurring tasks in Asana every morning, with a dashboard where the rules live. First use: the GreatVita AM Daily Checklist pilot.

## Why it exists

When someone completes a recurring task, Asana creates a fresh copy and leaves the completed one behind forever. Asana Rules cannot delete tasks, so the board fills up. This service deletes the spent copies and leaves one-off tasks alone.

**The rule, in one line:** a completed task is deleted only if an incomplete task with exactly the same name exists in the same project (and, by default, the same section). Nothing else is ever touched.

Safeguards, all per rule and all switched on by default:

- **Minimum age** (12h): only delete tasks completed more than this long ago. Stops a fat-finger completion being swept up.
- **Same section required**: the incomplete twin must be in the same section.
- **Dry run**: log what would be deleted, delete nothing. Every new rule starts in dry run and the dashboard shows it loudly.
- **Max deletes per run** (50): if a run would delete more than this, it stops and deletes nothing.

## Run it locally

You need Node 20 or newer, and an Asana Personal Access Token (Asana > My settings > Apps > Developer apps > Personal access tokens).

```bash
cd asana-sweep
cp .env.example .env        # fill in ASANA_PAT and DASHBOARD_PASSWORD
npm install
npm run build
npm start                   # dashboard on http://localhost:3000
```

For development with hot reload:

```bash
npm run dev                 # dashboard on http://localhost:5173, API on :3000
npm test                    # unit + integration tests
```

## Run it with Docker

```bash
cd asana-sweep
cp .env.example .env        # fill in ASANA_PAT and DASHBOARD_PASSWORD
docker compose up -d --build
```

Dashboard is on http://localhost:3000. The SQLite database lives on the `sweep-data` volume, so rules and history survive restarts and rebuilds.

Set `PUBLIC_URL` in `.env` to wherever the dashboard is reachable so the "View run" link in Slack messages works.

## Hosting it for the team

The app is one Node process plus a SQLite file, so any host that runs a Docker container with a persistent volume works. The easiest is Railway (about $5 a month):

1. Push this repo to GitHub (it already is). In Railway: New project › Deploy from GitHub repo › pick `brightai`.
2. In the service settings set **Root Directory** to `asana-sweep`. Railway picks up the Dockerfile and `railway.json`.
3. Add a **Volume** and mount it at `/data`.
4. Under **Variables** add `ASANA_PAT`, `DASHBOARD_PASSWORD`, `PUBLIC_URL` (the Railway URL, e.g. `https://am-ops.up.railway.app`), and optionally `SLACK_BOT_TOKEN`, `CRUVA_API_KEY`. `PORT` and `DATABASE_PATH` are already set by the Dockerfile.
5. Deploy. Open the URL, sign in with the password, and the live watcher starts on its own.

Fly.io works the same way with the included `fly.toml` (see the comments at the top of that file). A plain VPS works with `docker compose up -d` behind nginx or Caddy for https.

Use a long password. Set `PUBLIC_URL` to the https address so the login cookie is marked secure. Failed logins are rate limited (10 tries, then 15 minutes). If you later want per-person logins, the auth layer in `src/web/auth.ts` is designed to be swapped.

## Using the dashboard

Sign in with the dashboard password. Every account that is linked to an Asana checklist board has its own sweep rule, scheduled weekdays 06:30 Madrid time and live. Linking a new board on the Accounts page creates its rule automatically.

**Sweep rules list.** One row per board: schedule in plain English, on/off toggle, dry run or live, last run result, next run time. Buttons: Run now, Edit, Duplicate, Delete. **Sweep all boards now** at the top runs every enabled rule in one go.

**Run now deletes straight away.** It ignores the rule's dry run flag and the minimum age, so a task completed five minutes ago is removed if it has an incomplete twin. Scheduled 06:30 runs keep both safeguards. You get a confirmation prompt either way.

**Rule editor.** Pick the Asana project by typing its name (no GIDs to paste), choose a schedule preset or type a cron expression, adjust the safeguards, optionally add a Slack webhook. The **Preview what would be deleted** button runs the matching logic live against Asana with the settings on screen and shows every completed task with the action it would take and why. It saves nothing and deletes nothing.

**Run history.** Every run, with counts and any warnings. Click a run to see every task it looked at: deleted, would delete, or skipped (no twin, too recent, section mismatch), with the reason. This is the audit trail for "what did you delete yesterday and why". Runs are kept for 90 days.

### Dry run

Rules are live by default. If you want to watch a board before it is swept on schedule, tick **Dry run** on the rules list: scheduled runs then only log what they would delete. **Preview what would be deleted** in the editor does the same on demand without saving anything. Switch a rule off to pause its schedule entirely. Both take effect immediately.

### Adding another project

Rules list > **New rule** > type the project name > pick a schedule > Create. It starts in dry run. That is it, no code change. Or use **Duplicate** on an existing rule and just change the project.

## Live watching

The service watches every linked board. Every 60 seconds (Checklists › Settings) it asks Asana whether anything on the board changed since the last look, which is one small request per board. When a board changed it:

1. runs that board's sweep rule straight away, so a completed recurring task's spent copy is deleted within a minute of being ticked (the minimum age is ignored here; dry run is still respected), and
2. re-evaluates the checklist and pushes the new status to every open dashboard tab, no reload needed.

Deleted copies are remembered, so a task that was completed and then swept still counts as done for the day.

"Refresh from Asana" forces a full re-read of every board.

## Checklist completion check (16:00 every workday)

On top of the live view, the dashboard locks a snapshot of every account once a day (weekdays 16:00 Madrid time by default, change it under Checklists > Settings). That snapshot is the official record used by the Calendar, Analytics and Grades. Live updates after the lock still show on the Checklists page, with the locked status noted underneath.

- **AM** = tasks assigned to the account manager named on the account.
- **AA** = everything else: tasks assigned to anyone who is not the AM, and subtasks (the AA's action items).
- An account is **complete** when both AM and AA are complete. AM and AA are also shown separately.
- A checklist item counts as done if a copy of it was completed today. Weekly items only count on the day they are due.

Screens:

- **Checklists**: today's status per account with AM / AA / combined, expandable to every item and subtask. "Check all now" runs it immediately. The date picker shows past days.
- **Analytics**: completion rate per AM and a per-account, per-day grid for the last 7 to 90 days.
- **Accounts**: the roster (name, markets, AM, AA, linked Asana project). Link a project by searching its name. "Add (dry run)" creates a sweep rule for that project in one click.

If a Slack webhook is set under Checklists > Settings, a digest is posted after each scheduled check.

### Slack DM reminders to AMs

Team page › Slack DM reminders. Needs a Slack bot token in `.env` (`SLACK_BOT_TOKEN`, scopes `chat:write`, `users:read`, `users:read.email`). Each AM on the Team page gets an email or Slack member id. When switched on:

- at the reminder time (default weekdays 14:00) every AM with an incomplete checklist gets a DM listing the accounts and what is missing;
- at the final 16:00 check they get a second DM if it is still not done.

"Preview today's reminders" shows the exact messages without sending. "Send reminders now" sends them immediately. "Test DM" on a person checks the Slack wiring.

### Calendar

One row per AM with their accounts underneath, one column per working day of the month. Each cell shows whether the checklist was complete at the check time. The right-hand side counts complete days, **missed instances** (account-days not complete) and compliance against the 100% target.

### GMV (Cruva)

GMV page. Every account is mapped to its Cruva shops (Accounts › shops, or the seed mapping). Figures come in two ways:

- **Daily sync** at 07:15 from the Cruva REST API when `CRUVA_API_KEY` is set. The endpoint path defaults to `/v1/shop/stats` on `https://api.cruva.com`; override with `CRUVA_STATS_PATH` if Cruva's docs say otherwise. "Sync from Cruva" pulls the last 40 days on demand.
- **Import**: paste JSON rows of `{ shop_id, date, total_gmv, affiliate_gmv, units }`.

Shops report in their market currency (UK → GBP, PL → PLN, everything else EUR) and totals are converted to EUR with editable FX rates ("Rates & rule"). While the month is running, "to date" excludes today because today's figures are still moving. On the 1st of each month the whole previous month is re-pulled so last month's base is final.

**Bonus rule.** Each account's target is derived from last month's GMV: under €30k it must double (+100%), at or above €30k it needs +40%. The page shows last month, the growth needed, the target, GMV to date, growth (projected while the month runs), and a Bonus column: on track / behind while running, eligible / behind once the month closes. Threshold and percentages are editable under "Rates & rule". "Override targets" replaces the rule for an account for that month.

**Commission & AM share.** Each account records the deal: commission % and whether it applies to actual GMV or to the net settlement amount (Merchant of Record). For MoR deals an estimated settlement % is used until the month's actual net settlement is entered. Agency billing = base × commission %, and each AM's share (default 10%) of that is shown per account and per AM. Edit deals on the GMV page or on the account form.

### Grades

Analytics page, top section. Each account and AM gets a score out of 100 and a letter:

- score = checklist weight × compliance + (100 − weight) × GMV attainment, with attainment capped at 100. Default weight 50/50, adjustable on the page.
- A 90+, B 80+, C 70+, D 60+, F below.
- During the running month GMV attainment uses the projected month-end figure so mid-month grades are fair. If an account has no target, it is graded on checklist alone.

### Recurrence warnings

The Asana API cannot set or read a task's repeat setting, so the check infers it. Two flags show up per item:

- **no new copy: repeat not set?** The task was completed today but Asana did not spawn a fresh copy. Open the task in Asana and set it to repeat every workday.
- **no due date**. A task without a due date cannot repeat. Give it one.

## Roles

Two passwords, two roles. `DASHBOARD_PASSWORD` signs in as **admin** (everything editable). `AM_PASSWORD` signs in as **account manager**: every page is visible, nothing can be changed (the API refuses non-GET requests with 403 and the editing controls are hidden). Leave `AM_PASSWORD` blank to disable the read-only login.

## Promotions (TikTok Shop)

Account management > Promotions plans one promotion across many shops: pick accounts and either every market they are active in or only some countries, choose products per shop, and push. It uses the TikTok Shop OpenAPI Promotion API (202309) through a Partner Center app:

1. Create an app in Partner Center, set its redirect URL to `<PUBLIC_URL>/api/tts/callback`, put the app key and secret in `.env` (`TTS_APP_KEY`, `TTS_APP_SECRET`) and restart.
2. Under Promotions > Connection, paste the service id and open the authorisation link for each seller. Authorised shops appear and can be linked to a roster account and market.
3. Create the promotion, review the targets and push. Sync reads the live status back; Deactivate ends it on TikTok.

## GMV Max

GMV Max campaigns live in the TikTok Marketing API (Business Center), which is a separate app from the Shop OpenAPI, so this page is a planner: one row per account, market and campaign type with daily budget, bid strategy, target ROI and status, editable in bulk, with CSV export to mirror into Ads Manager.

## Leads

Growth > Leads mirrors the "Core Lead List" tab of the lead sheet every few minutes (the sheet id and tab are in the page settings). The server reads the sheet's public CSV export, so the sheet must be shared as "Anyone with the link can view"; alternatively set `LEADS_CSV_URL` to any CSV URL, or paste the CSV export into the page. Rows are matched by client name; rows that disappear from the sheet are marked removed; a stage containing "signed" marks the deal signed and stamps the date once.

Per lead you log the **onboarding AM** and **sourced by** (an AM, or not AM-sourced). Both survive syncs. If the sheet grows "Sourced By" / "Onboarding AM" columns they fill in automatically when the name matches a team member. A signed deal gives points to the onboarding AM and to the sourcing AM; the weights are in settings and the By AM table shows totals, signed value and open pipeline per person.

Each lead carries an **added on** date: the sheet's "Date Added" column when there is one (ISO or day-first dates), otherwise the day the row first appeared on the sheet. Admins can correct it with the date picker in the Added column, and the list filters by added in the last 7 / 30 / 90 days or a custom range.

## BD pipeline

Growth > BD pipeline holds fast-rising TikTok Shops per EU market, the decision makers behind them and where we have reached out.

- **Prospects** come from FastMoss: the seed is the top 7-day GMV shops for DE, UK, FR, IT and ES, scored by the share of lifetime GMV made this week ("surging" at 15%+, "rising" at 5%+). Every row links to the shop's FastMoss page. Re-imports refresh the numbers and never touch status, owner, contacts or outreach history. Shops that are already on the roster are marked won with an "Existing client" note and hidden by default.
- **Daily pulls**: a scheduled Claude routine pulls the fast risers from FastMoss each morning and either POSTs them to `/api/bd/import` (`Authorization: Bearer <INGEST_TOKEN>`, set `BD_IMPORT_URL` for the routine) or commits `data/bd-pulls/YYYY-MM-DD.json`; the server imports new files at startup and at 06:00 (or on Import pull). Raw `shop_search` / `shop_base_info` rows work as-is; pasting a result into Import pull does the same by hand.
- **Launch signals**: "Launched in last 30 days" uses the shop creation date (from FastMoss `shop_base_info`, or set by hand in the detail). "GMV started in last 30 days" uses the first-sales date when known, otherwise the implied selling age (lifetime GMV ÷ daily run-rate ≤ 30 days shows as "Took off (est.)"). Both are filters, KPIs and a "Newest shops" sort.
- **Decision makers**: with `APOLLO_API_KEY` set, "Find decision makers" searches Apollo for founders, e-commerce and marketing leads and reveals the top three straight away for their work email and LinkedIn (one Apollo credit each, no confirmation); "Reveal" does the rest one by one. Contacts can also be added by hand.
- **Cold emails in Isaac's voice**: next to any decision maker with an email address, "Draft email" (short note) or "Draft intro" (full introduction) writes a tailored email and takes you to Growth > Outreach emails to review it. The writer uses Isaac's real sent outreach as voice samples (six seeded; more can be pulled from Gmail), the editable pitch block as the only source of Brightform claims, and the shop's FastMoss numbers, launch signals and outreach history for the opener. Filter the prospect list by "With email contact" to find the ones ready to write to. With `ANTHROPIC_API_KEY` set the draft is written by Claude (any of EN/DE/FR/IT/ES, with a "steer it" line for regenerating); without it a template fills Isaac's intro structure in English.
- **Bulk emails to Gmail**: "Bulk emails to Gmail" on the BD pipeline drafts one email per prospect (sorted by momentum, filtered by the market you have selected) to its most senior, most relevant contact with an email address (founder, e-commerce or marketing lead first; interns and info@ inboxes last; someone already emailed is skipped in favour of a colleague), and saves every draft straight into Gmail's Drafts folder so a batch can be sent from the inbox in one sitting. Prospects with a draft or an email already out are skipped unless "Include already drafted" is ticked; the preview shows exactly who gets each email before it starts. Outreach emails > "Save all to Gmail" does the same for drafts written one by one. Every draft follows Isaac's reference email: the number in the first line, one Brightform paragraph, one ask, no exclamation marks, no product category, no "caught our eye".
- **Gmail hand-off**: "Open in Gmail" hands the reviewed draft to Gmail so it is sent from Isaac's own account. Drafts are condensed (impact line, at most three proof points, one ask), use the brand name rather than the shop handle, and go to Gmail as HTML so headings are real bold rather than asterisks. With a Google OAuth client configured (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, redirect URI `<PUBLIC_URL>/api/gmail/callback`, scopes gmail.compose and gmail.readonly) and Gmail connected once from the Outreach emails page, the draft is created in the account's Drafts folder and opened; without it a prefilled Gmail compose window opens instead. "Mark as sent" ticks the Gmail channel, moves a new prospect to contacted and logs the send in the history. Every step (drafted, saved to Gmail, sent) is in the prospect's outreach history.
- **LinkedIn sequence**: next to a decision maker with a LinkedIn URL, "Connect on LinkedIn" opens their profile, logs the request, ticks LinkedIn and sets a reminder to check back (3 days by default). "They accepted" writes a short follow-up message (under 300 characters, Isaac's voice) to copy into LinkedIn; "Message sent" logs it and schedules a chase. Reminders live under Outreach emails > Follow-ups and are DMed on Slack at 09:00 on workdays to whoever logged them (pick your name in the "You are" box top right so actions are logged under you).
- **Suggested TikTok Shop POC**: the prospect detail names who at TikTok Shop to loop in, from the contacts kept under Outreach emails > Voice, Gmail & contacts: the category contact for the market first, otherwise the market's agency manager to ask in Lark.
- **Team activity**: Outreach emails > Team activity shows, per person, outreach actions by channel, emails sent, LinkedIn requests and connections, drafts, notes, replies and meetings, plus a weekly series.
- **Enterprise alerts**: Outreach emails > Alerts flags a household name from the watchlist (seeded from the lead sheet's enterprise names and Isaac's outreach; editable, and a lead-sheet tab can be synced in) that shows up as a recently launched shop: created in the last 90 days, sales only just started, or new in a pull after alerts were switched on. Scanned after every pull and import.
- **Call follow-ups**: with `TLDV_API_KEY` set, every tl;dv call gets a follow-up email drafted from the notes and transcript (thanks, what we discussed, next steps) to the external attendee, saved under Outreach emails > Call follow-ups and, when Gmail is connected, straight into Gmail drafts. Checked every 30 minutes.
- **Outreach checklist and history**: TTS AM, Gmail and LinkedIn per prospect. Ticking a channel asks for an optional note (who you contacted, about what) and writes a history event with the channel, note, contact and who ticked it; status changes and "+ Note" entries land in the same history, which lives in the prospect detail. Outreach is complete only when all three are ticked; the CRM overview per country counts prospects, any outreach, complete, won and lost.

## Account monitor

Account management > Account monitor scans every managed account on a schedule (15 minutes by default) for the things that go wrong quietly and clears each flag when the condition goes away. Dashboard rules use what the app already knows: checklist not done after 14:00, checklist check errors, buyers or creators waiting over 24 hours, no live promotion, GMV down 30%+ week on week or stale, TikTok authorisation expiring, no commission terms. TikTok rules call the Shop OpenAPI per authorised shop: orders waiting to ship over 48 hours, orders down 40%+ week on week, cancellation rate over 15%, return rate over 12%, products deactivated or frozen by the platform, active SKUs under 10 units. Rules can be switched off individually; flags can be acknowledged. Add rules in `src/monitor/index.ts`.

### Instant issue alerts to Slack

Account monitor > Instant alerts to Slack turns anything that needs a human today into an incident and posts it to the account's internal Slack channel (set per account on the Accounts page, or a default channel) with what happened, severity, the recommended action and the owner (the account's AM, @-mentioned when their Slack id is on the Team page). Detected on every monitor scan: negative settlement statements and failed or unpaid payouts (TikTok finance API), seller or shop status no longer ACTIVE and rejected tax forms (seller status API), products failed in review with EPR / compliance reasons flagged separately (product API), orders overdue to ship, products deactivated for violations, expiring authorisation, GMV drops and inbox SLA breaches (monitor flags), and SKUs out of stock or under the critical days-of-cover (stock module). Ad account and campaign issues arrive from outside: the "Raise an incident by hand" form, or `POST /api/incidents/ingest` with `{ "account": "Kijimea DE", "kind": "campaign_issue", "message": "..." }` from a Zap or another tool. With `ANTHROPIC_API_KEY` set, Claude tightens the note and the action for the specific case. Repeats are deduped for the cooldown (24 hours by default); when the condition clears, the incident resolves and a "Resolved" reply lands in the Slack thread.

## Stock

Account management > Stock keeps a countdown per SKU for every authorised TikTok shop: on hand from the product inventory, units sold in the last 7 and 30 days from the orders API (refreshed every 6 hours or on demand), a units-per-day velocity (60% last week, 40% last month, overridable per SKU), days left and the stock-out date. SKUs out of stock or under the critical / low thresholds (7 and 14 days by default) show as alerts on top and feed the instant Slack alerts. Pick a shop, move the "days of stock to cover" slider (plus an optional lead time), and "Download CSV" produces the replenishment file: only the SKUs that need sending in, with product, seller SKU, on hand, velocity, countdown and the send-in quantity (velocity × days − on hand). SKUs the client handles can be excluded.

## Client reports

Account management > Client reports writes the weekly or monthly report for an account from: GMV and affiliate GMV vs the previous period (Cruva sync, per shop), TikTok Shop analytics per authorised shop, what the market is doing from the BD pipeline's FastMoss pulls (shops tracked, how many are surging, the leaders), the tl;dv calls with the client in the period (matched by the client email domain or the account name; highlights become "what we did"), promotions live, incidents handled and checklist completion, plus notes typed in by the AM. Claude writes it (headline, the numbers table, what we did, what we are doing next, market context, what we need from you); without a key a template fills the same shape. The report is edited in place (preview or text), regenerated with fresh data or instructions, downloaded as Markdown, and "Send to client channel" posts it to the account's client Slack channel (long reports continue in the thread).

## Cruva playbook

Account management > Cruva playbook is the best-practice CRM setup distilled from the shops that perform: CRM groups (sample sent, content not posted, top creators, inactive 30d+, existing creators), the DM automations that run on them (sample sent, content not posted, push more videos, retarget + bonus, deals info), the new-affiliate outreach automations (first outreach, monthly deals outreach, new product outreach), AI auto replies, a top-creator collab, a sample-to-post chase workflow and a monthly creator email, each with DM copy in EN / DE / FR / IT / ES ([brand] is filled in per shop). The matrix shows every Cruva shop against every item: green set up, red missing, grey unknown. Remote state comes from the Cruva API when `CRUVA_API_KEY` is set and the endpoint paths are known (Settings tab; `CRUVA_ENDPOINTS` JSON), otherwise paste the output of the Cruva MCP `list_automations` / `list_groups` / `list_workflows` / `list_email_campaigns` tools per shop and the names are matched. Tick shops and columns and "Apply" creates the missing items in each shop's language: over the API when configured, otherwise as an apply pack (one MCP tool call per item, groups first) to run with the Cruva MCP, after which pasting the listing back turns the cells green. Items are editable in the Library tab.

## Client copilot

Account management > Client copilot answers client questions from evidence instead of memory. Sources are indexed into one store per account: tl;dv call notes and transcripts (last 180 days, matched by client domain), emails with the client domain (Gmail read scope), the client Slack channel (last 30 days), the SOP / context library, reports, incidents, the CS and affiliate inbox, and the account numbers (GMV by week, stock countdown, promotions). Type a question or let it arrive: the client Slack channels are polled every 5 minutes and any message that reads as a question becomes an item, as do emails from client domains; the AM gets a Slack DM with the draft. The draft cites its sources with [n] marks and lists the passages underneath; edit it, then "Reply in Slack thread" or "Create Gmail draft" sends it (marks stripped). Accounts need a client Slack channel and client domain (Accounts page).

## CS & affiliate inbox

Account management > CS & affiliate inbox reads buyer chats (customer service) and creator DMs (affiliates) from every authorised TikTok shop and lets the team reply from one place.

- **Reading**: polled every couple of minutes through the Shop OpenAPI (customer_service 202309, affiliate_seller 202412/202505); changes show up live.
- **Context**: each reply is drafted from the context library (editable per language, per channel, per account), live promotions for that shop and market, the products in them, earlier threads with the same buyer or creator, and Cruva outreach notes for creators (`POST /api/inbox/cruva-outreach/import` with `{ rows: [{ creator_handle, summary, occurred_at }] }`).
- **Drafting and sending** use the Anthropic API (`ANTHROPIC_API_KEY`, model `REPLY_MODEL`, default claude-sonnet-5). Draft with Claude, edit, Send. TikTok only lets a shop message buyers with a recent order or conversation; those threads are read-only.
- **Auto-reply** has one master switch at the top of the page and, per account, a switch for customer service and one for affiliate DMs. A reply only goes out automatically when the master switch and the account switch are on, the last message is from the other side and is text, it is newer than the age limit (48h by default), nothing was auto-sent for that message already, and at least 10 minutes passed since the last auto reply in that thread. Every auto reply is recorded with the message it answered.

## Slack notifications

Paste an incoming webhook URL into the rule. After each run you get one line:

`Asana sweep - GreatVita - AM Daily Checklist (Pilot): 14 scanned, 13 deleted, 1 skipped (one-off or incomplete). View run`

Dry runs say "would be deleted" instead. If a run fails (token expired, project inaccessible, cap exceeded) the error text is posted.

## Things it handles on purpose

- Two incomplete tasks with the same name: the completed twin is still deleted, and the run carries a warning so you can spot the duplicate.
- Completed task with subtasks: deleted anyway (Asana removes subtasks with the parent). The subtask count is recorded in the run items.
- Recurring task renamed mid-life: the old completed copy has no twin, so it is skipped as "no twin". Clean it up by hand.
- Token expired or project inaccessible: the run fails with a clear error, the rule stays enabled, Slack gets the error.
- Two triggers at once (schedule plus Run now): the second is skipped and logged.
- Asana rate limits and pagination: handled in the client with backoff.

## Layout

```
src/asana       Asana REST client: pagination, 429 backoff
src/sweep       match.ts (pure matching logic), runner.ts (fetch, plan, delete, record, notify)
src/checklist   evaluate.ts (pure completion logic), checker.ts (daily check, Slack digest), reminders.ts (AM DMs), calendar.ts
src/gmv         cruva.ts (REST client), sync.ts (daily pull), grading.ts (pure score + letter)
src/reports     calendar, GMV and grade aggregations for the dashboard
src/leads       lead sheet CSV parsing, sync watcher and AM points
src/bd          FastMoss seed, rise score, Apollo client
src/inbox       TikTok inbox sync, context builder, Claude drafting, auto-reply gate
src/tts         TikTok Shop OpenAPI client, promotions push, markets
src/live        change watcher (per-board modified_since polling) and the event bus behind the dashboard's live updates
src/scheduler   node-cron registration per rule and for the daily check, plain-English schedule text
src/db          SQLite schema, migrations (seed rule), queries
src/notify      Slack webhook
src/web         Express API + auth, and the React dashboard in src/web/client
tests           matching outcomes, checklist evaluation, schedule text, runner integration
```

Auth is a single shared password behind a signed cookie, in `src/web/auth.ts` behind a small interface so it can be swapped when this is mounted inside the agency dashboard.

## Environment variables

| Name | What |
| --- | --- |
| `ASANA_PAT` | Asana Personal Access Token |
| `DASHBOARD_PASSWORD` | Shared login password |
| `PORT` | Port to listen on (3000) |
| `DATABASE_PATH` | SQLite file path (`/data/sweep.db` in Docker) |
| `PUBLIC_URL` | Public dashboard URL for Slack links |
| `SESSION_SECRET` | Optional cookie signing secret, derived from the password if blank |
| `SLACK_BOT_TOKEN` | Optional Slack bot token: DM reminders, instant incident alerts, client reports and copilot replies (chat:write, channels:history, conversations.list) |
| `CRUVA_API_KEY` | Optional Cruva REST API key for the daily GMV sync |
| `CRUVA_BASE_URL`, `CRUVA_STATS_PATH` | Optional overrides for the Cruva stats endpoint |
| `CRUVA_ENDPOINTS` | Optional JSON of Cruva CRM paths for the playbook (`{"automation": "/v1/automations", ...}`) |
| `AM_PASSWORD` | Optional read-only login for account managers |
| `TTS_APP_KEY`, `TTS_APP_SECRET` | TikTok Shop Partner Center app, for promotions and the inbox |
| `LEADS_CSV_URL` | Optional CSV URL to mirror as the lead list instead of the Google Sheet export |
| `APOLLO_API_KEY` | Optional Apollo.io key for decision-maker search and reveal |
| `INGEST_TOKEN` | Optional bearer token for `POST /api/bd/import` |
| `BD_PULLS_DIR` | Optional folder watched for daily FastMoss pull files (default `data/bd-pulls`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Optional Google OAuth client so BD email drafts land in Gmail's Drafts folder and sent outreach can be pulled as voice samples |
| `TLDV_API_KEY` | Optional tl;dv key so every recorded call gets a follow-up email drafted |
| `ANTHROPIC_API_KEY`, `REPLY_MODEL` | Anthropic API key and model for drafting and auto-replies |
