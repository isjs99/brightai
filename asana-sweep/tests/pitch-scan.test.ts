import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { brandColours, downloadImages, findLogo, jsonLdProducts, productLinks, scanSite, shopifyImageAt, shopifyProducts } from '../src/pitch/scan';
import { contrast, deriveBrandLayer, lightness } from '../src/pitch/theme';

const SHOPIFY = { products: [
  { id: 1, title: 'Gut Balance Capsules', handle: 'gut-balance', vendor: 'Kijimea', product_type: 'Supplements', tags: ['bestseller'], variants: [{ price: '29.90', available: true }, { price: '54.90', available: true }], images: [{ src: 'https://cdn.shopify.com/s/files/1/gut.jpg?v=1' }] },
  { id: 2, title: 'Daily Fibre', handle: 'daily-fibre', vendor: 'Kijimea', product_type: 'Supplements', tags: '', variants: [{ price: '19.90', available: false }], images: [{ src: 'https://cdn.shopify.com/s/files/1/fibre.png' }] },
  { id: 3, title: 'Gift Card', handle: 'gift-card', variants: [], images: [] },
] };
const HOME = `<html><head><title>Kijimea · Gut health</title><meta property="og:description" content="Probiotics made in Germany"><meta name="theme-color" content="#0b5fff"><link rel="stylesheet" href="/theme.css"><link rel="icon" href="/favicon.png"></head>
<body><style>.btn{background:#0b5fff}.btn:hover{background:#0b5fff}.hero{color:#fff;background:#f7f7f7}.sale{background:#e4322b}.x{color:#333}</style><img class="site-logo" src="/img/logo.svg"><a href="/products/gut-balance">Gut</a><a href="/collections/all">All</a></body></html>`;

const fetcher = (routes: Record<string, string | object>) => async (url: string) => {
  const u = new URL(url); const key = u.pathname + (u.search && routes[u.pathname + u.search] ? u.search : '');
  const hit = routes[key] ?? routes[u.pathname];
  if (hit === undefined) return new Response('nope', { status: 404 });
  return typeof hit === 'string' ? new Response(hit, { status: 200, headers: { 'content-type': hit.trim().startsWith('{') ? 'application/json' : 'text/html' } }) : new Response(JSON.stringify(hit), { status: 200, headers: { 'content-type': 'application/json' } });
};

