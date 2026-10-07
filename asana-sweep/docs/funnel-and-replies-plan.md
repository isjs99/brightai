# Two plans: the self-learning Cruva funnel, and why affiliate replies are not sending

Plan only. Nothing here is built yet.

1. **Cruva funnel from the top 5%**: Cruva content for every shop is read on a schedule, the top 5% of videos by GMV is worked out, what makes them work is written down per shop, and that feeds a full creator funnel drafted step by step in the shop's language with English next to it. The AM walks the steps until every best-practice CRM piece is live.
2. **Affiliate replies**: Belively is on automatic with a cap of 2 a day and nothing goes out. I read the reply engine line by line; there are four reasons, three of them code bugs, one a setting. The fix list is at the end.

---

## Part 1: the funnel that learns from the top 5%

### 1.1 What exists today

Settings › Cruva setup (the playbook) already does most of the plumbing:

- A library of 22 best-practice items in `src/playbook/seed.ts`: the nine CRM groups (sample sent, delivered, first sale, content not posted, no post in 10 days, rejected, top creators, inactive, existing), the lifecycle bots as automations, the outreach pushes (first outreach, monthly deals, new product, top creators collab), the creator brief, the newsletter email, the AI auto-replies check, two Cruva workflow templates, tags and the hygiene items.
- Copy in five languages (en, de, fr, it, es) with `[brand]`, `[month]`, `[brief_link]` and Cruva's `[affiliate_name]` filled in per shop.
- A check that reads each shop through the Cruva MCP and marks every item set, paused, drift, missing or manual.
- Prepare → review → rollout: drafts the missing pieces, the reviewer amends (Claude rewrite on request), approves, and the rollout creates them through the same MCP tools, paused unless told otherwise. Undo exists.
- "Learned" per shop: categories, products, contact email, timezone, sender emails, lists, brief link, plan.

What it does not do: it knows nothing about which content actually sells for the shop, the copy is generic best practice rather than the shop's own proof, and the rollout is one big list rather than a walk.

### 1.2 What "top 5%" means and where it comes from

Per shop, per 28 days:

| Source | Call | What we take |
|---|---|---|
| Cruva | `list_marketplace_brand_videos` / `search_videos` for the shop | Every affiliate video in the window: creator handle, product, GMV, units, views, likes, posted at, video URL |
| Cruva | `list_brand_creators`, `get_creator_data`, `get_performance_score` | The creator behind each video: follower band, GMV for us, videos for us, sample status, tags |
| Cruva | `get_video_download_url` | Only for the top videos, to pull the transcript (see 1.3) |
| FastMoss | `video_detail_analysis`, `video_script_info` | Script, hook line, length, hashtags, sound for the same top videos (FastMoss has the script already; cheaper than transcribing) |
| FastMoss | `shop_video_analysis`, `product_video_list` | The shop-level view: which products get content, GMV per video by product |
| TikTok Shop API (where linked) | affiliate order rows already in `health_pulls` | GMV per video id as the shop sees it, to reconcile with Cruva |

Ranking: videos sorted by GMV in the window, top 5% by count (minimum 5, maximum 40), and a second cut "top by GMV per view" so a small creator with a brilliant hook is not drowned out by a big one. Both lists kept.

The 5% is a setting per shop (default 5, allowed 1 to 20) because a shop with 40 videos a month needs a bigger slice than one with 2,000.

### 1.3 What we learn from them

One Claude pass per shop per week (Sonnet, the content is short), input is the top list with scripts, creator profiles and product names. Output is a fixed JSON "content profile" stored per shop with the week it was learnt:

- **Hooks that work**: the first line of the top scripts, grouped (problem first, result first, price first, unboxing, comparison, trend sound).
- **Formats**: talking head, voice-over demo, before and after, GRWM, haul, duet, live clip.
- **Products that carry**: which SKUs the top 5% sell, and which products get content but no GMV (the ones to stop pushing).
- **Creator shape**: follower band, niche, posting cadence, how many were on their first video for us. This becomes the AI search filter for new creators.
- **Timing**: day and hour the top videos went up, in the shop's timezone.
- **Price and offer**: whether the top videos mention a deal, a bundle, free shipping.
- **Three example scripts**: the best three, quoted, with the creator credited, in the shop's language.

