import { describe, expect, it } from 'vitest';
import { Queries } from '../src/db/queries';
import { openTestDb } from '../src/db/index';
import { ClientReports, cruvaReportData, localParts, periodBounds, reportContext, scheduleDue, slackDraftFor } from '../src/reports/client';
import { Pdf, reportPdf, wrap } from '../src/reports/pdf';
import { syncStatus } from '../src/scheduler/sync-status';
import { renderInternalPrompt, templateInternal, withSlack } from '../src/copilot/index';
import type { CopilotQuestion } from '../src/sweep/types';

const acct = (q: Queries) => q.createAccount({ name: 'Nutori', markets: 'ES', am_name: 'Ana', aa_name: null, enabled: true, notes: null, commission_pct: null, commission_basis: 'gmv', settlement_pct: 100, slack_channel: null, client_slack_channel: '#ext-nutori', client_domain: 'nutori.com' });

describe('report queue and schedules', () => {
  it('knows the local weekday and when a schedule is due', () => {
    const tz = 'Europe/Madrid';
    const mon0905 = new Date('2026-10-05T07:05:00Z'); // 09:05 CEST
    expect(localParts(mon0905, tz)).toMatchObject({ weekday: 1, hour: 9, minute: 5, date: '2026-10-05' });
    const s = { account_id: 1, enabled: true, weekday: 1, hour: 9, minute: 0, period: 'weekly' as const, kind: 'standard' as const, autosend: false, pdf: true, last_generated_at: null, updated_at: null };
    expect(scheduleDue(s, mon0905, tz)).toBe(true);
    expect(scheduleDue(s, new Date('2026-10-05T06:30:00Z'), tz)).toBe(false); // 08:30, too early
    expect(scheduleDue(s, new Date('2026-10-06T07:05:00Z'), tz)).toBe(false); // Tuesday
    expect(scheduleDue({ ...s, last_generated_at: '2026-10-05T07:01:00Z' }, mon0905, tz)).toBe(false); // already done today
    expect(scheduleDue({ ...s, enabled: false }, mon0905, tz)).toBe(false);
  });

  it('generates a scheduled report into the queue and autosends approved ones at their time', async () => {
    const q = new Queries(openTestDb());
    const a = acct(q);
    q.addShop(a.id, 'cruva-n', 'Nutori ES', 'EUR', 'cruva');
    q.upsertGmv([{ shop_id: 'cruva-n', date: '2026-09-29', total_gmv: 1000, affiliate_gmv: 400, units: 40 }, { shop_id: 'cruva-n', date: '2026-10-01', total_gmv: 800, affiliate_gmv: 300, units: 30 }]);
    const posts: { channel: string; text: string }[] = [];
    const uploads: string[] = [];
    const slack = { configured: true, channelId: async (n: string) => n, post: async (channel: string, text: string) => { posts.push({ channel, text }); return { ts: '1', channel }; }, uploadFile: async (_c: string, f: { filename: string }) => { uploads.push(f.filename); return { file_id: 'F1' }; } } as never;
    const reports = new ClientReports(q, { slack, llm: null, tldv: { configured: false } as never, tts: { configured: false } as never });
    q.saveReportSchedule(a.id, { enabled: true, weekday: 1, hour: 9, minute: 0, period: 'weekly', kind: 'standard', autosend: false, pdf: true });
    const r1 = await reports.tick(new Date('2026-10-05T07:05:00Z'));
    expect(r1.generated).toBe(1);
    expect(r1.sent).toBe(0);
    const queued = q.listReports();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: 'draft', kind: 'standard', period_start: '2026-09-28', period_end: '2026-10-04' });
    expect(queued[0].slack_draft).toContain('*');
    expect(slackDraftFor(queued[0])).toBe(queued[0].slack_draft);
    // Same tick again: not generated twice.
    expect((await reports.tick(new Date('2026-10-05T07:30:00Z'))).generated).toBe(0);
    // Approve with an autosend time: nothing before it, sent after it, with the PDF.
    reports.approve(queued[0].id, 'Isaac', '2026-10-05T10:00:00.000Z');
    expect((await reports.tick(new Date('2026-10-05T09:00:00Z'))).sent).toBe(0);
    expect((await reports.tick(new Date('2026-10-05T10:01:00Z'))).sent).toBe(1);
    expect(q.getReport(queued[0].id)).toMatchObject({ status: 'sent', slack_channel: '#ext-nutori' });
    expect(posts[0].channel).toBe('#ext-nutori');
    expect(uploads[0]).toMatch(/^Brightform_Nutori_.*\.pdf$/);
    // Autosend schedules go straight out.
    q.saveReportSchedule(a.id, { autosend: true, kind: 'cruva' });
    const r2 = await reports.tick(new Date('2026-10-12T07:05:00Z'));
    expect(r2).toMatchObject({ generated: 1, sent: 1 });
    expect(q.listReports().find((r) => r.kind === 'cruva')?.status).toBe('sent');
  });

  it('builds the Cruva side of a report from the stored pull rows and the client context from the evidence', () => {
    const q = new Queries(openTestDb());
    const a = acct(q);
    q.addShop(a.id, 'cruva-n', 'Nutori ES', 'EUR', 'cruva');
    const day = (date: string, gmv: number) => ({ date, total_gmv: gmv, affiliate_gmv: gmv / 2, units: 10, affiliate_units: 5, videos: 3, views: 1000, dms: 20, samples_approved: 4, samples_shipped: 2, aov: 20 });
    q.upsertHealthPull({ shop_id: 'cruva-n', account_id: a.id, source: 'cruva', pull_date: '2026-10-05', ok: true, error: null, metrics: { sps: 7.5 }, rows: { days: [day('2026-09-25', 100), day('2026-09-30', 200), day('2026-10-02', 300)] } });
    const bounds = periodBounds('weekly', '2026-10-04');
    const c = cruvaReportData(q, q.getAccount(a.id)!, bounds)!;
    expect(c.totals).toMatchObject({ gmv: 500, affiliate_gmv: 250, videos_posted: 6, dms_sent: 40, samples_shipped: 4 });
    expect(c.prev_totals.gmv).toBe(100);
    expect(c.shops[0].sps).toBe(7.5);
    expect(c.daily.map((d) => d.date)).toEqual(['2026-09-30', '2026-10-02']);
    q.upsertEvidence([{ account_id: a.id, kind: 'slack', ref: 'C:2026-10-01', title: 'Slack #ext-nutori on 2026-10-01', text: 'marta: can we push the launch to the 15th?', occurred_at: '2026-10-01T12:00:00.000Z' }, { account_id: a.id, kind: 'email', ref: 'm1', title: 'Email: Launch timing', text: 'Hi, about the launch…', occurred_at: '2026-09-20T12:00:00.000Z' }]);
    const ctx = reportContext(q, q.getAccount(a.id)!, bounds)!;
    expect(ctx.slack).toHaveLength(1);
    expect(ctx.emails).toHaveLength(0); // outside the period
  });

  it('writes a valid PDF with the report layout', () => {
    const buf = reportPdf({ account: 'Nutori', title: 'Nutori: weekly report 28 Sep to 4 Oct', period_label: 'Week 2026-09-28 to 2026-10-04', prepared_by: 'Ana', currency: 'EUR', kpis: [{ label: 'Total GMV', value: 'EUR 12,400', delta: '+12% vs previous', up: true }, { label: 'Affiliate GMV', value: 'EUR 6,100' }], chart: [{ label: '09-28', value: 1000 }, { label: '09-29', value: 1400 }, { label: '09-30', value: 900 }], chart_title: 'Daily GMV', body_md: 'Headline paragraph with **bold** text and a long sentence that keeps going so the wrapper has to break it over more than one line in the page.\n\n## The numbers\n| Metric | This | Prev |\n|---|---|---|\n| GMV | 12,400 | 11,000 |\n\n## What we did\n- Shot new creative\n- Onboarded 3 creators\n' });
    const s = buf.toString('latin1');
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s).toContain('/Type /Catalog');
    expect(s).toContain('(Brightform.) Tj');
    expect(s.trim().endsWith('%%EOF')).toBe(true);
    expect(wrap('one two three four five six', 10, 60)).toEqual(['one two', 'three four', 'five six']);
    const p = new Pdf();
    for (let i = 0; i < 3; i += 1) p.addPage();
    expect(p.pageCount).toBe(4);
    expect(p.build().toString('latin1')).toContain('/Count 4');
  });

  it('lists what scans when in the team timezone', () => {
    const q = new Queries(openTestDb());
    const s = syncStatus(q, {
      monitor: { last_scan_at: '2026-10-05T07:00:00Z', last_scan_error: null, scanning: false, interval_minutes: 30 },
      health: { configured: true, last_pull_at: null, last_pull_error: null, pulling: false, tts_last_pull_at: null, tts_last_pull_error: null, pulling_tts: false, tts_configured: false },
      cruvaPull: { configured: true, running: false, last_run_at: '2026-10-05T06:00:00Z', last_error: 'x failed' },
      stock: { last_scan_at: null, last_scan_error: null, scanning: false, configured: true },
      playbook: { configured: false, last_check_at: null, last_error: null, checking: false },
      inbox: { configured: true, last_sync_at: null, last_sync_error: null, poll_seconds: 120 },
      copilot: { configured: true, last_index_at: null, last_index_error: null },
      clientTasks: { last_scan_at: null, last_scan_error: null, scanning: false },
      reportsQueue: { last_tick_at: null }, windsor: { configured: true, last_sync_at: null, last_error: null }, tldv: { configured: false, last_check_at: null },
    }, new Date('2026-10-05T07:10:00Z'));
    const by = Object.fromEntries(s.feeds.map((f) => [f.key, f]));
    expect(by.monitor).toMatchObject({ schedule_text: 'Every 30 min', next_run_at: '2026-10-05T07:30:00.000Z' });
    expect(by.cruva).toMatchObject({ schedule_text: 'Every 4 hours', last_error: 'x failed' });
    expect(by.health.schedule_text).toMatch(/^Daily 06:30/);
    expect(by.checklist.schedule_text).toMatch(/^Weekdays 16:00/);
    expect(by.inbox.schedule_text).toBe('Every 2 min');
  });

  it('answers internal questions as a Slack brief', () => {
    const qn: CopilotQuestion = { id: 1, account_id: 1, account_name: 'Nutori', source: 'manual', audience: 'internal', as_of: '2026-10-02', channel: null, thread_ts: null, external_id: null, asked_by: 'Ana', question: 'What did the client ask for?', answer: null, slack_text: null, sources: [], generator: null, status: 'open', created_by: 'Ana', created_at: '', answered_at: null, sent_at: null };
    const p = renderInternalPrompt(qn, null, [{ kind: 'slack', title: 'Slack on 2026-10-01', snippet: 'marta: can we push the launch', url: null, occurred_at: '2026-10-01T12:00:00Z', score: 0.8 }]);
    expect(p.system).toContain('Slack syntax');
    expect(p.user).toContain('[1] SLACK');
    expect(templateInternal(qn, [])).toContain('Nothing on record');
    const t = templateInternal(qn, [{ kind: 'slack', title: 'x', snippet: 'marta: can we push the launch', url: null, occurred_at: '2026-10-01T12:00:00Z', score: 0.8 }]);
    expect(t.startsWith('*What did the client ask for?*')).toBe(true);
    expect(withSlack({ ...qn, audience: 'client', answer: '**Yes** we can [1]' }).slack_text).toBe('*Yes* we can');
    expect(withSlack({ ...qn, answer: t }).slack_text).toContain('•');
  });
});
