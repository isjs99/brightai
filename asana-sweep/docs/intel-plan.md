# Deal intelligence and competitor intelligence: the plan

Plan only. Nothing here is built yet. It covers two things Isaac asked for:

1. **Deal intelligence** under Growth › BD pipeline and Leads: how deep we can go on a prospect. Org chart, the people behind the shop, who at TikTok Shop sits on the account, what the decision makers post and attend, who we already know, and how warm the deal really is.
2. **Competitor intelligence** as a new tab under Growth: Genuine, Unsociable, Flywheel, AdToker, AdBaker and the rest, across every European market. Which brands they run, who their people are, who joins and leaves, who at TikTok Shop is close to them, who they are warming up in public.

The honest frame first: most of the depth is available through sources we already pay for or that are public and documented. The thing people imagine when they say "scrape LinkedIn" is the one part that is not available in a way we should run on a server. The plan is built so we get ninety percent of the value without touching that, and names the licensed route for the last ten.

## 1. What we already have

- **BD pipeline**: FastMoss fast risers per market every morning, Apollo enrichment (company, people, two reveals), outreach checklist and history, launch signals, enterprise watchlist, bulk Gmail drafts, LinkedIn sequence (manual, logged), Lark drafts to TikTok Shop.
- **TikTok Shop directory**: 172 people across DE, UK, ES, IT, FR, Benelux, mined from Gmail signatures with closeness scores and "who gives us leads".
- **Evidence index**: every tl;dv call, email and Slack message, searchable, with the privacy filter that keeps internal calls out of anything about a deal.
- **Targets and Onboarding**: the deal board with the Claude read per lead.
- **Pitch designer**: research pass per client (site, FastMoss, Cruva, Amazon, context on record).

Everything below plugs into those. No new silo.

## 2. What is possible, source by source

Traffic light: green is an API or a licence we hold, amber is public web that needs care, red is not something to automate.

| Source | What it gives | Light | Cost |
|---|---|---|---|
| **Apollo people search** (we have it) | Everyone at a company by domain: title, seniority, department, location, time in current role, LinkedIn URL. Filters for people who started in the last N days (joiners), headcount growth, job postings and funding. No credits for search. | Green | 0 per search, 1 credit per reveal |
| **Apollo job postings** | Every open role at a company with location and title. Where a competitor is expanding, which market, which function. | Green | 1 credit per company per pull |
| **Apollo website visitors** (pixel on brightform.agency) | Which companies read our site, which pages, how often, and the people when confidence is high. A prospect who reads the pricing page after the pitch is a signal. | Green | Plan feature, check tier |
| **Apollo org enrich** | Industry, size, HQ, LinkedIn page, tech stack (Shopify, Klaviyo, etc.), funding. | Green | Have it |
| **FastMoss** (we have it) | Shops, products, creators and videos per EU market. A brand's shop performance, which creators post for it, the creator agency (MCN) behind creators in the US. For Europe the agency endpoints return nothing, checked on 6 Oct for UK and DE. | Green | Credits per call |
| **Cruva marketplace** (we have it) | Brand videos, creators per brand, brand GMV, creator profiles, sample requests; across EU regions. | Green | In plan |
| **Companies House API** (UK) | Officers, persons with significant control, filings, confirmation statements, incorporation, address. Free, documented. | Green | Free |
| **Handelsregister / North Data / OpenCorporates** (DE, FR, IT, ES) | Directors, registered entities, VAT numbers, group structures. OpenCorporates has an API; North Data is paid. | Green / amber | Free to modest |
| **Company websites** (prospects and competitors) | Client logos, case studies, team page, careers page, press page, blog. Weekly fetch, diff against last snapshot, Claude extracts "new client", "new hire", "new market". Public, respects robots.txt. | Green | Nothing |
| **ATS job boards** (Greenhouse, Lever, Workable, Personio, Teamtailor) | Public JSON feeds of open roles at a company, no login. Fuller than Apollo and free. | Green | Free |
| **Press and news** (Google News RSS, Bing News API, company press pages, PR Newswire RSS) | Announcements, partnerships, awards, quotes from TikTok Shop staff naming an agency. | Green | Free to modest |
| **YouTube Data API** | Interviews, podcasts and panels with competitor founders or TikTok Shop staff; transcripts via captions. Public, documented, free quota. | Green | Free |
| **Podcast feeds** | Episodes with competitor people as guests; transcribe or use show notes. | Green | Free |
| **Events** (Eventbrite API, Luma public pages, Meetup API, TikTok Shop Academy and Summit pages) | Who hosts and co-hosts, speakers, dates, cities. A competitor co-hosting with TikTok Shop UK is a relationship signal. | Green / amber | Free |
| **TikTok public profiles and videos** of agencies and their founders | What an agency posts, which brands it tags, which TikTok Shop staff appear. Through FastMoss and Cruva for commerce data; the public page for the rest. | Green / amber | FastMoss credits |
| **Our own comms** (tl;dv, Gmail, Slack, lead sheet) | Prospects telling us who else they talk to ("we are also speaking to Genuine"), lost reasons, who introduced whom, who sits on which account at TikTok Shop. | Green | Nothing, already indexed |
| **Google Calendar** | Who from our side has met whom; the start of a mutual connection graph. | Green | Nothing |
| **Trustpilot, Glassdoor, Kununu** | Public reviews of competitors by clients and staff; signals on churn and culture. Reading the public page is fine, automated scraping is against Glassdoor's terms. | Amber | Manual or vendor |
| **LinkedIn company pages and posts** | Who liked and commented, who they tag, who joined. There is no public API for this. Automated collection breaks LinkedIn's terms and gets the accounts used for it restricted or banned, which for Isaac and the AMs is the whole outreach channel. | Red to automate | Account risk |
| **LinkedIn-derived data vendors** (Crustdata, Coresignal, People Data Labs, Bright Data) | Employment histories, job changes, posts and engagement bought under licence. Legal position varies by vendor and country; needs a review before we sign. | Amber | Paid, from a few hundred a month |
| **Instagram, X** | Instagram's API only covers accounts we own; X's API is paid and expensive for what we would get. Public pages can be read by a person, not worth automating. | Amber / red | Not worth it |

