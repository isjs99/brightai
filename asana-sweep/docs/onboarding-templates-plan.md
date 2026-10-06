# Plan: client onboarding templates, contracts and document generation

What this covers: the part of Onboarding that is **not built yet**. The Targets tab and the Onboarding steps checklist are live; this plan is for generating the documents the steps point at (SLA, MoR agreement, onboarding forms, forecast, affiliate brief), filling them from the deal, and saving them into the contracts drive. It comes from a survey of the shared Drive, Gmail threads about contracts and onboarding, the client Slack channels and the external tl;dv calls. Internal calls and private founder discussions were not read and are not part of any feature here.

## What Brightform uses today (from the survey)

| Document | Where it lives | Shape | Used for |
|---|---|---|---|
| **TikTok Shop SLA (Service Level Agreement)** | Drive, one `.docx` per client (Kijimea, Zola, Nutrisslim, JMP, CFP Brands, SHS, Turmeric Vitality, Rest Up, Evolsin, Perfume Worldwide…) | Same body every time: parties and registered addresses, 1. Description of services (affiliate, advertising, content, profile, shop management, reporting), 2. Payment (retainer per store per country billed in advance, commission on GMV invoiced in arrears, how GMV is defined, creator video fees, live streaming rate), 3. Non-payment, 4. Duration (initial term, monthly renewal), 5. Termination notice, 6–13 boilerplate, signature block | Standard retainer + commission deals; sent through DocuSign |
| **MoR agreement** | Drive (Coca-Cola / CCEP with Mertens-Schabow, Qubify framework email thread) | SLA plus MoR terms: Brightform Social Media UG as EU distributor, settlement (net of platform fees, refunds, cancellations), commission on settlement, who invoices whom, payment terms, supply agreement with the brand | Brands without an EU entity |
| **Client onboarding checklist** | Google Sheet per client ("Brightform x <Client> Onboarding Checklist") | Rows: VAT number, company proof of address, 2FA device, person of authorisation, bank details, return warehouse, TikTok logins, Business Centre admin, payment card, top sellers, barcodes/dimensions/weights, then one row per SKU variation | Collected on the onboarding call |
| **Company onboarding form** | `TTS_DE_Company_Onboarding_Form.csv` | Sections: business information (legal name, entity type, address, registration, VAT/OSS, tax number, EORI), legal representative (name, role, DOB, nationality, ID), banking (IBAN, BIC, statements), supporting documents (incorporation, articles, proof of address, UBO chart), product compliance (EAN, CE, LUCID, WEEE, EPR, MRP), foreign entity (EU VAT, EU representative, 3PL), optional (trademark, distribution authorisation, TikTok brand authorisation, insurance), platform setup (business email, phone, CS contact, return address, return policy, invoice details) | Everything TikTok needs to open or verify the seller account |
| **Product onboarding SKU list** | Google Sheet template "Template - TikTok Shop Product Onboarding SKU List" | One row per SKU per market: basic (market, name, category, brand, SKU, GTIN, image filenames), attributes (weight, volume, pack, form, shelf life, origin, PTC, INCI), compliance (markings, manufacturer, responsible person, warnings), shipping (parcel weight and dimensions), description, commercial (RRP, listing price, opening stock) | Product upload |
| **P&L forecast** | Google Sheet "Template x Brightform P&L Forecast 2026" | Inputs block (content budget tier, RRP, discount %, ads GMV %, ads ROI base, COGS %, shipping/FBT estimate) and a month-by-month model: AOV, discount price, gross revenue per market, net revenue, units, creator share and GMV, ad GMV and ROI, content budget, COGS, shipping, platform fee, creator commission, samples | Pitch and onboarding; the P&L tab in this dashboard uses the same lines |
| **Creator brief** | Google Doc "BRIEF — CAP / TAP Creator Outreach" and per-client guideline decks (Canva) | Hook, product talking points, dos and don'ts, commission and sample policy, CTA | Cruva outreach and the affiliate guideline |
| **Launch tracker (enterprise)** | Google Sheet "coca-cola-launch-tracker" | Workstreams: contracts and legal, commercial, ordering and supply chain, shop build, affiliates and creators, governance; each item with owner, status and "blocked by" | Big accounts with many parties |
| **LOA / brand authorisation** | Email threads (Unilever brands via a distributor) | Letter from the brand owner authorising the seller and Brightform | Distributor-sold brands |
| **TSP binding links** | Slack #logins | One authorisation link per market and app | Every account |

Other steps that recur in the threads: Lucid packaging registration for Germany, category approval, DocuSign for every signature, Windsor onboarding links per client, the kickoff "Onboarding call summary" doc.

## What to build

### 1. Document templates with variables (`src/onboarding/docs/`)

Keep the SLA body as a template with placeholders, not a rewrite of the legal text:

- `sla.docx.template`: the current SLA body with variables `{{client_legal_name}}`, `{{client_registration}}`, `{{client_address}}`, `{{brightform_entity}}` (Social Media Limited / Social Media UG), `{{brightform_address}}`, `{{effective_date}}`, `{{retainer}}`, `{{retainer_currency}}`, `{{retainer_basis}}` (per store per country), `{{commission_pct}}`, `{{gmv_definition}}` (standard, or the MoR settlement wording), `{{markets}}`, `{{creator_video_fee_range}}`, `{{live_rate}}`, `{{initial_term_months}}`, `{{notice_months}}`, `{{payment_days}}`, `{{client_signatory}}`, `{{brightform_signatory}}`. Services section as optional blocks (affiliate, advertising, content, profile, shop, reporting) the AM ticks on or off.
- `mor-terms.docx.template`: the MoR clauses (distributor role, settlement definition, commission on settlement, invoicing route, supply terms, stock ownership and returns), inserted into the SLA when the deal basis is MoR.
- `company-onboarding-form.xlsx` and `sku-list.xlsx`: generated from the templates above, pre-filled with what the deal already knows (legal name, markets, POC) and named `<Client> – Company onboarding form`, `<Client> – Product onboarding SKU list`.
- `pnl-forecast.xlsx`: the P&L tab's forecast exported in the Drive template layout (same lines, formulas live) with the deal's retainer, commission and the client's AOV, COGS and discount inputs.
- `creator-brief.docx`: the brief skeleton filled from the SKU list and the deal (commission plan, samples), ready for the Cruva rollout.

Generation: `docx` and `xlsx` are zip files of XML; a small writer that fills placeholders in the template's `document.xml` (and sheet XML) needs no heavy dependency and keeps the exact Brightform formatting. Each generated file is also offered as a PDF through the existing PDF writer for a quick read.

### 2. Terms and parties on the onboarding (extend the terms form)

Add to the Onboarding steps terms block: client legal name, entity type, registration number, registered address, VAT ID, signatory name and title, Brightform entity and signatory, effective date, services included, creator video fee range, live rate, payment days. These feed the templates and the account.

### 3. "Generate" buttons on the steps

- Step **Contract drafted**: "Generate SLA" / "Generate MoR agreement" → fills the template, saves the `.docx` into the client's folder in the contracts drive (Drive API, folder per client under the shared contracts folder, named `YYYYMMDD TikTok Shop SLA (Service Level Agreement) - <Client>.docx` like the existing files), stores the Drive link on the step.
- Step **Contract sent**: "Send on DocuSign" → DocuSign envelope from the generated file with the signatories (needs a DocuSign API key; until then the button opens DocuSign with the file downloaded).
- Steps **Company onboarding form** and **SKU list**: "Create forms" → copies the templates into the client folder, pre-filled, shares with the POC, posts the links in the client Slack channel.
- Step **P&L forecast**: "Build forecast" → from the P&L tab's forecast for the account (or the deal's inputs before the account exists), saved as a Sheet in the client folder.
- Step **Creator brief**: "Draft brief" → Claude drafts from the SKU list, the deal and the context; saved as a Doc.
- Step **Account created**: already automatic on completion.

### 4. Drive layout and auto-save

`Brightform / Clients / <Client> / Contracts`, `/ Onboarding`, `/ Forecasts`, `/ Briefs`. The dashboard needs a Google service account (or the connected Google account's OAuth with `drive.file`) and the root folder id in a setting (`contracts_drive_folder_id`). Every generated file is written there, the link stored on the step, and "saved to Drive" ticks the step automatically.

### 5. Context linked from all sources

The onboarding already carries the Targets context (calls, emails, Slack naming the lead). Add: the lead's Gmail thread list (subject, date, link) through the connected Gmail, the client Slack channel once it exists, and the tl;dv calls with the client's domain. Same privacy rule as Targets: only sources that name the client or come from an external call with their domain; no internal calls.

### 6. Order of build

1. Terms and parties form (half a day).
2. SLA template with variables, generate to `.docx`, store on the step, download (1 day).
3. Drive save with folder per client and the contracts folder setting (half a day, needs the Google credential).
4. MoR clauses block, company form and SKU list generation (1 day).
5. P&L forecast export in the Drive layout (half a day, reuses the P&L engine).
6. Creator brief draft and DocuSign (1 day, needs the DocuSign key).

## Privacy rule for tl;dv (applies now)

Targets and Onboarding read only evidence that names the lead or its domain. tl;dv calls whose title reads as internal (founders, team, 1:1, catch-up, weekly, standup, all-hands, interview, AI training) are skipped unless the lead is in the title, and calls without the lead's name in the first part of the transcript are skipped too. Nothing from internal founder or team discussions is written into a target, an onboarding or a report.
