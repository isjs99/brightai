# Asana Sweep

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

## Checklist completion check (16:00 every workday)

Separate from the sweep, the dashboard checks every account's checklist project once a day (weekdays 16:00 Madrid time by default, change it under Checklists > Settings) and records who is done.

- **AM** = tasks assigned to the account manager named on the account.
- **AA** = everything else: tasks assigned to anyone who is not the AM, and subtasks (the AA's action items).
- An account is **complete** when both AM and AA are complete. AM and AA are also shown separately.
- A checklist item counts as done if a copy of it was completed today. Weekly items only count on the day they are due.

Screens:

- **Checklists**: today's status per account with AM / AA / combined, expandable to every item and subtask. "Check all now" runs it immediately. The date picker shows past days.
- **Analytics**: completion rate per AM and a per-account, per-day grid for the last 7 to 90 days.
- **Accounts**: the roster (name, markets, AM, AA, linked Asana project). Link a project by searching its name. "Add (dry run)" creates a sweep rule for that project in one click.

If a Slack webhook is set under Checklists > Settings, a digest is posted after each scheduled check.

### Recurrence warnings

The Asana API cannot set or read a task's repeat setting, so the check infers it. Two flags show up per item:

- **no new copy: repeat not set?** The task was completed today but Asana did not spawn a fresh copy. Open the task in Asana and set it to repeat every workday.
- **no due date**. A task without a due date cannot repeat. Give it one.

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
src/checklist   evaluate.ts (pure completion logic), checker.ts (daily check, Slack digest)
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
