import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { openTestDb } from '../src/db/index';
import { Queries } from '../src/db/queries';
import type { Pitch, PitchResearch } from '../src/sweep/types';
import { applyDeckJson, DEFAULT_BRIEF, normaliseBrief } from '../src/pitch/deck';
import { brightformDeck } from '../src/pitch/slides';
import { pitchDir, renderDeck } from '../src/pitch/brightform';
import { PitchJob } from '../src/pitch/job';
import { buildRawMessage } from '../src/bd/gmail';

const research = (): PitchResearch => ({
  fetched_at: '2026-10-09T10:00:00.000Z', errors: [],
  site: { title: 'Kijimea', description: 'Probiotics made in Germany', theme_colour: '#0b5fff', images: [], platform: 'shopify', colours: ['#0b5fff', '#e4322b'], logo: 'https://kijimea.de/logo.png', currency: 'EUR', product_count: 12 },
  products: [{ name: 'Gut Balance', price: 29.9, image: 'https://cdn.shopify.com/gut.jpg', url: 'https://kijimea.de/products/gut', rank: 1, images: ['https://cdn.shopify.com/gut.jpg'], currency: 'EUR' }, { name: 'Daily Fibre', price: 19.9, image: null, url: 'https://kijimea.de/products/fibre', rank: 2, images: [], currency: 'EUR' }],
  assets: { 'https://cdn.shopify.com/gut.jpg': 'abc123abc123abc1.jpg' },
  context: [],
  tiktok: { brand: { name: 'Kijimea', gmv: 16196, creators: 646, videos: 305, region: 'DE' }, shops: [{ shop_name: 'Kijimea Official', region: 'DE', gmv_7d: 4000, total_gmv: 90000, seller_id: '1' }], top_products: [{ name: 'Probiotic 30', region: 'DE', gmv: 50000, units: 2000, shop: 'Other Shop' }], brand_products: [{ name: 'Gut Balance 90', region: 'DE', gmv_28d: 12000, units_28d: 400, price: 29.9, image: null }], market: [{ market: 'DE', prospects: 120, surging: 9, leaders: ['A', 'B'] }] },
  creators: [{ handle: 'gutgirl', name: 'Gut Girl', followers: 120000, gmv_30d: 9000, engagement: 2.1, categories: 'Health', video_url: null, source: 'cruva' }],
  amazon: { reachable: false, items: [] }, resellers: [{ name: 'Reseller GmbH', region: 'DE', gmv_7d: 500, note: 'sells the brand' }],
});

