import type { Queries } from '../db/queries.js';
import type { Lead, Onboarding, OnboardingStep, OnboardingTerms, OnboardingsData } from '../sweep/types.js';
import { gatherTargetContext } from './targets.js';
import { liveEvents } from '../live/events.js';

/**
 * Onboarding > Onboarding steps: the checklist an AM ticks to take a signed lead to a live account, built
 * from how Brightform has onboarded clients so far (SLA or MoR agreement on DocuSign, the company and
 * product onboarding forms, TikTok Shop account and TSP binding, compliance numbers, the P&L forecast,
 * the launch, the handover into this dashboard). Everything must be ticked; the retainer and commission
 * terms at the end become the deal on the account.
 */

export const TEMPLATES: OnboardingsData['templates'] = [
  { key: 'sla', label: 'TikTok Shop SLA (Service Level Agreement)', url: 'https://drive.google.com/drive/search?q=TikTok%20Shop%20SLA%20(Service%20Level%20Agreement)', kind: 'contract' },
  { key: 'company_form', label: 'Company onboarding form (entity, VAT, bank, compliance)', url: 'https://drive.google.com/file/d/1ENYIzGhXyoMQSgFKGKG8h4LSPrfVEkIo/view', kind: 'form' },
  { key: 'sku_form', label: 'Product onboarding SKU list (EU5 template)', url: 'https://docs.google.com/spreadsheets/d/1cXbk8pgRi6d0roGy8AhByWxcStrn481CZcsDRn-gssw/edit', kind: 'form' },
  { key: 'checklist', label: 'Client onboarding checklist (sheet)', url: 'https://drive.google.com/drive/search?q=Onboarding%20Checklist', kind: 'form' },
  { key: 'pnl', label: 'P&L forecast template', url: 'https://docs.google.com/spreadsheets/d/1_ff36lPVEOv1pBIkiPqi1MCGlx3T0-Z_YZgUhQNfCdY/edit', kind: 'forecast' },
  { key: 'brief', label: 'Creator outreach brief', url: 'https://docs.google.com/document/d/1830mtaWyP18wg85By-vWZq1jMoaRW8BUahqoG39lJk4/edit', kind: 'brief' },
];

const T = (key: string, group: string, title: string, help: string | null = null, link: string | null = null): OnboardingStep => ({ key, group, title, help, link, done_at: null, done_by: null, note: null, custom: false });

export function defaultSteps(): OnboardingStep[] {
  return [
    T('contract_terms', '1. Contract', 'Terms agreed: retainer, commission (GMV or MoR settlement), initial term and notice', 'Fill the terms at the bottom of this checklist; they become the deal on the account.'),
    T('contract_entities', '1. Contract', 'Legal names, entities, registered addresses and signatories collected', 'Client legal name and registration, Brightform entity (Social Media Limited for UK, Social Media UG for MoR / EU).'),
    T('contract_drafted', '1. Contract', 'SLA (or MoR agreement) drafted from the template with the deal terms', null, TEMPLATES[0].url),
    T('contract_sent', '1. Contract', 'Contract sent for signature on DocuSign'),
    T('contract_signed', '1. Contract', 'Signed by both sides and saved to the contracts folder in Drive'),
    T('kickoff_call', '2. Forms and access', 'Onboarding call held and summary shared with the client'),
    T('form_company', '2. Forms and access', 'Company onboarding form returned (entity, VAT or OSS, EORI, bank, legal representative, documents)', null, TEMPLATES[1].url),
    T('form_skus', '2. Forms and access', 'Product onboarding SKU list returned with images, barcodes, dimensions and prices', null, TEMPLATES[2].url),
    T('slack_channels', '2. Forms and access', 'Client Slack channel (#ext-…) and internal channel created; client domain and channel set on the account here'),
    T('logins', '2. Forms and access', 'Logins, 2FA device and Business Centre admin access agreed and stored in #logins'),
    T('tts_account', '3. Shop and tools', 'TikTok Shop seller account created or taken over (LOA or brand authorisation where a distributor sells the brand)'),
    T('tsp_binding', '3. Shop and tools', 'TSP binding links attached for every market so TikTok recognises Brightform as the partner'),
    T('cruva_shop', '3. Shop and tools', 'Cruva shop created and linked to the account (Cruva › Link shops)'),
    T('windsor', '3. Shop and tools', 'Windsor.ai connected for the shop (GMV, orders, stock)'),
    T('ads_access', '3. Shop and tools', 'TikTok Ads Manager / GMV Max access and payment method set up'),
    T('vat_numbers', '4. Compliance', 'VAT, EORI and tax numbers verified per market'),
    T('epr', '4. Compliance', 'Packaging and EPR registrations done (LUCID for Germany, Triman for France) and numbers added in Seller Center'),
    T('category', '4. Compliance', 'Category approval and product compliance documents (CE, safety, ingredients, responsible person) cleared'),
    T('returns', '4. Compliance', 'Return address, return policy and customer service contact in place'),
    T('pnl', '5. Commercial', 'P&L forecast built from the template and agreed with the client', null, TEMPLATES[4].url),
    T('pricing', '5. Commercial', 'RRP, listing prices and the standing discount strategy agreed'),
    T('commission_plan', '5. Commercial', 'Open plan commission, target collab tiers and sample policy agreed'),
    T('products_live', '6. Launch', 'Products uploaded, PDPs reviewed and live'),
    T('logistics', '6. Launch', 'Logistics set: FBT inbound booked or 3PL confirmed, first test order placed'),
    T('brief', '6. Launch', 'Creator brief drafted and outreach automations switched on in Cruva', null, TEMPLATES[5].url),
    T('ads_live', '6. Launch', 'First GMV Max campaigns live'),
    T('account_setup', '7. Handover', 'Account created in this dashboard with AM, AA, markets and the daily checklist'),
    T('report_schedule', '7. Handover', 'Weekly client report scheduled (Accounts › Reports)'),
    T('terms', '8. Terms', 'Retainer and commission terms entered below and applied to the account'),
  ];
}

