import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pitch, PitchSlide, PitchStat, PitchTheme } from '../sweep/types.js';
import { config } from '../config.js';
import { BRIGHTFORM } from './slides.js';
import { BRIGHTFORM_LAYER } from './theme.js';

/**
 * The deck renderer: every slide kind laid out as the Brightform Design System draws it (1280 x 720,
 * black ground, white extended uppercase display type, outlined section numerals, flat colour panels
 * carrying the client's brand layer, neutral metric cards, hairlines, no shadows, no icons). The static
 * assets (wordmark, TSP badges, client marks, photography, phone screens) ship with the dashboard under
 * /brightform; product images come from the pitch's own folder. With `inline` every image becomes a data
 * URI, so the HTML stands alone and the PDF renders without the server.
 */

const here = dirname(fileURLToPath(import.meta.url));
/** Where the pitch's downloaded images live: next to the database, one folder per pitch. */
export const pitchDir = (id: number): string => join(process.env.PITCH_DIR?.trim() || join(dirname(config.databasePath), 'pitch'), String(id));
/** The design system's assets as shipped with the client (dev: src/web/client/public; prod: dist/client). */
export const brightformAssetDir = (): string | null => [join(here, '../web/client/public/brightform'), join(here, '../../client/brightform'), join(process.cwd(), 'src/web/client/public/brightform'), join(process.cwd(), 'dist/client/brightform')].find((d) => existsSync(join(d, 'wordmark.png'))) ?? null;

const esc = (s: string | null | undefined) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', woff2: 'font/woff2' };
const dataUri = (path: string): string | null => { if (!existsSync(path)) return null; const ext = path.split('.').pop()?.toLowerCase() ?? 'png'; return `data:${MIME[ext] ?? 'application/octet-stream'};base64,${readFileSync(path).toString('base64')}`; };

export const CONFIDENTIALITY = '*DISCLAIMER: THE INFORMATION CONTAINED IN THIS PRESENTATION IS CONFIDENTIAL AND PROPRIETARY TO BRIGHTFORM SOCIAL MEDIA LIMITED (“BRIGHTFORM”). THIS PRESENTATION HAS BEEN PREPARED FOR INFORMATION PURPOSES ONLY WITH THE EXPRESS UNDERSTANDING THAT IT IS TO BE READ SOLELY BY THE PERSON TO WHOM IT IS ADDRESSED AND HIS/HER PROFESSIONAL ADVISORS. WITHOUT THE PRIOR WRITTEN CONSENT OF BRIGHTFORM, NO PERSON ACCEPTING THIS PRESENTATION WILL RELEASE OR REPRODUCE (IN WHOLE OR IN PART) THIS PRESENTATION, DISCUSS ANY INFORMATION CONTAINED THEREIN, MAKE REPRESENTATIONS OR USE SUCH INFORMATION FOR ANY PURPOSE OTHER THAN TO EVALUATE A POTENTIAL INVOLVEMENT IN THE TRANSACTION PROPOSED BY BRIGHTFORM.';