describe('the brand scan', () => {
  it('reads a Shopify store: products in best-selling order, prices, images, currency, colours and the logo', async () => {
    const fetchFn = fetcher({ '/': HOME, '/theme.css': '.a{color:#0b5fff}.b{background:#0b5fff}.c{background:#0b5fff}.d{color:#e4322b}', '/meta.json': { currency: 'EUR' }, '/products.json': SHOPIFY, '/collections/all/products.json': { products: [SHOPIFY.products[1], SHOPIFY.products[0]] } });
    const scan = await scanSite('kijimea.de', fetchFn as unknown as typeof fetch);
    expect(scan.platform).toBe('shopify');
    expect(scan.currency).toBe('EUR');
    expect(scan.title).toBe('Kijimea · Gut health');
    expect(scan.products.map((p) => [p.name, p.rank, p.price])).toEqual([['Daily Fibre', 1, 19.9], ['Gut Balance Capsules', 2, 29.9], ['Gift Card', null, null]]);
    expect(scan.products[1].images[0]).toBe('https://cdn.shopify.com/s/files/1/gut.jpg?v=1');
    expect(scan.colours[0]).toBe('#0b5fff'); // the theme colour and the most used colour
    expect(scan.colours).toContain('#e4322b');
    expect(scan.colours).not.toContain('#333333'); // greys are not brand colours
    expect(scan.logo).toBe('https://kijimea.de/img/logo.svg');
    expect(scan.errors).toEqual([]);
  });

  it('reads any other site through product links and JSON-LD', async () => {
    const pdp = (name: string, price: string) => `<html><body><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Product', name, image: ['/img/' + name + '.jpg'], brand: { name: 'Acme' }, offers: { '@type': 'Offer', price, priceCurrency: 'GBP', availability: 'https://schema.org/InStock' } }] })}</script></body></html>`;
    const home = `<html><body><a href="/product/serum">Serum</a><a href="/product/serum/">dup</a><a href="/product/cream">Cream</a><a href="/collections/all">no</a><a href="https://other.com/product/x">no</a></body></html>`;
    const scan = await scanSite('https://acme.co.uk', fetcher({ '/': home, '/product/serum': pdp('Serum', '24.00'), '/product/cream': pdp('Cream', '18.50') }) as unknown as typeof fetch);
    expect(scan.platform).toBe('other');
    expect(scan.products.map((p) => [p.name, p.price, p.currency, p.available, p.rank])).toEqual([['Serum', 24, 'GBP', true, 1], ['Cream', 18.5, 'GBP', true, 2]]);
    expect(scan.products[0].images[0]).toBe('https://acme.co.uk/img/Serum.jpg');
    expect(scan.currency).toBe('GBP');
    expect(productLinks(home, 'https://acme.co.uk')).toEqual(['https://acme.co.uk/product/serum', 'https://acme.co.uk/product/cream']);
  });

  it('parses the pieces on their own', () => {
    expect(shopifyProducts({ products: [] }, 'https://x.com', null)).toEqual([]);
    expect(shopifyProducts(null, 'https://x.com', null)).toEqual([]);
    expect(shopifyImageAt('https://cdn.shopify.com/s/files/1/gut.jpg?v=1')).toBe('https://cdn.shopify.com/s/files/1/gut_1200x.jpg?v=1');
    expect(shopifyImageAt('https://acme.co.uk/img/a.jpg')).toBe('https://acme.co.uk/img/a.jpg');
    expect(jsonLdProducts('<script type="application/ld+json">not json</script>', 'https://x.com')).toEqual([]);
    expect(brandColours('.a{color:#fff}.b{color:#000}.c{color:#888}.d{color:rgb(11, 95, 255)}.e{color:#0b5fff}.f{color:#0c60fe}')).toEqual(['#0b5fff']); // white, black, grey dropped; the near-identical shade merged
    expect(findLogo('<meta property="og:logo" content="/l.png">', 'https://x.com')).toBe('https://x.com/l.png');
    expect(findLogo('<img src="/pixel.gif" alt="logo"><img src="/brand-logo.png" alt="Brand logo">', 'https://x.com')).toBe('https://x.com/brand-logo.png');
  });

  it('downloads images once into the pitch folder and skips the ones that fail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bf-scan-'));
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const calls: string[] = [];
    const fetchFn = async (url: string) => { calls.push(url); return url.includes('bad') ? new Response('x', { status: 404 }) : new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }); };
    const got = await downloadImages(dir, ['https://cdn.shopify.com/a.jpg', 'https://x.com/bad.png', 'https://cdn.shopify.com/a.jpg'], { fetchFn: fetchFn as unknown as typeof fetch });
    expect(Object.keys(got)).toEqual(['https://cdn.shopify.com/a.jpg']);
    expect(calls[0]).toBe('https://cdn.shopify.com/a_1200x.jpg'); // the CDN's resized variant
    expect(readdirSync(dir)).toHaveLength(1);
    const again = await downloadImages(dir, ['https://cdn.shopify.com/a.jpg'], { fetchFn: fetchFn as unknown as typeof fetch });
    expect(again).toEqual(got);
    expect(calls).toHaveLength(2); // not fetched twice
  });
});

describe('the brand layer', () => {
  it('pulls a client colour to panel lightness and ink darkness with the contrast the brand book asks for', () => {
    const t = deriveBrandLayer({ primary: '#0b5fff', secondary: '#e4322b' });
    expect(t.source.neutral).toBe(false);
    expect(lightness(t.layer.panel1)).toBeGreaterThanOrEqual(88); expect(lightness(t.layer.panel1)).toBeLessThanOrEqual(94);
    expect(lightness(t.layer.panel2)).toBeGreaterThanOrEqual(66); expect(lightness(t.layer.panel2)).toBeLessThanOrEqual(74);
    expect(lightness(t.layer.accent)).toBeGreaterThanOrEqual(90); expect(lightness(t.layer.accent)).toBeLessThanOrEqual(94);
    expect(lightness(t.layer.data)).toBeGreaterThanOrEqual(90);
    expect(contrast(t.layer.accentInk, t.layer.accent)).toBeGreaterThanOrEqual(7);
    expect(contrast(t.layer.dataInk, t.layer.data)).toBeGreaterThanOrEqual(4.5);
    expect(t.layer.panel1).not.toBe(t.layer.panel2);
    // Every panel reads light against black; every ink would be too dark to sit on black.
    for (const panel of [t.layer.panel1, t.layer.panel2, t.layer.accent, t.layer.data]) expect(contrast(panel, '#000000')).toBeGreaterThan(8);
    for (const ink of [t.layer.accentInk, t.layer.dataInk]) expect(contrast(ink, '#000000')).toBeLessThan(5);
  });
  it('keeps the Brightform set for a grey or black primary and the lilac data panel for a one-colour client', () => {
    expect(deriveBrandLayer({ primary: '#0f0f10' }).source.neutral).toBe(true);
    expect(deriveBrandLayer({ primary: '#0f0f10' }).layer.panel1).toBe('#e9e4dc');
    const one = deriveBrandLayer({ primary: '#1d9e75' });
    expect(one.layer.data).toBe('#e8e6f7'); expect(one.layer.dataInk).toBe('#6466f1');
    expect(one.source.secondary).toBeNull();
  });
});
