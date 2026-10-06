/**
 * A small PDF writer (no dependencies) for the Brightform client report: Helvetica text with word
 * wrapping, filled rectangles, lines and a bar chart, A4 portrait. Enough for a branded report that
 * opens anywhere; the layout lives in reportPdf() below.
 */

const W = 595.28, H = 841.89;
// Helvetica widths per 1000 units for ASCII 32..126 (bold is scaled up a touch).
const WIDTHS = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

export type Rgb = [number, number, number];
export const INK: Rgb = [0.06, 0.06, 0.063];
export const MUTED: Rgb = [0.35, 0.37, 0.42];
export const FAINT: Rgb = [0.75, 0.76, 0.79];
export const ACCENT: Rgb = [0.114, 0.239, 0.941];
export const GOOD: Rgb = [0.118, 0.561, 0.306];
export const CRIT: Rgb = [0.784, 0.196, 0.176];
export const PAPER: Rgb = [0.965, 0.965, 0.97];

const latin = (s: string): string => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/–|—/g, '-').replace(/•/g, '-').replace(/€/g, 'EUR ').replace(/£/g, 'GBP ').replace(/[^\x20-\x7e]/g, '?');
const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export function textWidth(s: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of latin(s)) { const c = ch.charCodeAt(0); w += (c >= 32 && c <= 126 ? WIDTHS[c - 32] : 556); }
  return (w / 1000) * size * (bold ? 1.05 : 1);
}

export function wrap(s: string, size: number, width: number, bold = false): string[] {
  const out: string[] = [];
  for (const para of s.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (textWidth(next, size, bold) <= width || !line) line = next; else { out.push(line); line = w; }
    }
    out.push(line);
  }
  return out;
}

export class Pdf {
  private pages: string[][] = [];
  private cur: string[] = [];
  constructor(public readonly margin = 44) { this.addPage(); }

  get pageCount(): number { return this.pages.length; }

  addPage(): void { this.cur = []; this.pages.push(this.cur); }

  private rgb(c: Rgb, op: 'rg' | 'RG'): string { return `${c.map((v) => v.toFixed(3)).join(' ')} ${op}`; }

  rect(x: number, y: number, w: number, h: number, fill: Rgb): void { this.cur.push(`${this.rgb(fill, 'rg')} ${x.toFixed(2)} ${(H - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`); }

  line(x1: number, y1: number, x2: number, y2: number, color: Rgb, width = 0.6): void { this.cur.push(`${this.rgb(color, 'RG')} ${width} w ${x1.toFixed(2)} ${(H - y1).toFixed(2)} m ${x2.toFixed(2)} ${(H - y2).toFixed(2)} l S`); }

  /** Draw one line of text with its baseline at y (top-left coordinates, y grows downwards). */
  text(x: number, y: number, s: string, opts: { size?: number; bold?: boolean; color?: Rgb; align?: 'left' | 'right' | 'center'; maxWidth?: number } = {}): void {
    const size = opts.size ?? 10;
    let str = latin(s);
    if (opts.maxWidth && textWidth(str, size, opts.bold) > opts.maxWidth) {
      let base = str;
      while (base.length > 1 && textWidth(`${base}...`, size, opts.bold) > opts.maxWidth) base = base.slice(0, -1).trimEnd();
      str = `${base}...`;
    }
    const w = textWidth(str, size, opts.bold);
    const px = opts.align === 'right' ? x - w : opts.align === 'center' ? x - w / 2 : x;
    this.cur.push(`BT ${this.rgb(opts.color ?? INK, 'rg')} /${opts.bold ? 'F2' : 'F1'} ${size} Tf ${px.toFixed(2)} ${(H - y).toFixed(2)} Td (${esc(str)}) Tj ET`);
  }

  /** Wrapped paragraph; returns the y after the last line. */
  paragraph(x: number, y: number, width: number, s: string, opts: { size?: number; bold?: boolean; color?: Rgb; lineHeight?: number } = {}): number {
    const size = opts.size ?? 10;
    const lh = opts.lineHeight ?? size * 1.42;
    let yy = y;
    for (const line of wrap(s, size, width, opts.bold)) { this.text(x, yy, line, { size, bold: opts.bold, color: opts.color }); yy += lh; }
    return yy;
  }