export const CSS = `
*{box-sizing:border-box}html,body{margin:0;background:#111}
.bf-deck{--bf-black:#000;--bf-white:#fff;--bf-off:#f4f4f4;--bf-card:#262624;--bf-hair:rgba(255,255,255,.14);--bf-grey:rgba(244,244,244,.58);--bf-grey-2:rgba(244,244,244,.38);--bf-grey-3:rgba(244,244,244,.30);--bf-ink:#151412;--bf-display:"Archivo","Monument Extended",sans-serif;--bf-body:"Figtree","TT Commons Pro",system-ui,sans-serif;display:flex;flex-direction:column;gap:24px;padding:24px;align-items:center;font-family:var(--bf-body);color:var(--bf-off)}
.bf-slide{position:relative;width:1280px;height:720px;background:#000;color:var(--bf-off);font-family:var(--bf-body);font-size:15px;line-height:1.5;overflow:hidden;flex:none}
.bf-pad{position:absolute;inset:0;padding:40px 60px 74px;display:flex;flex-direction:column}
.bf-page{position:absolute;left:60px;bottom:30px;font-family:var(--bf-display);font-variation-settings:"wdth" 112;font-weight:800;font-size:12px;letter-spacing:.08em;color:var(--bf-grey-2)}
.bf-wordmark{position:absolute;right:60px;bottom:26px;width:108px;display:block;opacity:.92}
.bf-disc{position:absolute;left:60px;bottom:22px;width:760px;margin:0;font-size:6.7px;line-height:1.45;font-weight:600;text-transform:uppercase;letter-spacing:.02em;color:var(--bf-grey-3)}
.bf-num{font-family:var(--bf-display);font-variation-settings:"wdth" 118;font-weight:800;font-size:51px;line-height:1;letter-spacing:.02em;color:transparent;-webkit-text-stroke:1.6px #fff;display:inline-block}
.bf-num.sm{font-size:20px;-webkit-text-stroke:1px #fff}.bf-num.xl{font-size:72px;-webkit-text-stroke:2px #fff}
.bf-h{margin:0;font-family:var(--bf-display);font-variation-settings:"wdth" 122;font-weight:800;text-transform:uppercase;color:#fff;font-size:42px;line-height:1.02;letter-spacing:-.005em;max-width:30ch;text-wrap:balance}
.bf-h.cover{font-size:86px;line-height:.94;max-width:15ch}.bf-h.div{font-size:68px}.bf-h.close{font-size:96px;max-width:none;margin-top:8px}
.bf-head{display:flex;flex-direction:column;gap:12px;margin-bottom:24px}.bf-sub{margin:4px 0 0;max-width:70ch;font-size:15px;line-height:1.5;color:var(--bf-grey)}
.bf-outline{font-family:var(--bf-display);font-variation-settings:"wdth" 118;font-weight:800;text-transform:uppercase;font-size:24px;letter-spacing:.02em;color:transparent;-webkit-text-stroke:1.3px #fff;margin-top:16px}
.bf-panel{border-radius:2px;padding:22px;display:flex;flex-direction:column;min-height:0;color:var(--bf-ink)}
.bf-panel.p1{background:var(--bf-panel-1)}.bf-panel.p2{background:var(--bf-panel-2)}.bf-panel.white{background:#fff}.bf-panel.accent{background:var(--bf-accent);color:var(--bf-accent-ink)}.bf-panel.data{background:var(--bf-data);color:var(--bf-data-ink)}
.bf-panel .pn{font-family:var(--bf-display);font-variation-settings:"wdth" 118;font-weight:800;font-size:34px;line-height:1;color:transparent;-webkit-text-stroke:1.4px var(--bf-ink);opacity:.5;margin-bottom:14px}
.bf-panel h3{margin:0 0 10px;font-family:var(--bf-display);font-variation-settings:"wdth" 112;font-weight:800;text-transform:uppercase;font-size:17px;letter-spacing:.005em;color:inherit}
.bf-panel p{margin:0;font-size:13px;line-height:1.5}
.bf-arrow{margin-top:auto;padding-top:16px;font-size:12.5px;line-height:1.45;font-weight:600}
.bf-list{margin:0;padding:0;list-style:none;display:grid;gap:8px}.bf-list li{font-size:12.5px;line-height:1.42;padding-left:14px;position:relative}.bf-list li::before{content:"—";position:absolute;left:0;opacity:.5}.bf-list.dark li{color:var(--bf-off)}.bf-list.lg li{font-size:14px;line-height:1.45}
.bf-card{background:var(--bf-card);border:1px solid var(--bf-hair);border-radius:3px;padding:16px 18px 18px;display:flex;flex-direction:column;gap:4px;min-width:0}
.bf-card .c{font-size:12.5px;color:var(--bf-grey-2);line-height:1.3}.bf-card .v{font-family:var(--bf-display);font-variation-settings:"wdth" 116;font-weight:800;font-size:32px;letter-spacing:-.02em;line-height:1.05;color:#fff;overflow-wrap:anywhere}.bf-card .x{font-size:12.5px;color:var(--bf-grey);line-height:1.3}
.bf-card.chip{padding:11px 12px}.bf-card.chip .c{font-size:11px}.bf-card.chip .v{font-size:18px;margin-top:4px}
.bf-callout{justify-content:center;gap:8px}.bf-callout .l{font-size:13px;font-weight:600;line-height:1.25;opacity:.95}.bf-callout .f{font-family:var(--bf-display);font-variation-settings:"wdth" 116;font-weight:800;font-size:32px;line-height:1;letter-spacing:-.02em;overflow-wrap:anywhere}.bf-callout .n{font-size:12.5px;line-height:1.3;opacity:.78}
.bf-pill{display:inline-flex;align-items:center;border-radius:999px;padding:5px 12px 4px;font-weight:700;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;line-height:1;background:var(--bf-accent);color:var(--bf-accent-ink)}.bf-pill.held{background:var(--bf-panel-1);color:var(--bf-ink)}
.bf-chip{display:inline-flex;align-items:center;border-radius:999px;border:1px solid var(--bf-hair);padding:6px 13px 5px;font-size:12px;line-height:1.1;color:var(--bf-off);white-space:nowrap}
.bf-label{font-weight:700;font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--bf-grey-2);line-height:1.2}.bf-label.pri{color:var(--bf-off)}
.bf-meta{display:flex;flex-direction:column;gap:6px}.bf-meta.r{align-items:flex-end;text-align:right}.bf-meta .v{font-size:14px;color:var(--bf-off);line-height:1.3}
.bf-grid{display:grid;gap:18px;min-height:0}.bf-fill{flex:1;min-height:0}.bf-row{display:flex;gap:18px}
.bf-photo{width:100%;height:100%;object-fit:cover;border-radius:2px;min-height:0;display:block}
.bf-bars{display:flex;align-items:flex-end;gap:14px;height:166px;margin-top:16px;border-bottom:1px solid var(--bf-hair)}.bf-bars div{flex:1;background:var(--bf-accent-ink);border-radius:1px 1px 0 0}
.bf-months{display:flex;gap:14px;margin-top:8px}.bf-months div{flex:1;text-align:center;font-size:11.5px;color:var(--bf-grey-2)}
.bf-tile{background:#fff;border-radius:2px;padding:14px;display:flex;flex-direction:column;gap:8px;color:var(--bf-ink);min-height:0}.bf-tile .im{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden}.bf-tile img{max-width:100%;max-height:100%;object-fit:contain;display:block}.bf-tile .nm{font-size:12.5px;font-weight:700;line-height:1.3}.bf-tile .pr{font-size:12px;opacity:.7}
.bf-quote{font-size:13.5px;line-height:1.5;margin:0}.bf-qn{margin-top:14px;font-size:11.5px;font-weight:700}.bf-qr{font-size:11.5px;opacity:.62}
.bf-cred{display:flex;gap:16px;align-items:baseline;padding:14px 0;border-bottom:1px solid var(--bf-hair)}.bf-cred span{font-size:15px;line-height:1.4}
.bf-step{display:flex;flex-direction:column;gap:14px;border-top:1px solid rgba(0,0,0,.18);padding-top:16px}.bf-step .n{font-family:var(--bf-display);font-variation-settings:"wdth" 118;font-weight:800;font-size:34px;line-height:1;color:transparent;-webkit-text-stroke:1.4px var(--bf-ink);opacity:.55}.bf-step span{font-size:14px;line-height:1.4}
.bf-group{border-top:1px solid var(--bf-hair);padding-top:14px;min-height:0}.bf-group h3{margin:0 0 12px;font-family:var(--bf-display);font-variation-settings:"wdth" 112;font-weight:800;text-transform:uppercase;font-size:14px;color:#fff}
.bf-mor{background:var(--bf-card);border:1px solid var(--bf-hair);border-radius:3px;padding:14px 16px;min-height:0}.bf-mor h3{margin:0 0 10px;font-family:var(--bf-display);font-variation-settings:"wdth" 112;font-weight:800;text-transform:uppercase;font-size:12.5px;color:#fff}
.bf-notes{display:none}
@media print{html,body{background:#fff}.bf-deck{padding:0;gap:0}.bf-slide{page-break-after:always;break-after:page}@page{size:1280px 720px;margin:0}}
`;