The pattern: Apollo plus company registers plus website diffs plus press plus our own comms covers people, movements, clients and relationships. LinkedIn engagement (who liked what) is the one thing left, and the plan handles it with a human clip rather than a bot.

## 3. Deal intelligence: how deep per prospect

Lives in the prospect detail (BD pipeline) and on the lead (Leads, Targets), as an **Intel** tab. Same collapsible style as everything else, bell on new signals.

### 3.1 Account map (org chart)

- Pull everyone at the company from Apollo by domain (free), grouped by department and seniority: founders and C-suite, e-commerce and digital, marketing and brand, sales and retail, finance, operations. Render it as a tree with the people we already have as contacts highlighted.
- Mark **new in role** (started in the last 90 days), **hiring for** (open roles that touch TikTok, social commerce, creators, affiliates), **headcount growth**, **tech stack** (Shopify, Klaviyo, Gorgias and so on tell us how mature the DTC side is).
- Officers and PSCs from the register for UK and DE companies, so the signatory for a contract is known before the deal gets there.
- A **buying committee** card: Claude names the likely decision maker, the champion, the budget holder and the blocker from titles and what they have said in our calls and emails, with the evidence lines under it.

### 3.2 TikTok Shop side of the account

- The known TikTok Shop AM on the account (already a field) plus the category owner and TSP manager for the market from the directory.
- Closeness: who in the directory has given us leads, replied, met us; and from the human clip (section 5) which TikTok Shop staff engage with this brand or a competitor on it.
- Lark draft to the right person is already there; this surfaces whether the brand is already with a TSP (from calls, emails, press, website diffs, the competitor client lists in section 4).

### 3.3 Signals timeline

One timeline per prospect, newest first, every row with source, link, date and a one-line summary:

- Funding, headcount, job postings, new senior hire (Apollo).
- New shop, GMV took off, new market, creator surge (FastMoss, Cruva, our pulls).
- Press, awards, podcast and YouTube appearances of the decision makers.
- Events they speak at or host.
- Website changes: new product line, new market page, "we are hiring", a TSP logo appearing.
- Website visits to brightform.agency (Apollo pixel): which pages, when, after which email.
- Our own: emails sent and replied, calls, Slack, LinkedIn steps logged, Lark messages.

### 3.4 Warmth score and the read

- A score from the timeline: engagement with us, buying signals, timing signals, channel coverage. Shown next to the momentum score so BD sees "hot shop, cold relationship" at a glance.
- Claude writes the read: where the deal is, who to talk to next and about what, which competitor is in play, the one thing that would move it. Rules only without a key, like Targets.

