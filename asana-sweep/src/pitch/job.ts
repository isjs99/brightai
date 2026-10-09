import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Queries } from '../db/queries.js';
import type { Lead, Pitch, PitchJobStatus } from '../sweep/types.js';
import { liveEvents } from '../live/events.js';
import { log } from '../logger.js';
import { buildDeck, DEFAULT_BRIEF } from './deck.js';
import { pitchDir, renderDeck } from './brightform.js';
import { htmlToPdf, pdfConfigured } from './pdf.js';
import { researchPitch, type ResearchDeps } from './research.js';

/**
 * "Build the pitch" as one run in the background: the research (site scan, images, TikTok Shop, Cruva,
 * the context on record), the deck copy (template, then Claude), and the PDF. One run per pitch at a
 * time; the page follows the step through the live event stream.
 */

export interface PitchJobDeps { research?: typeof researchPitch; build?: typeof buildDeck; pdf?: ((html: string) => Promise<Buffer>) | null; researchDeps?: ResearchDeps }

export class PitchJob {
  private jobs = new Map<number, PitchJobStatus>();
  constructor(private q: Queries, private deps: PitchJobDeps = {}) {}

  state(id: number): PitchJobStatus | null { return this.jobs.get(id) ?? null; }

  /** The PDF file for a pitch, when one was rendered for the current deck. */
  pdfPath(p: Pitch): string | null {
    const file = join(pitchDir(p.id), 'deck.pdf');
    if (!existsSync(file) || !p.deck) return null;
    return statSync(file).mtime.toISOString() >= p.updated_at ? file : null;
  }

  start(id: number, opts: { research?: boolean; build?: boolean; pdf?: boolean; use_llm?: boolean } = {}): PitchJobStatus {
    const cur = this.jobs.get(id);
    if (cur?.running) return cur;
    const st: PitchJobStatus = { running: true, step: opts.research === false ? (opts.build === false ? 'pdf' : 'build') : 'research', started_at: new Date().toISOString(), finished_at: null, error: null };
    this.jobs.set(id, st);
    void this.work(id, st, { research: opts.research !== false, build: opts.build !== false, pdf: opts.pdf !== false, use_llm: opts.use_llm !== false });
    return st;
  }

  private emit(p: Pitch | null): void { liveEvents.emitUpdate({ kind: 'pitch' }); if (p?.prospect_id) liveEvents.emitUpdate({ kind: 'bd' }); }

  private async work(id: number, st: PitchJobStatus, opts: { research: boolean; build: boolean; pdf: boolean; use_llm: boolean }): Promise<void> {
    let p = this.q.getPitch(id);
    try {
      if (!p) throw new Error('Pitch not found');
      this.emit(p);
      if (opts.research) {
        st.step = 'research'; this.emit(p);
        const lead: Lead | null = p.lead_id ? this.q.listLeads(true).find((l) => l.id === p!.lead_id) ?? null : null;
        const prospect = p.prospect_id ? this.q.getProspect(p.prospect_id) : null;
        const dir = pitchDir(id); mkdirSync(dir, { recursive: true });
        const research = await (this.deps.research ?? researchPitch)(this.q, p.brief, lead, { ...(this.deps.researchDeps ?? {}), sellerId: prospect?.seller_id ?? null, assetDir: dir });
        const brief = { ...p.brief };
        // The site's colours become the brand colours when the brief still carries the defaults.
        const found = (research.site?.colours ?? []).filter((c) => /^#[0-9a-f]{6}$/i.test(c));
        if (found[0] && brief.colours.primary === DEFAULT_BRIEF.colours.primary) brief.colours = { ...brief.colours, primary: found[0].toLowerCase() };
        if (found[1] && brief.colours.secondary === DEFAULT_BRIEF.colours.secondary) brief.colours = { ...brief.colours, secondary: found[1].toLowerCase() };
        if (!brief.pdp_images.length && research.products.some((x) => x.image)) brief.pdp_images = research.products.map((x) => x.image).filter((x): x is string => Boolean(x)).slice(0, 12);
        if (!brief.logo_url && research.site?.logo) brief.logo_url = research.site.logo;
        p = this.q.updatePitch(id, { research, brief })!;
        this.emit(p);
      }
      if (opts.build) {
        st.step = 'build'; this.emit(p);
        const deck = await (this.deps.build ?? buildDeck)(this.q, p.brief, p.research, p.deck, opts.use_llm ? undefined : null);
        p = this.q.updatePitch(id, { deck, status: 'ready' })!;
        this.emit(p);
      }
      if (opts.pdf && p.deck && (this.deps.pdf !== undefined ? this.deps.pdf !== null : pdfConfigured())) {
        st.step = 'pdf'; this.emit(p);
        await this.renderPdf(p);
      }
      st.error = null;
    } catch (err) {
      st.error = (err as Error).message.slice(0, 400);
      log.warn(`Pitch ${id}: ${st.error}`);
    } finally {
      st.running = false; st.step = null; st.finished_at = new Date().toISOString();
      this.emit(p);
    }
  }

  /** Render (or re-render) the PDF for the pitch's current deck; the file sits next to its images. */
  async renderPdf(p: Pitch): Promise<string> {
    const html = renderDeck(p, { inline: true });
    const pdf = await (this.deps.pdf ?? htmlToPdf)(html);
    const dir = pitchDir(p.id); mkdirSync(dir, { recursive: true });
    const file = join(dir, 'deck.pdf');
    writeFileSync(file, pdf);
    return file;
  }
}