/** The brand spec's free fallbacks, shipped with the dashboard (Archivo Variable with the width axis for Monument Extended, Figtree Variable for TT Commons Pro); inline mode embeds them so the HTML and the PDF need no network. */
const fontCss = (asset: (path: string) => string): string => `@font-face{font-family:"Archivo";font-style:normal;font-weight:100 900;font-stretch:62% 125%;font-display:swap;src:url("${asset('fonts/archivo-variable.woff2')}") format("woff2")}@font-face{font-family:"Figtree";font-style:normal;font-weight:300 900;font-display:swap;src:url("${asset('fonts/figtree-variable.woff2')}") format("woff2")}`;

const themeCss = (t: PitchTheme | undefined): string => {
  const l = t ? { panel1: t.panel1, panel2: t.panel2, accent: t.accent, accentInk: t.accent_ink, data: t.data, dataInk: t.data_ink } : BRIGHTFORM_LAYER;
  return `--bf-panel-1:${l.panel1};--bf-panel-2:${l.panel2};--bf-accent:${l.accent};--bf-accent-ink:${l.accentInk};--bf-data:${l.data};--bf-data-ink:${l.dataInk};`;
};

export interface RenderOptions { inline?: boolean; apiBase?: string }

export function renderDeck(p: Pitch, opts: RenderOptions = {}): string {
  const deck = p.deck;
  if (!deck) return '<!doctype html><title>No deck</title><p>Build the deck first.</p>';
  const inline = Boolean(opts.inline);
  const assetDir = brightformAssetDir();
  const apiBase = opts.apiBase ?? '/api';
  const assets = p.research?.assets ?? {};
  const asset = (path: string): string => { if (inline && assetDir) return dataUri(join(assetDir, path)) ?? ''; return `/brightform/${path}`; };
  const image = (url: string): string => {
    const file = assets[url];
    if (file) return inline ? dataUri(join(pitchDir(p.id), file)) ?? url : `${apiBase}/pitch/${p.id}/img/${encodeURIComponent(file)}`;
    return inline && /^\//.test(url) ? '' : url;
  };
  const wordmark = (cls = 'bf-wordmark', style = '') => `<img class="${cls}" src="${asset('wordmark.png')}" alt="Brightform" style="${style}">`;
  const slides = deck.slides.filter((s) => s.enabled);
  let page = 0;
  const head = (n: number, s: PitchSlide, sub = s.subtitle) => `<div class="bf-head"><span class="bf-num">${String(n).padStart(2, '0')}</span><h2 class="bf-h">${esc(s.title)}</h2>${sub ? `<p class="bf-sub">${esc(sub)}</p>` : ''}</div>`;
  const list = (items: string[], cls = '') => `<ul class="bf-list ${cls}">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
  const panel = (fill: string, body: string, o: { num?: number; heading?: string; style?: string } = {}) => `<div class="bf-panel ${fill}" style="${o.style ?? ''}">${o.num ? `<span class="pn">${String(o.num).padStart(2, '0')}</span>` : ''}${o.heading ? `<h3>${esc(o.heading)}</h3>` : ''}${body}</div>`;
  const card = (st: PitchStat, cls = '') => `<div class="bf-card ${cls}">${st.label ? `<div class="c">${esc(st.label)}</div>` : ''}<div class="v">${esc(st.value)}</div>${st.note ? `<div class="x">${esc(st.note)}</div>` : ''}</div>`;
  const callout = (fill: string, st: PitchStat, size = 32) => `<div class="bf-panel ${fill} bf-callout"><div class="l">${esc(st.label)}</div><div class="f" style="font-size:${size}px">${esc(st.value)}</div>${st.note ? `<div class="n">${esc(st.note)}</div>` : ''}</div>`;
  const metaPair = (st: PitchStat, right = false) => `<div class="bf-meta ${right ? 'r' : ''}"><span class="bf-label">${esc(st.label)}</span><span class="v">${esc(st.value)}</span></div>`;
  const chart = (c: NonNullable<PitchSlide['chart']>) => `<div style="border-left:1px solid var(--bf-hair);padding-left:22px;min-width:0"><div style="font-size:12.5px;color:var(--bf-grey)">${esc(c.label)}</div><div class="bf-bars">${c.values.map((v) => `<div style="height:${Math.max(v, 1.5)}%"></div>`).join('')}</div><div class="bf-months">${c.labels.map((m) => `<div>${esc(m)}</div>`).join('')}</div></div>`;
  const three = ['p1', 'p2', 'white'];
  const fillsFor = (n: number) => (n <= 3 ? three.slice(0, n) : Array.from({ length: n }, (_, i) => three[i % 3]));

  const body = (s: PitchSlide, n: number): string => {
    switch (s.kind) {
      case 'cover': {
        const logo = s.images[0] ? image(s.images[0]) : '';
        return `<div style="display:flex;justify-content:space-between;align-items:flex-start">${wordmark('', 'width:132px;display:block')}<img src="${asset('tiktok-shop-partner-white.png')}" alt="TikTok Shop Partner" style="height:38px;display:block;opacity:.95"></div>
<div style="margin-top:auto;margin-bottom:30px"><h1 class="bf-h cover">${esc(s.title)}</h1>${s.subtitle ? `<div class="bf-outline">${esc(s.subtitle)}</div>` : ''}</div>
<div style="display:flex;gap:52px;align-items:flex-end;padding-top:20px;padding-bottom:46px;border-top:1px solid var(--bf-hair)">${s.stats.map((st) => metaPair(st)).join('')}${logo ? `<div style="margin-left:auto;background:#fff;border-radius:2px;padding:10px 14px;display:flex;align-items:center"><img src="${logo}" alt="" style="max-height:34px;max-width:160px;display:block"></div>` : ''}</div>
<p class="bf-disc">${esc(CONFIDENTIALITY)}</p>`;
      }
      case 'why_us': {
        const quotes = (s.panels ?? []).slice(0, 2);
        return head(n, s) + `<div class="bf-grid bf-fill" style="grid-template-columns:1fr 1fr;gap:22px;align-content:start"><div style="display:grid;gap:14px;align-content:start">${quotes.map((qt, i) => panel(i === 0 ? 'p1' : 'white', `<p class="bf-quote">“${esc(qt.items[0])}”</p><div class="bf-qn">${esc(qt.heading)}</div><div class="bf-qr">${esc(qt.items[1] ?? '')}</div>`, { style: 'padding:20px' })).join('')}</div><div style="display:grid;align-content:start">${s.bullets.map((c, i) => `<div class="bf-cred"><span class="bf-num sm">${String(i + 1).padStart(2, '0')}</span><span>${esc(c)}</span></div>`).join('')}<div style="display:flex;gap:12px;margin-top:22px;align-items:center">${['tsp-affiliates-q1-2026', 'tsp-ads-q1-2026', 'tsp-short-video-q1-2026'].map((b) => `<img src="${asset(`badges/${b}.png`)}" alt="" style="height:76px">`).join('')}<span style="font-size:11.5px;color:var(--bf-grey-2);line-height:1.4;max-width:150px">${esc(s.body ?? '')}</span></div></div></div>`;
      }
      case 'portfolio': {
        const rows = [s.stats.slice(0, 4), s.stats.slice(4, 8)].filter((r) => r.length);
        return head(n, s) + `<div style="display:grid;gap:18px">${rows.map((r) => `<div class="bf-grid" style="grid-template-columns:repeat(4,1fr)">${r.map((st) => card(st)).join('')}</div>`).join('')}</div>`;
      }
      case 'clients':
        return head(n, s) + `<div class="bf-grid bf-fill" style="grid-template-columns:repeat(6,1fr);grid-auto-rows:1fr;gap:8px 34px;align-items:center">${BRIGHTFORM.logos.map(([l, h]) => `<div style="display:flex;align-items:center;justify-content:center;min-height:0"><img src="${asset(`clients/${l}.png`)}" alt="" style="max-width:100%;max-height:${h}px;object-fit:contain;opacity:.92"></div>`).join('')}</div>`;
      case 'awards':
        return head(n, s) + `<div class="bf-grid bf-fill" style="grid-template-columns:1.5fr 1fr 1fr"><img class="bf-photo" src="${asset('photography/award-stage.png')}" alt=""><div style="display:grid;grid-template-rows:1fr 1fr;gap:18px;min-height:0"><img class="bf-photo" src="${asset('photography/award-handover.jpg')}" alt=""><img class="bf-photo" src="${asset('photography/fgvcon-award-team.jpg')}" alt=""></div>${panel('accent', `<p style="font-size:12.5px;line-height:1.45">${esc(s.body ?? '')}</p><div style="display:flex;gap:6px;margin-top:auto;flex-wrap:wrap">${['tsp-affiliates-q1-2026', 'tsp-ads-q1-2026', 'tsp-short-video-q1-2026', 'tsp-affiliates-q4-2025'].map((b) => `<img src="${asset(`badges/${b}.png`)}" alt="" style="height:66px">`).join('')}</div>`, { heading: 'Q1 2026 TSP awards', style: 'padding:20px' })}</div>`;
      case 'divider':
        return `<div style="margin:auto 0;display:flex;flex-direction:column;gap:20px"><span class="bf-num xl">${String(n).padStart(2, '0')}</span><h2 class="bf-h div">${esc(s.title)}</h2></div>`;
      case 'presence': case 'market': {
        const imgs = s.images.map(image).filter(Boolean).slice(0, 3);
        // Cards across the top, then the record in panel 1 beside the read in the accent panel: both size to their lines, the black ground stays empty below.
        return head(n, s) + (s.stats.length ? `<div class="bf-grid" style="grid-template-columns:repeat(${Math.min(4, s.stats.length)},1fr);margin-bottom:18px">${s.stats.slice(0, 4).map((st) => card(st)).join('')}</div>` : '') + `<div class="bf-grid" style="grid-template-columns:${imgs.length ? '1.3fr 1fr 1fr' : '1.4fr 1fr'};align-items:start">${s.bullets.length ? panel('p1', list(s.bullets.slice(0, 7)), { heading: s.kind === 'presence' ? 'On record' : 'Who is winning' }) : `<div></div>`}${s.body ? panel('accent', `<p style="font-size:14px;line-height:1.5;font-weight:600">${esc(s.body)}</p>`, { heading: s.kind === 'presence' ? 'The read' : 'What it means' }) : ''}${imgs.length ? `<div style="display:flex;gap:10px;min-height:0;max-height:260px">${imgs.map((u) => `<img class="bf-photo" src="${u}" alt="" style="object-fit:contain;background:#fff">`).join('')}</div>` : ''}</div>`;
      }
      case 'products': {
        const tiles = s.stats.slice(0, 6).map((st, i) => ({ st, src: s.images[i] ? image(s.images[i]) : '' }));
        return head(n, s) + `<div class="bf-grid bf-fill" style="grid-template-columns:repeat(${Math.min(tiles.length, 3)},1fr);grid-auto-rows:1fr">${tiles.map(({ st, src }) => `<div class="bf-tile"><div class="im">${src ? `<img src="${src}" alt="">` : `<span style="font-size:11px;opacity:.5">no image</span>`}</div><div class="nm">${esc(st.label)}</div><div style="display:flex;justify-content:space-between;align-items:center"><span class="pr">${esc(st.value)}</span>${st.note ? `<span class="bf-pill held" style="font-size:9px">${esc(st.note)}</span>` : ''}</div></div>`).join('')}</div>`;
      }
      case 'opportunity':
        return head(n, s) + `<div class="bf-grid bf-fill" style="grid-template-columns:1.2fr 1fr;gap:30px"><div>${list(s.bullets, 'dark lg')}${s.body ? `<div class="bf-arrow" style="font-size:13.5px">${esc(s.body)}</div>` : ''}</div><div style="display:grid;gap:18px;align-content:start">${s.stats.slice(0, 2).map((st, i) => callout(i === 0 ? 'data' : 'accent', st, 40)).join('')}</div></div>`;
      case 'case_study': {
        const [hl, ...rest] = s.stats;
        const callouts = rest.slice(0, 2), chips = rest.slice(2, 10);
        return head(n, s) + `<div class="bf-grid" style="grid-template-columns:216px 1fr 178px 178px;align-items:stretch"><div><span class="bf-pill">Case</span><p style="margin:14px 0 0;font-size:13px;line-height:1.45;color:var(--bf-grey)">${esc(s.body ?? '')}</p><div style="margin-top:18px"><span class="bf-label">Headline</span></div><div style="font-family:var(--bf-display);font-variation-settings:'wdth' 116;font-weight:800;font-size:44px;letter-spacing:-.02em;line-height:1;margin-top:8px;color:#fff">${esc(hl?.value ?? '')}</div><div style="font-size:12.5px;color:var(--bf-grey);margin-top:6px">${esc(hl?.note ?? '')}</div></div>${s.chart ? chart(s.chart) : '<div></div>'}${callouts.map((st, i) => callout(i === 0 ? 'accent' : 'data', st)).join('')}</div>${chips.length ? `<div class="bf-grid" style="grid-template-columns:repeat(${Math.min(8, chips.length)},1fr);gap:10px;margin-top:18px">${chips.map((st) => card(st, 'chip')).join('')}</div>` : ''}`;
      }
      case 'outreach': case 'framework': case 'profitability': {
        const ps = (s.panels ?? []).slice(0, 3);
        return head(n, s) + `<div class="bf-grid bf-fill" style="grid-template-columns:repeat(${Math.max(1, ps.length)},1fr)">${ps.map((pn, i) => panel(fillsFor(ps.length)[i], (s.kind === 'profitability' ? `<p>${esc(pn.items.join(' '))}</p>` : list(pn.items, '')) + (s.body && i === ps.length - 1 ? `<div class="bf-arrow">${esc(s.body)}</div>` : ''), { num: i + 1, heading: pn.heading })).join('')}</div>`;
      }
      case 'cruva':
        return head(n, s, null) + `<div class="bf-grid bf-fill" style="grid-template-columns:1.1fr 1fr;gap:30px"><div><span class="bf-label">AI-powered creator discovery</span><p style="margin:12px 0 0;max-width:62ch;font-size:15px;line-height:1.5">${esc(s.body ?? '')}</p><div style="margin-top:24px"><span class="bf-label">Capabilities</span></div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">${s.bullets.map((c) => `<span class="bf-chip">${esc(c)}</span>`).join('')}</div><div style="margin-top:24px"><span class="bf-label">Markets</span></div><div style="display:flex;gap:8px;margin-top:12px">${p.brief.markets.map((m) => `<span class="bf-chip">${esc(m.toUpperCase())}</span>`).join('')}</div></div><div style="display:grid;gap:18px;align-content:start"><div class="bf-grid" style="grid-template-columns:1fr 1fr">${s.stats.slice(0, 2).map((st, i) => callout(i === 0 ? 'data' : 'accent', st, 40)).join('')}</div>${s.stats[2] ? callout('p1', s.stats[2], 32) : ''}${s.subtitle ? panel('p1', `<p>${esc(s.subtitle)}</p>`, { heading: 'Broad demand capture', style: 'padding:20px' }) : ''}</div></div>`;
      case 'creators':
        return head(n, s) + `<div class="bf-grid bf-fill" style="grid-template-columns:2fr 1fr"><div class="bf-grid" style="grid-template-columns:repeat(4,1fr);grid-auto-rows:min-content;gap:12px">${s.stats.slice(0, 8).map((st) => card({ label: st.note ?? '', value: st.label, note: st.value }, 'chip')).join('')}</div>${panel('p1', list(s.bullets), { heading: 'How we work them' })}</div>`;
      case 'shoppable': {
        const [who, role, why] = s.panels ?? [];
        return head(n, s) + `<div class="bf-grid bf-fill" style="grid-template-columns:1fr 1fr 1fr"><div style="display:grid;grid-template-rows:auto 1fr;gap:18px">${[who, role].filter(Boolean).map((g) => `<div style="border-top:1px solid var(--bf-hair);padding-top:14px"><span class="bf-label pri">${esc(g!.heading)}</span><div style="margin-top:12px">${list(g!.items, 'dark')}</div></div>`).join('')}</div>${why ? panel('p1', list(why.items) + (s.body ? `<div class="bf-arrow" style="font-size:13px">${esc(s.body)}</div>` : ''), { heading: why.heading, style: 'padding:20px' }) : ''}<div style="display:grid;gap:18px;grid-template-rows:auto 1fr;min-height:0">${s.stats[0] ? callout('data', s.stats[0]) : ''}<div style="display:flex;gap:10px;justify-content:center;min-height:0">${['phone-estrid', 'phone-living-things', 'phone-waschies'].map((f) => `<img src="${asset(`screens/${f}.png`)}" alt="" style="height:100%;object-fit:contain;min-height:0">`).join('')}</div></div></div>`;
      }
      case 'livestream':
        return head(n, s, null) + `<div class="bf-grid bf-fill" style="grid-template-columns:1fr 1fr;gap:30px"><div><p style="margin:0;max-width:62ch;font-size:15px;line-height:1.5">${esc(s.subtitle ?? '')}</p><p style="margin:16px 0 0;max-width:62ch;font-size:15px;line-height:1.5;color:var(--bf-grey)">${esc(s.body ?? '')}</p>${s.notes ? `<div style="margin-top:26px;padding-top:18px;border-top:1px solid var(--bf-hair);font-size:13.5px;font-weight:600;line-height:1.5">${esc(s.notes)}</div>` : ''}</div>${panel('p1', `<ol style="margin:0;padding:0;list-style:none;display:grid;gap:14px">${s.bullets.map((t, i) => `<li style="display:flex;gap:14px;align-items:baseline;${i ? 'border-top:1px solid rgba(0,0,0,.14);padding-top:14px' : ''}"><span class="pn" style="font-size:22px;margin:0;opacity:.6;-webkit-text-stroke:1px var(--bf-ink)">${String(i + 1).padStart(2, '0')}</span><span style="font-size:14px;line-height:1.45">${esc(t)}</span></li>`).join('')}</ol>`, { heading: 'Core LIVE formats', style: 'padding:24px' })}</div>`;
      case 'studio': {
        const [enables, office, adv] = s.panels ?? [];
        return head(n, s) + `<div class="bf-grid bf-fill" style="grid-template-columns:1.15fr 1fr 1fr"><div style="display:grid;grid-template-rows:1fr 1fr;gap:18px;min-height:0"><img class="bf-photo" src="${asset('photography/studio-munich.jpg')}" alt=""><img class="bf-photo" src="${asset('photography/tiktok-office-lounge.png')}" alt=""></div>${enables ? panel('p1', list(enables.items), { heading: enables.heading, style: 'padding:20px' }) : ''}<div style="display:grid;gap:18px;grid-template-rows:auto 1fr auto;min-height:0">${office ? panel('white', `<p style="font-size:12.5px;line-height:1.45">${esc(office.items.join(' '))}</p>`, { heading: office.heading, style: 'padding:20px' }) : ''}${adv ? panel('accent', list(adv.items), { heading: adv.heading, style: 'padding:20px' }) : ''}${s.body ? `<div style="font-size:13.5px;font-weight:600;color:var(--bf-off);line-height:1.45">${esc(s.body)}</div>` : ''}</div></div>`;
      }
      case 'forecast':
        return head(n, s) + `<div class="bf-grid" style="grid-template-columns:repeat(${Math.min(4, Math.max(1, s.stats.length))},1fr);margin-bottom:18px">${s.stats.slice(0, 4).map((st) => card(st)).join('')}</div><div class="bf-grid bf-fill" style="grid-template-columns:1.4fr 1fr">${s.chart ? chart(s.chart) : '<div></div>'}${panel('p1', list(s.bullets), { heading: 'Assumptions' })}</div>`;
      case 'pricing':
        return head(n, s) + `<div class="bf-grid" style="grid-template-columns:repeat(${Math.min(3, Math.max(1, s.stats.length))},1fr);margin-bottom:18px">${s.stats.slice(0, 3).map((st, i) => callout(['accent', 'data', 'p1'][i], st, 36)).join('')}</div>${s.bullets.length ? panel('white', list(s.bullets, 'lg'), { heading: 'How it works', style: 'flex:1' }) : ''}${s.body ? `<div class="bf-arrow" style="font-size:13.5px;color:var(--bf-off)">${esc(s.body)}</div>` : ''}`;
      case 'deliverables': {
        const groups = s.panels ?? [];
        return head(n, s) + `<div class="bf-grid bf-fill" style="grid-template-columns:repeat(${Math.max(1, groups.length)},1fr)">${groups.map((g) => `<div class="bf-group"><h3>${esc(g.heading)}</h3>${list(g.items, 'dark')}</div>`).join('')}</div>`;
      }
      case 'mor': {
        const groups = (s.panels ?? []).slice(0, 7);
        return head(n, s) + `<div class="bf-grid bf-fill" style="grid-template-columns:repeat(4,1fr);grid-template-rows:1fr 1fr">${groups.map((g) => `<div class="bf-mor"><h3>${esc(g.heading)}</h3>${list(g.items, 'dark')}</div>`).join('')}${panel('accent', `<p style="font-size:12.5px;line-height:1.45">${esc(s.body ?? '')}</p>`, { heading: 'Fully covered', style: 'padding:16px' })}</div>`;
      }
      case 'team':
        return head(n, s) + `<div class="bf-grid" style="grid-template-columns:repeat(3,1fr)">${BRIGHTFORM.team.leads.map(([nm, role, img], i) => panel(three[i], `<div style="display:flex;align-items:center;gap:16px">${img ? `<img src="${asset(`people/${img}`)}" alt="" style="width:62px;height:62px;object-fit:cover;border-radius:999px;flex:none">` : `<div style="width:62px;height:62px;border-radius:999px;flex:none;background:rgba(0,0,0,.12)"></div>`}<div><div style="font-family:var(--bf-display);font-variation-settings:'wdth' 112;font-weight:800;text-transform:uppercase;font-size:15px">${esc(nm)}</div><div style="font-size:12.5px;opacity:.68;margin-top:6px">${esc(role)}</div></div></div>`, { style: 'padding:20px' })).join('')}</div><div class="bf-grid" style="grid-template-columns:repeat(6,1fr);gap:12px;margin-top:18px">${BRIGHTFORM.team.team.map(([nm, role]) => `<div style="border-top:1px solid var(--bf-hair);padding-top:12px"><div style="font-size:13px;color:var(--bf-off);line-height:1.3">${esc(nm)}</div><div style="font-size:11.5px;color:var(--bf-grey-2);margin-top:4px">${esc(role)}</div></div>`).join('')}</div>`;
      case 'next': case 'roadmap':
        return head(n, s) + panel('p1', `<div class="bf-grid" style="grid-template-columns:repeat(${Math.max(1, Math.min(5, s.bullets.length))},1fr);gap:22px;flex:1">${s.bullets.slice(0, 5).map((st, i) => `<div class="bf-step"><span class="n">${String(i + 1).padStart(2, '0')}</span><span>${esc(st)}</span></div>`).join('')}</div>${s.body ? `<div style="margin-top:auto;padding-top:26px;font-size:15px;font-weight:600">${esc(s.body)}</div>` : ''}`, { style: 'padding:34px;flex:1' });
      case 'closing':
        return `<div style="display:flex;justify-content:flex-end">${wordmark('', 'width:132px;display:block')}</div><div style="margin-top:auto;text-align:right"><div style="font-size:20px;color:var(--bf-grey)">${esc(s.subtitle ?? 'Why wait?')}</div><h2 class="bf-h close">${esc(s.title)}</h2></div><div style="display:flex;gap:54px;justify-content:flex-end;margin-top:40px;padding-top:22px;border-top:1px solid var(--bf-hair)">${s.stats.map((st) => metaPair(st, true)).join('')}</div>`;
      default: {
        const imgs = s.images.map(image).filter(Boolean).slice(0, 3);
        return head(n, s) + (s.stats.length ? `<div class="bf-grid" style="grid-template-columns:repeat(${Math.min(4, s.stats.length)},1fr);margin-bottom:18px">${s.stats.slice(0, 4).map((st) => card(st)).join('')}</div>` : '') + `<div class="bf-grid bf-fill" style="grid-template-columns:${imgs.length ? '1.2fr 1fr' : '1fr'}"><div>${s.bullets.length ? list(s.bullets, 'dark lg') : ''}${s.body ? `<p style="margin:16px 0 0;max-width:70ch;color:var(--bf-grey)">${esc(s.body)}</p>` : ''}</div>${imgs.length ? `<div style="display:flex;gap:10px;min-height:0">${imgs.map((u) => `<img class="bf-photo" src="${u}" alt="" style="object-fit:contain;background:#fff">`).join('')}</div>` : ''}</div>`;
      }
    }
  };

  const html = slides.map((s) => {
    const numbered = s.kind !== 'cover' && s.kind !== 'closing';
    if (numbered) page += 1;
    const n = page;
    return `<section class="bf-slide" data-kind="${s.kind}" id="${esc(s.key)}"><div class="bf-pad">${body(s, n)}</div>${numbered ? `<div class="bf-page">${String(n).padStart(2, '0')}</div>${wordmark()}` : ''}${s.notes && s.kind !== 'livestream' ? `<aside class="bf-notes">${esc(s.notes)}</aside>` : ''}</section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.name)}</title>
<style>${fontCss(asset)}${CSS}</style></head>
<body><div class="bf-deck" style="${themeCss(deck.theme)}">${html}</div>
<script>(function(){var d=document.querySelector('.bf-deck');var fit=function(){if(window.matchMedia('print').matches)return;d.style.zoom=String(Math.min(1,(window.innerWidth-48)/1280));};fit();window.addEventListener('resize',fit);window.addEventListener('beforeprint',function(){d.style.zoom='1';});document.addEventListener('keydown',function(e){var s=[].slice.call(document.querySelectorAll('.bf-slide'));var y=window.scrollY;var i=s.findIndex(function(el){return el.offsetTop*parseFloat(d.style.zoom||'1')>y+10;});if(e.key==='ArrowRight'||e.key===' '||e.key==='PageDown'){var t=s[Math.min(s.length-1,Math.max(0,i))];if(t)t.scrollIntoView({behavior:'smooth'});e.preventDefault();}if(e.key==='ArrowLeft'||e.key==='PageUp'){var t2=s[Math.max(0,i-2)];if(t2)t2.scrollIntoView({behavior:'smooth'});e.preventDefault();}});})();</script>
</body></html>`;
}