### 3.5 Who we know

- A mutual-connection graph from what we actually have: Gmail threads, calendar invites, tl;dv attendees, Apollo "saved by" and our own outreach log. "Ana met their head of e-commerce at the TikTok Shop summit in May" is worth more than a LinkedIn degree count and it is ours to use.
- LinkedIn mutuals come from the clip (section 5), never from a bot.

## 4. Competitor intelligence: Growth › Competitors

A new tab. Registry of competitors per market, one collapsible block per competitor, a weekly digest to Slack, and an overlap view against our pipeline.

### 4.1 Registry

- Seed: Genuine, Unsociable, Flywheel, AdToker, AdBaker, plus the agencies on the TikTok Shop partner directory per market (UK, DE, FR, IT, ES, NL, IE), plus every agency named in our lost deals and in calls ("we went with X"). Editable, with domain, LinkedIn page, TikTok handle, markets, HQ entity, register ids.
- Each competitor is an Apollo organisation, a set of register entities (one per country where they have one), a website, a TikTok handle, a YouTube presence and a list of ATS boards.

### 4.2 People: who they are, who joins, who leaves

- Weekly Apollo pull of everyone at the domain (free). Diff against last week: **joined** (new row, or time in role under 30 days), **left** (row gone, or employer changed), **promoted** (title changed). Where someone came from and went to, when Apollo has it.
- Job postings (1 credit per competitor per week) and the free ATS feeds: which markets and functions they are staffing. "Hiring a German-speaking account manager in Berlin" says DE is next.
- Register: officers and filings; a new director or a new entity in a country is a market entry signal.
- Output: the competitor's org chart with changes highlighted, and a movements feed. A leaver with a TikTok Shop background is also a recruitment lead for us, flagged separately.

### 4.3 Clients and brands

Which brands each competitor runs, from several angles that corroborate each other:

- **Website diffs**: client logo walls, case studies and "results" pages, fetched weekly, diffed, Claude extracts brand names with the evidence snippet.
- **Press and awards**: partnership announcements, TikTok Shop partner awards, trade press.
- **Public TikTok and YouTube**: brands tagged in the agency's own content and in founder interviews.
- **Our comms**: prospects and clients telling us who runs whom; lost-deal notes on the lead sheet.
- **FastMoss and Cruva cross-check**: for every brand attributed to a competitor, the shop's GMV, creators and momentum, so we can see how their book performs and which of their clients are slipping (a slipping client of a competitor is a prospect for us).
- Confidence per attribution (how many sources, how recent), and a "lost to" link from our pipeline when a prospect shows up on a competitor's list.

### 4.4 TikTok Shop relationships

- Co-hosted events, TikTok Shop staff quoted in their press, speaking slots at TikTok Shop events, partner awards: from the event and press sources above.
- From the human clip: which TikTok Shop staff engage with the competitor's posts and how often. Rolled into the directory as "closeness to competitor X" next to our own closeness score, so for each category owner we know who they lean towards.
- A per-market view: for DE, who at TikTok Shop is close to whom.

### 4.5 Who they are warming up

- Public posts and content tagging brands that are not yet their clients, repeated over weeks, are a courtship signal. Captured from TikTok and YouTube automatically and from LinkedIn through the clip.
- Website visitor data on our side flips it: a competitor's staff reading our site is worth knowing too.
- Both land in the digest: "AdBaker tagged Waterdrop in three posts this month; Waterdrop is in our DE pipeline, not contacted yet."

### 4.6 Overlap and the weekly digest

- Overlap table: our pipeline × competitor client lists and courtship targets. Columns: brand, market, our status, competitor, confidence, last signal. Sort by our momentum score.
- Slack digest every Monday to the BD channel: joiners and leavers, new clients, new markets, events coming up, courtships that touch our pipeline, and anything that changed in the TikTok Shop relationships. Each line links back to the evidence.

## 5. The LinkedIn question

What we will not do: run a bot or a headless browser against LinkedIn from the server, or buy "LinkedIn automation" tools that log in as Isaac or the AMs. It breaks the terms, it gets accounts restricted, and those accounts are the outreach channel.

What we do instead:

1. **Apollo for employment data.** Titles, moves, time in role, headcount, job postings. This is most of what people want LinkedIn for, and it is licensed.
2. **A clip button for engagement.** A small browser extension (or a bookmarklet to start) for the team: when an AM is already looking at a post or a profile on LinkedIn, one click sends the URL, the author, the text and the visible engagers to the dashboard, where Claude files it against the right competitor, brand or TikTok Shop person. A person deciding to save what they are looking at is bookmarking, not scraping. The team already reads these feeds; this just stops the knowledge evaporating.
3. **A licensed vendor for the rest, after review.** If the clip is not enough, evaluate Crustdata or Coresignal for job changes and post data under a data licence, with a written legitimate-interest assessment and a check of their collection basis. Decision point, not a default.

## 6. Legal and privacy

- We process professional data about people at companies (name, title, employer, work contact, public professional activity). Under GDPR and UK GDPR that is B2B prospecting on legitimate interest; we write the assessment down once, keep a record of processing, honour objections and access requests, and tell people where their data came from when we first contact them (Apollo already supports this).
- No special-category data, no private life, no inference about it. Internal calls stay out, the same rule as Targets.
- Retention: signals and snapshots kept 12 months, people rows refreshed or deleted when they leave a company we track.
- Public web: respect robots.txt and rate limits, identify ourselves in the user agent, fetch weekly not hourly, never behind a login.
- Vendors: licence terms and collection basis reviewed before signing; nothing bought that was collected by logging in to someone else's platform against its terms.

## 7. How it is built

Data model (new tables, in-code migrations like everything else):

- `intel_entities`: companies and people we track (prospect, competitor, TikTok Shop staff, brand), with external ids (Apollo, register, FastMoss, Cruva), domain, handles.
- `intel_snapshots`: page or feed URL, fetched at, content hash, extracted text; diffs computed on change.
- `intel_signals`: entity, kind (joined, left, promoted, hiring, funding, new_client, courtship, event, press, mention, visit, register_change, website_change, clip), source, url, observed_at, summary, evidence snippet, confidence, dedupe hash, seen_by.
- `intel_relations`: entity to entity with a type (runs_brand, employed_by, close_to, co_hosted, courting) and confidence, so the org chart, the client list and the closeness map are all queries over the same table.
- `competitors`: the registry, and `competitor_watch` for per-market settings.

Jobs on the scheduler: Apollo people diff (weekly), job postings and ATS feeds (weekly), website and press fetch (weekly), YouTube and podcast feeds (weekly), register checks (monthly), FastMoss and Cruva cross-checks on attributed brands (with the daily pull), visitor sync (daily), digest (Monday 08:00 CET). All with the usual "last run, last error, run now" strip.

Extraction: Claude turns raw diffs, articles and transcripts into signals with the evidence snippet and a confidence, never a bare claim. Without a key, rules keep the structured sources (Apollo, registers, feeds) working and skip the free-text ones.

UI: Growth › Competitors (registry, per-competitor blocks with People, Clients, TikTok Shop, Courtship, Timeline; overlap table; digest preview), Intel tab in the prospect detail and on leads (account map, TikTok Shop side, timeline, warmth, who we know), the clip inbox under Growth › Outreach for anything Claude could not file by itself.

## 8. Phases

1. **Competitor registry, people movements, clients from the web, digest.** Apollo diff, job postings and ATS feeds, website and press snapshots with Claude extraction, overlap with our pipeline, Monday digest. Two weeks. This is the biggest win for the least risk.
2. **Prospect intel.** Account map from Apollo, register officers, signals timeline, warmth score and the Claude read, website visitor sync if the Apollo tier has it. Two weeks.
3. **Relationships and content.** Events, YouTube and podcasts, TikTok public content, TikTok Shop closeness per competitor, courtship detection, the clip extension. Two to three weeks.
4. **Vendor decision.** Only if the clip leaves a real gap: evaluate a licensed LinkedIn-data vendor with the legal review, then wire job changes and post engagement through the same signals table.

## 9. What Isaac decides

- The competitor list per market to start from, and whether the TikTok Shop partner directory agencies all go in or only the ones we meet in deals.
- Apollo tier: website visitors and the advanced filters are plan features; worth checking what the current plan includes before phase 2.
- Whether to install the Apollo pixel on brightform.agency.
- Budget appetite for a data vendor in phase 4, and who does the legal review.
- Who in the team gets the clip extension first.