  build(): Buffer {
    const objects: string[] = [];
    const add = (body: string): number => { objects.push(body); return objects.length; };
    const fontN = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const fontB = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const pagesId = objects.length + 1 + this.pages.length * 2;
    const pageIds: number[] = [];
    for (const p of this.pages) {
      const content = p.join('\n');
      const cId = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
      pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${cId} 0 R /Resources << /Font << /F1 ${fontN} 0 R /F2 ${fontB} 0 R >> >> >>`));
    }
    const pid = add(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
    if (pid !== pagesId) throw new Error('PDF object numbering mismatch');
    const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets: number[] = [];
    objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}

// ---- The Brightform client report ----

export interface ReportPdfInput {
  account: string;
  title: string;
  period_label: string;
  prepared_by: string | null;
  currency: string;
  kpis: { label: string; value: string; delta?: string | null; up?: boolean | null }[];
  chart: { label: string; value: number }[];
  chart_title: string;
  body_md: string;
  footer_note?: string | null;
}

const fmtMoney = (n: number, cur: string): string => `${cur === 'EUR' ? 'EUR ' : cur === 'GBP' ? 'GBP ' : `${cur} `}${Math.round(n).toLocaleString('en-GB')}`;

/** Brightform report layout: black header band, big-number KPI tiles, the GMV chart, then the sections. */
export function reportPdf(input: ReportPdfInput): Buffer {
  const pdf = new Pdf();
  const M = pdf.margin;
  const CW = W - 2 * M;
  let y = 0;
  const footer = () => {
    const n = pdf.pageCount;
    pdf.line(M, H - 34, W - M, H - 34, FAINT, 0.5);
    pdf.text(M, H - 22, 'Brightform  |  TikTok Shop growth agency  |  brightform.agency', { size: 8, color: MUTED });
    pdf.text(W - M, H - 22, `${input.account}  |  ${input.period_label}  |  page ${n}`, { size: 8, color: MUTED, align: 'right' });
  };
  const ensure = (need: number) => { if (y + need > H - 50) { footer(); pdf.addPage(); y = M; } };

  // Header band.
  pdf.rect(0, 0, W, 118, INK);
  pdf.text(M, 44, 'Brightform.', { size: 22, bold: true, color: [1, 1, 1] });
  pdf.text(M + textWidth('Brightform.', 22, true) + 8, 44, 'CLIENT REPORT', { size: 8.5, bold: true, color: [0.7, 0.72, 0.78] });
  pdf.text(W - M, 44, input.period_label, { size: 10, color: [0.85, 0.86, 0.9], align: 'right' });
  pdf.text(M, 82, input.title, { size: 17, bold: true, color: [1, 1, 1], maxWidth: CW });
  pdf.text(M, 100, `Prepared for ${input.account}${input.prepared_by ? `  |  Account manager: ${input.prepared_by}` : ''}  |  ${new Date().toISOString().slice(0, 10)}`, { size: 9, color: [0.75, 0.77, 0.82] });
  pdf.rect(0, 118, W, 4, ACCENT);
  y = 142;

  // KPI tiles.
  const tiles = input.kpis.slice(0, 6);
  if (tiles.length) {
    const cols = Math.min(tiles.length, 3);
    const gap = 10;
    const tw = (CW - gap * (cols - 1)) / cols;
    const th = 58;
    tiles.forEach((k, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const x = M + col * (tw + gap), ty = y + row * (th + gap);
      pdf.rect(x, ty, tw, th, PAPER);
      pdf.rect(x, ty, 3, th, ACCENT);
      pdf.text(x + 12, ty + 16, k.label.toUpperCase(), { size: 7.5, bold: true, color: MUTED });
      pdf.text(x + 12, ty + 38, k.value, { size: 18, bold: true, maxWidth: tw - 24 });
      if (k.delta) pdf.text(x + 12, ty + 51, k.delta, { size: 8.5, color: k.up === null || k.up === undefined ? MUTED : k.up ? GOOD : CRIT });
    });
    y += Math.ceil(tiles.length / cols) * (th + gap) + 8;
  }

  // Chart.
  if (input.chart.length >= 2) {
    const ch = 130;
    ensure(ch + 30);
    pdf.text(M, y + 10, input.chart_title, { size: 10, bold: true });
    const top = y + 22, bottom = y + ch - 16, left = M + 46, right = W - M;
    const max = Math.max(...input.chart.map((c) => c.value), 1);
    for (const f of [0, 0.5, 1]) { const gy = bottom - (bottom - top) * f; pdf.line(left, gy, right, gy, FAINT, 0.4); pdf.text(left - 6, gy + 3, fmtMoney(max * f, input.currency), { size: 7, color: MUTED, align: 'right' }); }
    const slot = (right - left) / input.chart.length;
    const bw = Math.max(2, slot * 0.68);
    input.chart.forEach((c, i) => {
      const bh = ((bottom - top) * c.value) / max;
      pdf.rect(left + i * slot + (slot - bw) / 2, bottom - bh, bw, bh, ACCENT);
      if (i % Math.max(1, Math.round(input.chart.length / 8)) === 0 || i === input.chart.length - 1) pdf.text(left + i * slot + slot / 2, bottom + 11, c.label, { size: 7, color: MUTED, align: 'center' });
    });
    y += ch + 8;
  }

  // Body sections from markdown.
  const lines = input.body_md.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const bodySize = 10, lh = 14.5;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i += 1; continue; }
    const h = l.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      ensure(76);
      y += 10;
      pdf.text(M, y + 12, h[1].replace(/\*\*/g, ''), { size: 12.5, bold: true });
      pdf.rect(M, y + 18, 28, 2, ACCENT);
      y += 30;
      i += 1;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim().replace(/\*\*/g, '')); if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells); i += 1; }
      const cols = Math.max(...rows.map((r) => r.length));
      const cw = CW / cols;
      ensure(rows.length * 18 + 10);
      rows.forEach((r, ri) => {
        if (ri === 0) pdf.rect(M, y, CW, 18, PAPER);
        else pdf.line(M, y + 18, M + CW, y + 18, FAINT, 0.4);
        r.forEach((c, ci) => pdf.text(M + ci * cw + (ci === 0 ? 6 : cw - 6), y + 12.5, c, { size: 9, bold: ri === 0, align: ci === 0 ? 'left' : 'right', maxWidth: cw - 12, color: ri === 0 ? MUTED : INK }));
        y += 18;
      });
      y += 8;
      continue;
    }
    if (/^\s*[-*•]\s+/.test(l)) {
      const item = l.replace(/^\s*[-*•]\s+/, '').replace(/\*\*(.+?)\*\*/g, '$1');
      const wrapped = wrap(item, bodySize, CW - 16);
      ensure(wrapped.length * lh + 4);
      pdf.rect(M + 2, y + 4.5, 3.5, 3.5, ACCENT);
      wrapped.forEach((wl, k) => { pdf.text(M + 14, y + 8, wl, { size: bodySize }); y += lh; void k; });
      y += 2;
      i += 1;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*[-*•]\s|\s*\|)/.test(lines[i])) { para.push(lines[i]); i += 1; }
    const wrapped = wrap(para.join(' ').replace(/\*\*(.+?)\*\*/g, '$1'), bodySize, CW);
    ensure(wrapped.length * lh + 6);
    wrapped.forEach((wl) => { pdf.text(M, y + 8, wl, { size: bodySize }); y += lh; });
    y += 6;
  }
  if (input.footer_note) { ensure(40); y += 10; pdf.line(M, y, W - M, y, FAINT, 0.5); y = pdf.paragraph(M, y + 16, CW, input.footer_note, { size: 8.5, color: MUTED }); }
  footer();
  return pdf.build();
}