Everything is evidence-backed: each claim carries the video ids it came from so the AM can click through. No number that is not in the input (same rule as the health review).

Cost: around 40 videos × 300 tokens of script plus profiles, about 20k input tokens a shop a week, under $0.10 a shop on Sonnet. For 20 shops that is $2 a week. Budgeted under the existing daily Claude budget as feature `playbook`.

### 1.4 How the profile changes the funnel

The point of learning is that the copy stops being generic. Every funnel step below gets the shop's own proof substituted in. New placeholders next to `[brand]`: `[top_hook]`, `[top_format]`, `[top_products]`, `[example_creator]`, `[example_script_url]`, `[best_day]`, `[offer]`.

The full funnel, in the order a creator experiences it. Items marked **new** are not in the library today.

| Step | Cruva piece | Kind | Learns from the profile |
|---|---|---|---|
| 1 | Creator brief | brief | Content ideas section becomes the three example scripts and the hooks list; products section is the "products that carry" list |
| 2 | AI search list: creators like our top 5% | list | Filters set from creator shape (band, niche, cadence) instead of category only |
| 3 | First outreach | automation | Mentions `[top_hook]` style and one example creator's result as social proof |
| 4 | Top creators collab (invite + DM) | automation | Products in the invite are the ones that carry; commission from the shop's plan |
| 5 | Sample sent | automation (bot) | "Ideas that worked last month" block is the hooks list, not the fixed three lines |
| 6 | Delivered, content pending | automation (bot) | Same, plus `[best_day]` ("Tuesday evening posts did best for us") |
| 7 | **Posted, no GMV** nudge | automation **new** | Suggests the format and hook that sells, with the example script link |
| 8 | First sale | automation (bot) | Names the product they sold and the next product that carries |
| 9 | Content not posted 7d | automation (bot) | Unchanged copy, timing from profile |
| 10 | No post in 10 days | automation (bot) | Offers the current `[offer]` |
| 11 | Rejected | automation (bot) | Unchanged |
| 12 | **Retarget with bonus** (inactive creators) | automation **new**, library has the group only | Bonus framed around the product that carries |
| 13 | Monthly deals outreach | automation | Deal line from `[offer]`, products from the profile |
| 14 | New product outreach | automation | Triggered when a new SKU appears in the shop (learned.products diff) |
| 15 | Creator newsletter | email | Sections written from the profile: what sold, best hook, this month's push |
| 16 | **Top creators thank-you and push more** | automation **new** | To the top 5% creators themselves: thanks, next product, bonus for two more videos |
| 17 | AI auto-replies, auto review, blacklist, DNC tag, VIP tag | manual / tag | Checked, not drafted. VIP tag applied to the top 5% creators automatically |

Steps 7, 12 and 16 are additions to `seed.ts` with copy in all five languages.

### 1.5 The walk: step by step, local language and English together

Today the rollout is a table of drafts. The new mode is a walk, one step per screen, for one shop:

- **Header**: step 6 of 17, what the piece does in one sentence, why it matters ("creators who get this DM post 1.4× more often", from Cruva's own stats where we have them, otherwise from our profile).
- **Status**: already set in Cruva (shown read-only with a "drift" diff if the live copy differs from ours), paused, or missing.
- **The copy, two columns**: left the shop's language, right English. Both generated from the same template and profile; the English is a faithful rendering, not a second draft, so the AM who does not read Italian can still judge the sense. Edits on the left are what gets sent; an edit on the right triggers a Claude re-render of the left with the instruction "keep the meaning, this changed". Placeholders are highlighted and the substituted values shown on hover.
- **Settings strip**: audience group, send window, daily limit, products, commission: the structured fields of the payload, editable.
- **Evidence drawer**: the profile facts used in this copy, with the video ids, so a sceptical AM can see why the hook is in there.
- **Actions**: Approve and create (paused), Approve and start, Skip with a reason, Ask Claude to rewrite with an instruction. Next step loads. The walk remembers where you were.
- **Finish**: a summary of what is live, what is paused, what was skipped and why. Coverage score per shop (already exists in `coverageByAccount`) goes to the Today page and the Monday digest: "Belively 14/17, Mamma Mia 9/17, three bots paused".

The walk is also the onboarding checklist: a new shop starts at step 1 with nothing set, the AM does the seventeen steps in an afternoon.

### 1.6 Automatic updates after the first walk

Once a shop has been walked, the weekly job keeps it current without the AM:

- Re-learn the profile every Monday 05:00.
- Diff the new profile against the one behind each live piece. If the hooks, products or offer changed materially (new product in the top list, hook group changed, offer changed), draft the new copy and put it in a **pending update** for that piece: same two-column view, one click to push, nothing changes in Cruva until approved. A setting per shop, "update bots automatically", skips the approval for the lifecycle bots only (steps 5 to 11) and logs the change.
- Apply the VIP tag to new top-5% creators and remove it from creators who dropped out for two weeks in a row.
- Post to the client Slack channel on Monday: "Top 5% this week: 12 videos, €X GMV, best hook: '…' by @creator. Bots updated: Sample sent, Delivered. One pending for your review: First outreach."

### 1.7 Build order

1. **Content pull and ranking** (`src/playbook/content.ts`): the Cruva and FastMoss reads, the 5% cut, the table `playbook_content` (shop, window, video id, creator, product, gmv, views, script, rank). Two days.
2. **Profile** (`src/playbook/profile.ts`): the Claude pass, the JSON, the evidence ids, the weekly cron, the shop card showing the profile. Two days.
3. **Placeholders and the three new items** in `seed.ts` and `payloadFor`. One day.
4. **The walk** (`Cruva.tsx`, a new `Walk` view): one step per screen, two columns, approve/skip/rewrite, resume. Three days.
5. **Pending updates and the Monday post**. Two days.
6. Tests for the ranking (ties, small shops, the per-view cut), the profile parser (never invents a number), the placeholder substitution in all five languages, the diff that decides "material change".

Two weeks of work in total. Steps 1 to 3 are useful on their own: the profile alone tells the AM what to brief.

### 1.8 What needs confirming before step 1

- Cruva's `search_videos` and `list_marketplace_brand_videos` return GMV per video for our own shops (they do for marketplace brands; I want to check the field is populated for a linked shop with the affiliate scope).
- FastMoss `video_script_info` works for EU videos (it does for US; the script field may be empty where the video has no captions).
- Whether Cruva lets an automation DM reference a video URL (some DM fields strip links). If not, the example script goes in the brief and the DM says "see the brief".

---

## Part 2: why Belively's affiliate replies are not sending

### 2.1 How a reply happens, in order

Cruva inbox sync runs every 10 minutes per shop (`cruva_inbox_every_minutes`). Each run lists unreplied threads, reads messages for the ones that changed, and then runs the reply engine **only for threads that changed in that run**. The engine then applies, in this order:

1. thread open, last message from them, has a message id
2. **already decided for this message → skip forever**
3. policy mode not off, shop not switched off
4. not paused by the team
5. message younger than "Ignore older than" (default 48 h)
6. prefilter (stickers, empty, system messages)
7. Claude key set
8. **affiliate burst wait: last message under 90 s old → skip without recording**
9. Claude classifies and drafts
10. escalation: model asked for a human, intent on the never list, intent escalates by definition, confidence under 60%, TikTok says cannot send
11. draft mode → draft
12. "only" filters (default: not do-not-contact)
13. **master switch (Settings › Connections) → draft with "master switch off"**
14. quiet hours → draft
15. daily cap → draft with "capped"
16. send through Cruva `send_dm`; a failed send records an error

### 2.2 The four reasons

**Reason 1 (bug): a decision is final, even when it was "not now".**
Step 2. Every open Belively thread was already decided during the days when the master switch was off or the Anthropic account had no credit. Those decisions are `drafted: master switch off`, `error: no credit left`, `capped`, `quiet`. When you flip Belively to automatic with a cap of 2, nothing re-runs: the engine sees a decision for the last message and skips. The Retry button I added only retries `error` decisions, and only when pressed. So the only threads that can ever auto-send are ones where the creator writes a **new** message after the switch went on, and then only if the other gates pass.

**Reason 2 (bug): the 90-second burst wait drops messages for good.**
Step 8. If the creator's last message is under 90 s old at the moment of the sync, the thread is skipped without a record. The next sync, ten minutes later, only processes threads that changed in that sync, and this one did not, so it is never looked at again. With a 10-minute cadence that is roughly one message in seven, silently.

**Reason 3 (bug): 25 threads per shop per sync, and the same 25 every time.**
The sync reads messages for at most 25 threads per shop, and it picks the ones with unread > 0 first. Cruva keeps unread > 0 until the brand replies, so a shop with more than 25 unreplied threads reads the same 25 every run and never reaches the rest. Belively has more open threads than that. Threads 26 and up are never read, so they never "change", so the engine never sees them.

**Reason 4 (setting): 48 hours.**
Step 5. Anything older than two days is skipped as stale. Most of Belively's waiting threads are older than that by now, so even a re-run would skip them. The field is "Ignore older than" on the Replies page per account and channel.

There is a fifth thing to rule out, not a bug: the default "never" list for affiliate includes every intent that escalates by definition (payment, complaint, legal, negotiation), and confidence under 60% escalates. On a creator thread that is often "where is my sample" (fine) but also often "can I get a higher commission" (escalates). If after the fixes most decisions read `escalated`, the never list is the dial.

### 2.3 The fix list

In the order to do them. All in `src/inbox/replies.ts` and `src/inbox/cruva-inbox.ts`, with tests.

1. **Deferred decisions are not final.** Treat `drafted: master switch off`, `capped`, `quiet`, `only: …`, `error: no credit`, `error: budget`, `error: send failed` as deferred. Each sync, after the changed threads, run a **sweep**: every open thread for an account in automatic mode whose last message has a deferred decision or no decision at all, within the age limit. For a deferred one, do not call Claude again: reuse the stored draft and re-apply gates 10 to 16. That means flipping the master switch, raising the cap, leaving quiet hours or topping up credit makes the waiting drafts go out on the next sync, up to the cap. Tokens are not spent twice.
2. **The burst wait records a "wait" and the sweep picks it up.** Replace the silent `continue` with a deferred decision `waiting: burst` that the sweep re-checks; after 90 s it is processed like any other.
3. **No more starvation.** Order the inbox by last message time from Cruva, raise the per-shop read budget to 100, and skip a thread that was read in the last 30 minutes with the same last message id and unread count. A "read budget used" counter goes in the sync log line so we can see it.
4. **Age limit default to 7 days for affiliate** (keep 48 h for customer service) and, for the first sweep after a switch to automatic, a one-time catch-up: the oldest waiting threads get a draft that opens with a short apology for the delay, sent within the cap. Creators are forgiving; silence is worse than late.
5. **A "Why nothing sent" panel on the Replies page per account**: counts of open threads by the gate that stopped them (deferred by master switch, capped, quiet, escalated by intent, under 60%, older than limit, do-not-contact, burst wait, send failed) with the top three threads under each. The data is already computed by `replyBlocker`; this groups it. And a **Run now** button that triggers the sync and the sweep for that account and shows the decisions it took.
6. **Send check**: a "send test DM to myself" on the Connections page that calls Cruva `send_dm` on a thread you pick, so a Cruva-side send failure is visible without waiting for a real creator.

Items 1 to 3 are a day. Items 4 to 6 another day. Tests: a thread decided under master-off that sends after the switch without a second Claude call; a burst-waited message that goes out ten minutes later; forty unreplied threads on one shop all read within two syncs; the 7-day default on affiliate; the panel counts.

### 2.4 What to do today, before any of that ships

- Replies page › Belively › Creators: set "Ignore older than" to 168 (7 days).
- Settings › Connections: master switch on (check it is on; the banner on the Replies page says if not).
- Press "Retry errors" on Belively so the credit-era errors re-run.
- Watch the Belively row: `auto_today` should show 1 or 2 within an hour if a creator writes a new message. If it stays at 0 and new messages arrive, the decisions column tells us which gate, and that confirms the order above.
