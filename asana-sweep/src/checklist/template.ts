/**
 * The master AM daily checklist, as it ran on the Asana boards (GreatVita pilot, September 2026),
 * now native to the platform. One entry per section: the AM's daily check with its guidance, and the
 * AA action items underneath. Weekly lines carry the weekday they are due (1 = Monday … 5 = Friday).
 */
export interface TemplateSub { name: string; frequency?: 'daily' | 'weekly'; weekday?: number; role?: 'am' | 'aa' }
export interface TemplateItem { section: string; name: string; role: 'am' | 'aa'; frequency: 'daily' | 'weekly'; weekday?: number; guidance: string | null; subtasks: TemplateSub[] }

export const CHECKLIST_TEMPLATE: TemplateItem[] = [
  {
    section: 'Homepage', name: 'Homepage - AM daily checks', role: 'am', frequency: 'daily',
    guidance: 'Key metrics vs yesterday: GMV, orders, visitors. Investigate any big swing, do not just note it. To-do list tiles with region breakdown: orders to ship (total and urgent per country), pending returns, unread customer messages, low stock / out of stock, negative reviews. Account health status banner (Healthy / warnings).',
    subtasks: [],
  },
  {
    section: 'Orders', name: 'Orders - AM daily checks', role: 'am', frequency: 'daily',
    guidance: 'Urgent / overdue shipments per market, orders stuck in processing. Orders approaching the auto-cancellation deadline.',
    subtasks: [],
  },
  {
    section: 'Growth', name: 'Growth - AM daily checks', role: 'am', frequency: 'daily',
    guidance: 'New missions / incentives available per market worth activating.',
    subtasks: [],
  },
  {
    section: 'LIVE & video Analytics', name: 'LIVE & video - AM daily checks', role: 'am', frequency: 'daily',
    guidance: 'Scheduled lives happening as planned. Flagged or removed videos.',
    subtasks: [],
  },
  {
    section: 'Affiliate', name: 'Affiliate - AM daily checks', role: 'aa', frequency: 'daily',
    guidance: 'Number of affiliate videos posted per market in line with target or increasing. Active affiliate collaborations vs target, trending up not flat. Sample rate (samples approved to videos posted) in line with target or improving; flag if samples go out but videos are not landing. Open collaboration plan live, commission rates correct per market. Target collaboration: pending invites, expired plans. Creator GMV trend, top videos, drop-offs (Affiliate orders + Analytics).',
    subtasks: [
      { name: 'Process daily sample requests within SLA' },
      { name: 'All affiliate chats answered, outstanding queries flagged to the team' },
    ],
  },
  {
    section: 'Affiliate', name: 'Affiliate - AM weekly checks', role: 'aa', frequency: 'weekly', weekday: 1,
    guidance: null,
    subtasks: [
      { name: 'Identify top-performing affiliates so AM can build targeted plans and scale partnerships', frequency: 'weekly', weekday: 1 },
      { name: 'Monitor top-performing products and surface opportunities for AM (affiliate activity, promotions, ads)', frequency: 'weekly', weekday: 1 },
    ],
  },
  {
    section: 'CS / Returns / Aftercare', name: 'CS, Returns & Aftercare - AM daily checks', role: 'am', frequency: 'daily',
    guidance: 'VAs execute CS / affiliate replies; the AA verifies completion via the action items and flags gaps. CS metrics: response rate, satisfaction score, resolution rate in line with target or improving. No conversation unanswered over 24h, no return / refund approaching a TikTok SLA breach. Negative review count and recurring complaint themes.',
    subtasks: [
      { name: 'All CS messages answered within 24 hours' },
      { name: 'All negative reviews answered' },
      { name: 'All return requests answered and processed within TikTok SLA windows' },
      { name: 'All open refund disputes reviewed and evidence submitted' },
      { name: 'All replacement requests handled and tracked in the respective spreadsheet' },
      { name: 'Positive feedback requested in the post-chat survey' },
      { name: "'Not received' claims: tracking checked, delivery proof added to any rejection" },
      { name: 'Recurring CS themes tracked and surfaced for improvements' },
      { name: 'Changed-mind returns declined or returned correctly (item must be unopened to be eligible)' },
    ],
  },
  {
    section: 'Products', name: 'Products - AM daily checks', role: 'am', frequency: 'daily',
    guidance: 'Listings deactivated, suspended or failed audit overnight. Out of stock / low stock SKUs per market. Draft or pending-review listings that should be live.',
    subtasks: [
      { name: 'Monitor for frozen products and update AM to action' },
      { name: 'Flag low stock and out of stock SKUs to AM and client' },
      { name: 'Review PDPs: SEO-compliant, up to date, optimised titles, descriptions, imagery and key product info', frequency: 'weekly', weekday: 3 },
    ],
  },
  {
    section: 'Finance', name: 'Finance - AM daily checks', role: 'am', frequency: 'daily',
    guidance: 'Settlement / payout status, holds or frozen funds, unexpected deductions.',
    subtasks: [{ name: 'Check Finance section, flag anomalies to AM' }],
  },
  {
    section: 'Cruva', name: 'Cruva - AM daily checks', role: 'am', frequency: 'daily',
    guidance: 'Sample funnel per country: outreach to request to approval to delivery to video, each stage in line with target or improving. Shop performance score movement. Outreach reply rate and daily send volume vs target.',
    subtasks: [
      { name: 'Monitor Cruva outreach campaigns and CRM: flag completions to AM, set up new ones' },
      { name: 'Target collab flows set up and running per market' },
      { name: 'Retarget / CRM sequences set up and firing (sampled-but-not-posted, posted-once, gone-quiet creators)' },
      { name: 'Refresh the main outreach message around the campaign calendar' },
      { name: 'Lark group invites CRM set up for top and mid tier performers' },
    ],
  },
  {
    section: 'Logistics', name: 'Logistics - AM daily checks', role: 'am', frequency: 'daily',
    guidance: 'Shipping performance issues, delayed pickups, failed deliveries per market.',
    subtasks: [
      { name: 'Escalate stuck orders to AM with order IDs' },
      { name: 'Chase warehouse / 3PL / FBT on overdue shipments' },
      { name: 'Chase carrier / warehouse issues, log recurring delivery problems per market', frequency: 'weekly', weekday: 4 },
    ],
  },
  {
    section: 'Analytics', name: 'Analytics / Reports - AM daily checks', role: 'am', frequency: 'daily',
    guidance: 'GMV, orders, customers, items sold vs yesterday and vs target. GMV rankings: category rank vs competitors, movement up or down. GMV breakdown by content type (LIVE / video / shop page): spot which channel dropped. Content analytics: top videos, video GMV trend. Product analytics: top SKU performance, traffic and conversion changes. Marketing analytics: paid contribution to GMV.',
    subtasks: [
      { name: 'Prepare the weekly report and review performance with AM', frequency: 'weekly', weekday: 1 },
      { name: 'Send the overall account performance update to AM', frequency: 'weekly', weekday: 5 },
    ],
  },
  {
    section: 'Marketing', name: 'Marketing - AM daily checks', role: 'am', frequency: 'daily',
    guidance: 'Shop ads: spend pacing, ROAS / GMV Max performance, rejected creatives. Promotions: active promos correct (price, dates, markets), expiring promos needing renewal. Campaigns: platform campaign registrations open or live per market.',
    subtasks: [
      { name: 'Monitor account ROI, highlight campaigns or products significantly below target' },
      { name: 'Manage campaigns and promotions: client pricing aligned and AM approval before submission' },
      { name: 'Customers / Smart Promotion review', frequency: 'weekly', weekday: 2 },
    ],
  },
  {
    section: 'Account health', name: 'Account health - AM daily checks', role: 'am', frequency: 'daily',
    guidance: 'Shop health rating: violations, points, new tickets to appeal. Creator health rating. Shop Performance Score: movement, which dimension slipped (logistics, CS, product quality). Security Centre: alerts, unauthorised access flags.',
    subtasks: [
      { name: 'Check Shop Score and account health' },
      { name: 'Prepare appeal evidence for new violation tickets, submit with AM approval' },
    ],
  },
];