export const DEFAULT_TERMS: OnboardingTerms = { retainer: null, currency: 'EUR', commission_pct: null, commission_basis: 'gmv', settlement_pct: 100, term_months: 3, notice_months: 1, start_date: null, markets: '', billing_entity: 'Brightform Social Media Limited', notes: '' };

export class Onboardings {
  constructor(private q: Queries) {}

  data(): OnboardingsData {
    return { onboardings: this.q.listOnboardings(), people: this.q.listPeople(), accounts: this.q.listAccounts().map((a) => ({ id: a.id, name: a.name })), templates: TEMPLATES };
  }

  /** Start onboarding for a lead (from Targets "Ready to sign") or by hand. */
  start(input: { lead?: Lead | null; account_id?: number | null; name?: string | null; am_person_id?: number | null; actor?: string | null }): Onboarding {
    const lead = input.lead ?? null;
    if (lead) { const existing = this.q.onboardingForLead(lead.id); if (existing) return existing; }
    const name = (input.name ?? lead?.name ?? (input.account_id ? this.q.getAccount(input.account_id)?.name : null) ?? '').trim();
    if (!name) throw new Error('Give the onboarding a name.');
    const ctx = lead ? gatherTargetContext(this.q, lead) : { sources: [], prospect: null };
    const state = lead ? this.q.getTargetState(lead.id) : null;
    const terms: Partial<OnboardingTerms> = { ...DEFAULT_TERMS, markets: lead?.country ?? '', billing_entity: DEFAULT_TERMS.billing_entity };
    const o = this.q.createOnboarding({
      lead_id: lead?.id ?? null, account_id: input.account_id ?? null, name, markets: lead?.country ?? null, am_person_id: input.am_person_id ?? state?.am_person_id ?? lead?.onboarding_id ?? null, steps: defaultSteps(), terms,
      context: { summary: state?.analysis?.summary ?? null, sources: ctx.sources, poc: lead?.poc ?? null, country: lead?.country ?? null, est_value: lead?.est_value ?? null, analysed_at: state?.analysis?.analysed_at ?? null }, created_by: input.actor ?? null,
    });
    liveEvents.emitUpdate({ kind: 'leads' });
    return o;
  }

