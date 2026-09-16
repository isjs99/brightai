/**
 * Isaac's outreach voice. The examples are real emails he sent from isaac@brightform.agency
 * (signatures and tracking links stripped); the pitch is the intro block he pastes into
 * introductions. Both are seeded into the database on first run and editable from the
 * Outreach tab, and more examples can be pulled from Gmail once it is connected.
 */

export const SEED_SENDER_NAME = 'Isaac Sinclair';
export const SEED_SENDER_TITLE = 'Co-Founder/CEO, Brightform';
export const SEED_BOOKING_URL = 'https://calendly.com/isaacsinclair/30min';
export const SEED_SENT_QUERY = 'in:sent (TikTok Shop OR TikTok) -to:brightform.agency -subject:Re: -subject:Fwd: newer_than:1y';

export const SEED_PITCH = `*Who we are*
- Official TikTok Shop Gold Partner, one of the first agency partners in Europe (launching 4yrs ago in the UK)
- Team in Barcelona, Manchester, Munich, Paris, Milan and Amsterdam
- Operating across EU5 (ES, DE, FR, IT, UK) and Ireland with native speakers in every market

*Credentials*
- #1 TikTok Shop Partner in Germany and the EU by GMV for 6 consecutive months
- Biggest TSP Agency by GMV, Q1
- 2 of 3 FMCG ACE Awards and 1 of 3 Beauty ACE Awards, Q2 Germany
- TikTok's Best GMV Max Campaign award
- FastMoss Agency of the Year 2025
- EUR 8.19M client GMV across DE/FR/IT in six months, 42 shops under management

*What we do*
- End to end TikTok Shop management: shop setup, catalogue, content, affiliate, LIVE and GMV Max
- Affiliate and creator programmes at scale, with active sample and commission management
- Live commerce: own studio, creator training and fully managed streams
- Merchant of Record for brands without a local entity, covering logistics, invoicing and VAT
- Customer service and shop operations run inside platform SLAs`;

export interface SeedExample {
  subject: string;
  body: string;
  kind: 'cold' | 'intro' | 'reply' | 'followup';
  to_domain: string;
  sent_at: string;
}