describe('the Brightform deck', () => {
  let q: Queries;
  beforeAll(() => { q = new Queries(openTestDb()); });

  it('lays out the general deck plus the client slides, derives the brand layer and fills the client slides from the research', () => {
    const brief = normaliseBrief({ ...DEFAULT_BRIEF, client: 'Kijimea', website: 'kijimea.de', markets: ['DE'], category: 'Probiotics', colours: { primary: '#0b5fff', secondary: '#e4322b', accent: '#1e8f4e' } });
    const deck = brightformDeck(q, brief, research());
    const kinds = deck.slides.map((s) => s.kind);
    expect(kinds.slice(0, 5)).toEqual(['cover', 'why_us', 'portfolio', 'clients', 'awards']);
    for (const k of ['presence', 'products', 'market', 'opportunity', 'divider', 'case_study', 'outreach', 'framework', 'cruva', 'creators', 'profitability', 'shoppable', 'livestream', 'studio', 'forecast', 'pricing', 'deliverables', 'team', 'next', 'closing']) expect(kinds).toContain(k);
    expect(kinds).not.toContain('mor'); // only for MoR pricing
    const cover = deck.slides[0];
    expect(cover.subtitle).toBe('Prepared for Kijimea');
    expect(cover.stats.map((s) => s.label)).toEqual(['Prepared for', 'Markets', 'Scope', 'Date']);
    expect(cover.images).toEqual(['https://kijimea.de/logo.png']);
    const products = deck.slides.find((s) => s.kind === 'products')!;
    expect(products.stats.map((s) => [s.label, s.value, s.note])).toEqual([['Gut Balance', '€29.90', '#1 best seller'], ['Daily Fibre', '€19.90', '#2 best seller']]);
    expect(products.images).toEqual(['https://cdn.shopify.com/gut.jpg', '']);
    const presence = deck.slides.find((s) => s.kind === 'presence')!;
    expect(presence.stats[0].value).toBe('USD 16,196');
    expect(presence.bullets.some((b) => b.startsWith('Gut Balance 90'))).toBe(true);
    expect(deck.theme?.neutral).toBe(false);
    expect(deck.theme?.contrast_accent).toBeGreaterThanOrEqual(7);
    expect(deck.slides.filter((s) => s.kind === 'case_study')).toHaveLength(2); // the two standing case studies; own accounts need GMV on record
    expect(deck.slides.find((s) => s.kind === 'framework')?.panels?.map((p) => p.heading)).toEqual(['Creator activation', 'Content engine', 'Live commerce']);
    // MoR pricing adds the MoR slide.
    const mor = brightformDeck(q, { ...brief, pricing: { ...brief.pricing, commission_basis: 'mor' } }, research());
    expect(mor.slides.some((s) => s.kind === 'mor')).toBe(true);
  });

  it('renders every slide in the design system, numbered, with the brand layer and the pitch images', () => {
    const brief = normaliseBrief({ ...DEFAULT_BRIEF, client: 'Kijimea', website: 'kijimea.de', markets: ['DE'], category: 'Probiotics', colours: { primary: '#0b5fff', secondary: '#e4322b', accent: '#1e8f4e' } });
    const deck = brightformDeck(q, brief, research());
    const pitch: Pitch = { id: 7, lead_id: null, lead_name: null, prospect_id: null, prospect_name: null, name: 'Kijimea x Brightform', client: 'Kijimea', brief, research: research(), deck, status: 'ready', created_by: null, created_at: '2026-10-09T10:00:00.000Z', updated_at: '2026-10-09T10:00:00.000Z' };
    const html = renderDeck(pitch);
    expect((html.match(/<section class="bf-slide"/g) ?? []).length).toBe(deck.slides.length);
    expect(html).not.toMatch(/undefined|\[object Object\]|NaN/);
    expect(html).toContain(`--bf-accent-ink:${deck.theme!.accent_ink}`);
    expect(html).toContain('/brightform/wordmark.png');
    expect(html).toContain('/api/pitch/7/img/abc123abc123abc1.jpg'); // the downloaded product image, served by the platform
    expect(html).toContain('<div class="bf-page">01</div>');
    expect(html).toContain('DISCLAIMER: THE INFORMATION CONTAINED');
    expect(html).toContain('Why wait?');
    expect(html).toContain('Reseller GmbH');
    // Inline: the design system's assets become data URIs, so the file stands alone.
    const inline = renderDeck(pitch, { inline: true });
    expect(inline).not.toContain('/brightform/wordmark.png');
    expect(inline).toContain('data:image/png;base64,');
    expect(inline).not.toContain('/api/pitch/7/img/'); // the missing file falls back to the source url
    expect(inline).toContain('https://cdn.shopify.com/gut.jpg');
    expect(renderDeck({ ...pitch, deck: null })).toContain('Build the deck first');
  });

  it('takes Claude\'s copy for titles, bullets and panel lines and keeps everything it did not change', () => {
    const brief = normaliseBrief({ ...DEFAULT_BRIEF, client: 'Kijimea' });
    const deck = brightformDeck(q, brief, null);
    const out = applyDeckJson(JSON.stringify({ slides: [{ key: 'framework', panels: [{ heading: 'Creator activation', items: ['Gut-health creators first'] }] }, { key: 'opportunity', title: 'Why now', bullets: ['One'] }] }), deck);
    expect(out.generator).toBe('claude');
    expect(out.slides.find((s) => s.key === 'framework')?.panels?.[0].items).toEqual(['Gut-health creators first']);
    expect(out.slides.find((s) => s.key === 'framework')?.panels?.[1].heading).toBe('Content engine');
    expect(out.slides.find((s) => s.key === 'opportunity')?.title).toBe('Why now');
    expect(out.slides.find((s) => s.key === 'pricing')?.title).toBe('Commercials');
  });

  it('runs research, deck and PDF as one job and leaves the PDF next to the images', async () => {
    process.env.PITCH_DIR = mkdtempSync(join(tmpdir(), 'bf-pitch-'));
    const brief = normaliseBrief({ ...DEFAULT_BRIEF, client: 'Kijimea', website: 'kijimea.de', markets: ['DE'] });
    const pitch = q.createPitch({ name: 'Kijimea x Brightform', client: 'Kijimea', brief });
    const steps: string[] = [];
    const job = new PitchJob(q, {
      research: async (_q, b, _lead, deps) => { steps.push(`research:${deps?.assetDir ? 'dir' : 'nodir'}`); return { ...research(), site: { ...research().site!, colours: ['#0b5fff', '#e4322b'] }, products: b.products.length ? [] : research().products }; },
      build: async (qq, b, r) => { steps.push('build'); return brightformDeck(qq, b, r); },
      pdf: async (html) => { steps.push('pdf'); expect(html).toContain('bf-slide'); return Buffer.from('%PDF-1.4 fake'); },
    });
    job.start(pitch.id);
    expect(job.state(pitch.id)?.running).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 100 && job.state(pitch.id)?.running; i += 1) await new Promise((r) => setTimeout(r, 20));
    const st = job.state(pitch.id)!;
    expect(st).toMatchObject({ running: false, step: null, error: null });
    expect(steps).toEqual(['research:dir', 'build', 'pdf']);
    const after = q.getPitch(pitch.id)!;
    expect(after.brief.colours.primary).toBe('#0b5fff'); // the site's colours became the brand colours
    expect(after.brief.colours.secondary).toBe('#e4322b');
    expect(after.deck?.slides.length).toBeGreaterThan(20);
    expect(after.status).toBe('ready');
    expect(existsSync(join(pitchDir(pitch.id), 'deck.pdf'))).toBe(true);
    expect(job.pdfPath(after)).toBe(join(pitchDir(pitch.id), 'deck.pdf'));
    // A failing step is reported and the job ends.
    const bad = new PitchJob(q, { research: async () => { throw new Error('site down'); } });
    bad.start(pitch.id);
    for (let i = 0; i < 100 && bad.state(pitch.id)?.running; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(bad.state(pitch.id)?.error).toBe('site down');
  });
});

describe('a Gmail message with an attachment', () => {
  it('wraps the text in multipart/mixed with the file as a base64 part', () => {
    const raw = buildRawMessage({ to: 'anna@brand.de', toName: 'Anna', subject: 'The deck', body: 'Hi Anna,\nattached.', html: '<p>Hi Anna,<br>attached.</p>', attachments: [{ filename: 'Kijimea_x_Brightform.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 fake') }] });
    const mime = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    expect(mime).toMatch(/^To: Anna <anna@brand.de>\r\n/);
    expect(mime).toContain('Content-Type: multipart/mixed; boundary="bfm_');
    expect(mime).toContain('Content-Type: multipart/alternative; boundary="bf_');
    expect(mime).toContain('Content-Disposition: attachment; filename="Kijimea_x_Brightform.pdf"');
    expect(mime).toContain(Buffer.from('%PDF-1.4 fake').toString('base64'));
    const plain = buildRawMessage({ to: 'a@b.c', subject: 's', body: 'b' });
    expect(Buffer.from(plain.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()).not.toContain('multipart');
    expect(readFileSync).toBeTypeOf('function');
  });
});