  tick(id: number, key: string, done: boolean, actor: string | null, note?: string | null): Onboarding {
    const o = this.q.getOnboarding(id);
    if (!o) throw new Error('Onboarding not found');
    const steps = o.steps.map((s) => (s.key === key ? { ...s, done_at: done ? new Date().toISOString() : null, done_by: done ? actor : null, note: note === undefined ? s.note : note } : s));
    if (!steps.some((s) => s.key === key)) throw new Error('Step not found');
    const out = this.q.updateOnboarding(id, { steps })!;
    liveEvents.emitUpdate({ kind: 'leads' });
    return out;
  }

  addStep(id: number, group: string, title: string, help: string | null): Onboarding {
    const o = this.q.getOnboarding(id);
    if (!o) throw new Error('Onboarding not found');
    const key = `custom_${Date.now().toString(36)}`;
    const steps = [...o.steps];
    const idx = steps.map((s) => s.group).lastIndexOf(group);
    const step: OnboardingStep = { key, group, title, help, link: null, done_at: null, done_by: null, note: null, custom: true };
    if (idx >= 0) steps.splice(idx + 1, 0, step); else steps.splice(Math.max(0, steps.length - 1), 0, step);
    return this.q.updateOnboarding(id, { steps })!;
  }

  removeStep(id: number, key: string): Onboarding {
    const o = this.q.getOnboarding(id);
    if (!o) throw new Error('Onboarding not found');
    const step = o.steps.find((s) => s.key === key);
    if (!step?.custom) throw new Error('Only custom steps can be removed.');
    return this.q.updateOnboarding(id, { steps: o.steps.filter((s) => s.key !== key) })!;
  }

  setTerms(id: number, terms: Partial<OnboardingTerms>): Onboarding {
    const o = this.q.getOnboarding(id);
    if (!o) throw new Error('Onboarding not found');
    const out = this.q.updateOnboarding(id, { terms: { ...o.terms, ...terms } })!;
    this.applyTerms(out);
    return out;
  }

  /** The deal on the linked account follows the terms (commission %, basis, settlement estimate). */
  private applyTerms(o: Onboarding): void {
    if (!o.account_id) return;
    const a = this.q.getAccount(o.account_id);
    if (!a) return;
    this.q.setAccountDeal(a.id, { commission_pct: o.terms.commission_pct, commission_basis: o.terms.commission_basis, settlement_pct: o.terms.commission_basis === 'mor' ? o.terms.settlement_pct : 100 });
    if (o.terms.retainer !== null) this.q.savePnlInputs(a.id, new Date().toISOString().slice(0, 7), { ...(this.q.latestPnlInputs(a.id, '9999-12') ?? {}), agency_fee: o.terms.retainer, agency_commission_pct: o.terms.commission_pct ?? 0 });
  }

  /** Every step ticked: create the account (or link it), apply the terms, mark done. */
  complete(id: number, actor: string | null): Onboarding {
    const o = this.q.getOnboarding(id);
    if (!o) throw new Error('Onboarding not found');
    const open = o.steps.filter((s) => !s.done_at);
    if (open.length) throw new Error(`${open.length} step(s) still open: ${open.slice(0, 3).map((s) => s.title).join('; ')}${open.length > 3 ? '…' : ''}`);
    let accountId = o.account_id;
    const am = o.am_person_id ? this.q.getPerson(o.am_person_id) : null;
    if (!accountId) {
      const existing = this.q.listAccounts().find((a) => a.name.toLowerCase() === o.name.toLowerCase());
      if (existing) accountId = existing.id;
      else {
        const a = this.q.createAccount({ name: o.name, markets: o.terms.markets || o.markets || null, am_name: am?.name ?? null, aa_name: null, enabled: true, notes: `Onboarded ${new Date().toISOString().slice(0, 10)}${o.lead_name ? ` from lead ${o.lead_name}` : ''}`, commission_pct: o.terms.commission_pct, commission_basis: o.terms.commission_basis, settlement_pct: o.terms.commission_basis === 'mor' ? o.terms.settlement_pct : 100, slack_channel: null, client_slack_channel: null, client_domain: null });
        accountId = a.id;
      }
    }
    const out = this.q.updateOnboarding(id, { status: 'done', completed_at: new Date().toISOString(), account_id: accountId })!;
    this.applyTerms(out);
    if (o.lead_id) { this.q.saveTargetState(o.lead_id, { status: 'ready' }); }
    liveEvents.emitUpdate({ kind: 'leads' });
    void actor;
    return this.q.getOnboarding(id)!;
  }
}