export const SEED_EXAMPLES: SeedExample[] = [
  {
    subject: 'Sephora x TikTok Shop Europe',
    kind: 'intro',
    to_domain: 'sephora.it',
    sent_at: '2026-08-10',
    body: `Hi Jessica,

I hope you are very well, and it's a pleasure to be introduced.

I'm in Paris on 26 and 27 August and wanted to see if you had 30 minutes free while I'm there.

To give you an introduction to Brightform:

*Who we are*
- Official TikTok Shop Gold Partner, one of the first agency partners in Europe (launching 4yrs ago in the UK)
- Team in Barcelona, Manchester, Munich, Paris, Milan and Amsterdam
- Operating across EU5 (ES, DE, FR, IT, UK) and Ireland with native speakers in every market

*Credentials*
- #1 TikTok Shop Partner in Germany and the EU by GMV for 5 consecutive months
- Biggest TSP Agency by GMV, Q1
- 2 of 3 FMCG ACE Awards and 1 of 3 Beauty ACE Awards, Q2 Germany
- TikTok's Best GMV Max Campaign award
- FastMoss Agency of the Year 2025
- EUR 8.19M client GMV across DE/FR/IT in six months, 42 shops under management

*What we do*
- End to end TikTok Shop management: shop setup, catalogue, content, affiliate, LIVE and GMV Max
- Affiliate and creator programmes at scale, with active sample and commission management
- Live commerce: own studio, creator training and fully managed streams
- Merchant of Record for brands without a local entity, covering logistics, invoicing and VAT
- Customer service and shop operations run inside platform SLAs

Let me know if you'd like to hop on a quick call, or if any window on 26 or 27 August works to meet in person.

Very best,
Isaac`,
  },
  {
    subject: 'P&G x TikTok Shop Europe',
    kind: 'intro',
    to_domain: 'pg.com',
    sent_at: '2026-08-10',
    body: `Hi Jamie,

I hope you are very well, and it's a pleasure to be introduced.

To give you an introduction to Brightform:

*Credentials*
- #1 TikTok Shop Partner in Germany and the EU by GMV for 5 consecutive months
- Biggest TSP Agency by GMV, Q1
- 2 of 3 FMCG ACE Awards and 1 of 3 Beauty ACE Awards, Q2 Germany
- TikTok's Best GMV Max Campaign award
- FastMoss Agency of the Year 2025
- EUR 8.19M client GMV across DE/FR/IT in six months, 42 shops under management

*Who we are*
- Official TikTok Shop Gold Partner, one of the first agency partners in Europe (launching 4yrs ago in the UK)
- Team in Barcelona, Manchester, Munich, Paris, Milan and Amsterdam
- Operating across EU5 (ES, DE, FR, IT, UK) and Ireland with native speakers in every market

*What we do*
- End to end TikTok Shop management: shop setup, catalogue, content, affiliate, LIVE and GMV Max
- Affiliate and creator programmes at scale, with active sample and commission management
- Live commerce: own studio, creator training and fully managed streams
- Merchant of Record for brands without a local entity, covering logistics, invoicing and VAT
- Customer service and shop operations run inside platform SLAs

Let me know if you'd like to hop on a quick call to see whether there's a fit.

Very best,
Isaac`,
  },
  {
    subject: 'WPP x Brightform',
    kind: 'cold',
    to_domain: 'wpp.com',
    sent_at: '2026-08-10',
    body: `Hi Cindy,

I'd love to talk about a partnership with WPP.

*Who we are*
- Official TikTok Shop Gold Partner, one of the first agency partners in Europe (launching 4yrs ago in the UK)
- Team in Barcelona, Manchester, Munich, Paris, Milan and Amsterdam
- Operating across EU5 (ES, DE, FR, IT, UK) and Ireland with native speakers in every market

*Credentials*
- #1 TikTok Shop Partner in Germany and the EU by GMV for 5 consecutive months
- Biggest TSP Agency by GMV, Q1
- 2 of 3 FMCG ACE Awards and 1 of 3 Beauty ACE Awards, Q2 Germany
- TikTok's Best GMV Max Campaign award
- FastMoss Agency of the Year 2025
- EUR 8.19M client GMV across DE/FR/IT in six months, 42 shops under management

*What we do*
- End to end TikTok Shop management: shop setup, catalogue, content, affiliate, LIVE and GMV Max
- Affiliate and creator programmes at scale, with active sample and commission management
- Live commerce: own studio, creator training and fully managed streams
- Merchant of Record for brands without a local entity, covering logistics, invoicing and VAT
- Customer service and shop operations run inside platform SLAs

Let me know, and we could have a call.

Very best,
Isaac`,
  },
  {
    subject: 'RYZE on TikTok Shop Germany',
    kind: 'reply',
    to_domain: 'ladhouse.dk',
    sent_at: '2026-09-04',
    body: `Hi Hans-Christian,

Thanks for reaching out. Yes, this is something we solve regularly - the local residency requirement is usually the only thing standing between a foreign brand and a live shop in Germany.

Two routes we would look at:

1. Merchant of Record. Our German entity acts as the legal seller on TikTok Shop. We collect consumer payments, remit VAT to the Finanzamt and settle net back to Ladhouse. No German-resident director needed on your side, and you can be trading in weeks rather than months.

2. Your own RYZE GmbH shop, with us running it as your TSP once the local representative question is resolved. Slower to stand up, but the shop stays in your name.

Which one fits depends on how you want to handle VAT, pricing and stock, so it is worth 20 minutes on a call. Grab a slot here:

https://calendly.com/isaacsinclair/30min

Padel is a strong fit for the German creator ecosystem, so I will bring some category data to the call.

Very best,
Isaac`,
  },
  {
    subject: 'TikTok Shop Consultancy',
    kind: 'cold',
    to_domain: 'fiveseasons.vc',
    sent_at: '2026-09-12',
    body: `Hi Niccolo,

You might remember me from Nicpic (still doing well!)

I have the biggest TikTok Shop Agency by GMV produced for clients for 6 consecutive months in the EU.

Would love to see if I can help some of your portfolio capture the TikTok Shop opportunity, as a consultant - I have some similar arrangements with other VCs.

Very best,
Isaac`,
  },
  {
    subject: 'European TikTok Shop data if you ever need a source',
    kind: 'cold',
    to_domain: 'retaildive.com',
    sent_at: '2026-08-18',
    body: `Hi Daphne,

Short one, no pitch attached.

I run Brightform, a TikTok Shop Partner agency with 42 shops across Germany, France, Italy, Spain and the UK. TikTok ranks us their number one partner in Germany and the EU by GMV.

Most EU TikTok Shop figures in circulation are modelled from third party scrapers. Ours are observed, from live shops. GMV and category splits by market, affiliate share, conversion, AOV, creator commission benchmarks, refund rates.

If you're ever writing on social commerce in Europe and need real numbers or a quote on deadline, I'll turn it around same day.

Putting myself on your list, that's all.

Very best,
Isaac`,
  },
];
