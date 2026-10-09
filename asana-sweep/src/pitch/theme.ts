/**
 * The brand layer of the Brightform Design System, derived from a client's colours the way the brand book
 * says: the core (black ground, white display type, off-white body, dark cards) never moves; six tokens
 * carry the client's colour, each pulled to a panel lightness or an ink darkness in CIE L*a*b* so a
 * published brand value never lands on a slide as is. Panels sit at L* 88 to 94, panel 2 at 66 to 74,
 * inks at 36 to 55 and must clear 7:1 (accent) and 4.5:1 (data) on their own panel.
 */

export interface BrandLayer { panel1: string; panel2: string; accent: string; accentInk: string; data: string; dataInk: string }
export interface ThemeReport { layer: BrandLayer; contrast: { accent: number; data: number }; source: { primary: string; secondary: string | null; neutral: boolean } }

export const BRIGHTFORM_LAYER: BrandLayer = { panel1: '#e9e4dc', panel2: '#b4a696', accent: '#d9f2e6', accentInk: '#1d9e75', data: '#e8e6f7', dataInk: '#6466f1' };

type Rgb = [number, number, number];
type Lab = [number, number, number];

export function hexToRgb(hex: string): Rgb | null {
  const m = hex.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
export const rgbToHex = (rgb: Rgb): string => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

const lin = (c: number): number => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const unlin = (v: number): number => { const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055; return c * 255; };
const Xn = 0.95047, Yn = 1, Zn = 1.08883;
const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
const finv = (t: number): number => (t > 6 / 29 ? t ** 3 : (108 / 841) * (t - 4 / 29));

export function rgbToLab([r, g, b]: Rgb): Lab {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / Xn;
  const Y = (0.2126729 * R + 0.7151522 * G + 0.072175 * B) / Yn;
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / Zn;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

export function labToRgb([L, a, b]: Lab): Rgb {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const X = finv(fx) * Xn, Y = finv(fy) * Yn, Z = finv(fz) * Zn;
  const R = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const G = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  const B = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  return [unlin(R), unlin(G), unlin(B)];
}

/** WCAG relative luminance and contrast ratio. */
export const luminance = (hex: string): number => { const c = hexToRgb(hex) ?? [0, 0, 0]; return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); };
export const contrast = (a: string, b: string): number => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const chromaOf = ([, a, b]: Lab): number => Math.hypot(a, b);
const hueOf = ([, a, b]: Lab): number => Math.atan2(b, a);
/** A colour at a given L* and chroma on a hue angle; clipped to sRGB by lowering chroma until it fits. */
function at(hue: number, L: number, chroma: number): string {
  for (let c = chroma; c >= 0; c -= 1) {
    const rgb = labToRgb([L, c * Math.cos(hue), c * Math.sin(hue)]);
    if (rgb.every((v) => v >= -0.5 && v <= 255.5)) return rgbToHex(rgb);
  }
  return rgbToHex(labToRgb([L, 0, 0]));
}
/** Darken an ink on its hue until it clears the ratio on its panel (L* steps of one, never below 20). */
function inkFor(hue: number, panel: string, L: number, chroma: number, ratio: number): string {
  let l = L;
  let hex = at(hue, l, chroma);
  while (contrast(hex, panel) < ratio && l > 20) { l -= 1; hex = at(hue, l, chroma); }
  return hex;
}

const isNeutral = (lab: Lab): boolean => chromaOf(lab) < 9;
const hueDistance = (a: number, b: number): number => { const d = Math.abs(a - b) % (2 * Math.PI); return Math.min(d, 2 * Math.PI - d); };

/**
 * Build the six tokens from the client's primary (signature) colour and, when they have one, a second
 * colour. A grey or near-grey primary keeps the Brightform set: there is no hue to carry.
 */
export function deriveBrandLayer(colours: { primary: string; secondary?: string | null; accent?: string | null }): ThemeReport {
  const primaryRgb = hexToRgb(colours.primary);
  const primary = primaryRgb ? rgbToLab(primaryRgb) : null;
  const seconds = [colours.secondary, colours.accent].map((c) => (c ? hexToRgb(c) : null)).map((c) => (c ? rgbToLab(c) : null)).filter((c): c is Lab => Boolean(c) && !isNeutral(c!));
  if (!primary || isNeutral(primary)) {
    return { layer: { ...BRIGHTFORM_LAYER }, contrast: { accent: contrast(BRIGHTFORM_LAYER.accentInk, BRIGHTFORM_LAYER.accent), data: contrast(BRIGHTFORM_LAYER.dataInk, BRIGHTFORM_LAYER.data) }, source: { primary: colours.primary, secondary: colours.secondary ?? null, neutral: true } };
  }
  const hue = hueOf(primary);
  const chroma = chromaOf(primary);
  // Panels: the quietest colour. A second brand colour that is clearly another hue gives the data panel its own hue.
  const second = seconds.find((c) => hueDistance(hueOf(c), hue) > Math.PI / 5) ?? null;
  const panelHue = second ? hueOf(second) : hue;
  const panel1 = at(panelHue, 90.5, 7);
  const panel2 = at(panelHue, 70, 13);
  const accent = at(hue, 92, Math.min(14, Math.max(9, chroma * 0.22)));
  const accentInk = inkFor(hue, accent, 42, Math.min(48, Math.max(22, chroma * 0.8)), 7);
  const data = second ? at(hueOf(second), 92, 11) : BRIGHTFORM_LAYER.data;
  const dataInk = second ? inkFor(hueOf(second), data, 50, Math.min(50, Math.max(24, chromaOf(second) * 0.8)), 4.5) : BRIGHTFORM_LAYER.dataInk;
  const layer = { panel1, panel2, accent, accentInk, data, dataInk };
  return { layer, contrast: { accent: contrast(accentInk, accent), data: contrast(dataInk, data) }, source: { primary: colours.primary, secondary: second ? rgbToHex(labToRgb(second)) : null, neutral: false } };
}

/** CSS custom properties for a brand layer, in the names the design system's components read. */
export function layerCss(layer: BrandLayer): string {
  return `--bf-panel-1:${layer.panel1};--bf-panel-2:${layer.panel2};--bf-accent:${layer.accent};--bf-accent-ink:${layer.accentInk};--bf-data:${layer.data};--bf-data-ink:${layer.dataInk};`;
}

/** L* of a hex colour, for tests and the theme readout. */
export const lightness = (hex: string): number => { const c = hexToRgb(hex); return c ? rgbToLab(c)[0] : 0; };
