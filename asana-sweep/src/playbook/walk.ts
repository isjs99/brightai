import type { PlaybookKind } from '../sweep/types.js';

/**
 * The walk: the library items in the order a creator meets them, so a rollout is reviewed step by step
 * (brief, finding creators, first contact, the lifecycle bots, the pushes, the newsletter, flows, hygiene).
 * Groups come first because the bots run on them. Anything not listed falls to the end in library order.
 */
export interface WalkStep { key: string; title: string; why: string }

export const WALK_STEPS: WalkStep[] = [
  { key: 'group:sample_sent', title: 'Group: sample sent', why: 'The segment the Shipped bot runs on. Nothing to write, just create it.' },
  { key: 'group:content_pending', title: 'Group: delivered, content pending', why: 'Feeds the Delivered bot.' },
  { key: 'group:first_sale', title: 'Group: first sale', why: 'Feeds the First sale bot.' },
  { key: 'group:content_not_posted', title: 'Group: content not posted in 7 days', why: 'Feeds the Unfulfilled bot.' },
  { key: 'group:no_post_10d', title: 'Group: no post in 10 days', why: 'Feeds the Gone quiet bot.' },
  { key: 'group:rejected', title: 'Group: rejected', why: 'Feeds the Rejected bot.' },
  { key: 'group:posted_no_gmv', title: 'Group: posted, no sales', why: 'Creators who posted but sold nothing: the nudge with the format that sells.' },
  { key: 'group:top_creators', title: 'Group: top creators', why: 'The creators who carry the shop; the thank-you and push-more messages go here.' },
  { key: 'group:inactive_creators', title: 'Group: inactive creators', why: 'Retarget with a bonus.' },
  { key: 'group:existing_creators', title: 'Group: existing creators', why: 'Everyone who ever worked with the shop; the newsletter and deals info go here.' },
  { key: 'brief:creator_brief', title: 'Creator brief', why: 'The one link every message points to: products, content ideas, dos and don\'ts.' },
  { key: 'list:ai_search_list', title: 'AI search list: creators to invite', why: 'Finds new creators in the shop\'s category and saves them for the collab push.' },
  { key: 'automation:first_outreach', title: 'First outreach', why: 'The first message a new creator gets. Creators who get a sample offer in the first DM post 1.4× more often (Cruva).' },
  { key: 'automation:top_creators_collab', title: 'Target collab: top creators', why: 'Invite plus DM to the saved list with the products and commission.' },
  { key: 'automation:sample_sent', title: 'Bot: sample shipped', why: 'Tells the creator the parcel is on its way and what to film.' },
  { key: 'automation:delivered', title: 'Bot: sample delivered', why: 'The nudge that turns a delivered sample into a video.' },
  { key: 'automation:first_sale', title: 'Bot: first sale', why: 'Congratulates and asks for the next video while it is working.' },
  { key: 'automation:content_not_posted', title: 'Bot: content not posted in 7 days', why: 'Chases a sample that went quiet.' },
  { key: 'automation:no_post_10d', title: 'Bot: no post in 10 days', why: 'Brings a creator back with the current offer.' },
  { key: 'automation:rejected', title: 'Bot: rejected', why: 'A polite door-left-open for creators we turned down.' },
  { key: 'automation:monthly_deals_outreach', title: 'Monthly deals push', why: 'Every month, the deals and the products to push.' },
  { key: 'automation:new_product_outreach', title: 'New product push', why: 'When a new SKU lands.' },
  { key: 'sender:sender_email', title: 'Sender email', why: 'Needed before any email campaign can go out.' },
  { key: 'email_campaign:creator_newsletter', title: 'Creator newsletter', why: 'Monthly email to existing creators.' },
  { key: 'workflow:sample_chase', title: 'Flow: sample request nudge', why: 'Cruva template: DM, wait, nudge again.' },
  { key: 'workflow:welcome_new', title: 'Flow: welcome new creators', why: 'Cruva template: DM every new creator, follow up the quiet ones.' },
  { key: 'automation:ai_auto_replies', title: 'AI auto replies', why: 'Switched on in the Cruva UI; checked here.' },
  { key: 'manual:auto_review', title: 'Auto review rules', why: 'Sample requests approved by rule.' },
  { key: 'manual:blacklist', title: 'Blacklist', why: 'Who never gets a message.' },
  { key: 'tag:do_not_contact', title: 'Tag: do not contact', why: 'The tag the replies honour.' },
  { key: 'tag:vip', title: 'Tag: VIP', why: 'The top creators, so the team spots them.' },
];

const INDEX = new Map(WALK_STEPS.map((s, i) => [s.key, i]));
export const walkIndexOf = (kind: PlaybookKind, key: string): number => INDEX.get(`${kind}:${key}`) ?? 1000;
export const walkStepOf = (kind: PlaybookKind, key: string): WalkStep | null => WALK_STEPS[INDEX.get(`${kind}:${key}`) ?? -1] ?? null;

const LANG_NAME: Record<string, string> = { en: 'English', de: 'German', fr: 'French', it: 'Italian', es: 'Spanish', nl: 'Dutch', pl: 'Polish', pt: 'Portuguese', sv: 'Swedish' };
export const languageName = (code: string): string => LANG_NAME[code] ?? code;

/** The prompt that turns an edited English version back into the shop's language, placeholders intact. */
export function fromEnglishPrompt(language: string, english: string, brand: string): { system: string; user: string } {
  return {
    system: `You write short TikTok Shop creator messages for ${brand}, an affiliate programme run by Brightform. Translate the English message you are given into ${languageName(language)}, keeping its meaning, structure and length. Natural register for that language (du in German, tu in French, Italian and Spanish). Keep every placeholder exactly as written: [affiliate_name], [brand], [brief_link], [month], and any URL. No hashtags, no corporate filler, no sign-off block beyond what is in the English. Output only the translated message.`,
    user: english,
  };
}
