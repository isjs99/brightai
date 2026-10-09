import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Deck to PDF through headless Chromium's own print-to-pdf: no browser driver, no extra package. The deck's
 * print stylesheet sets the page to 1280 x 720 with no margins, so one slide is one page. Chromium is found
 * from PITCH_CHROMIUM, the usual Linux and macOS locations, or a Playwright browser folder; without one the
 * deck still opens as HTML and prints from the browser.
 */

export function chromiumPath(): string | null {
  const env = process.env.PITCH_CHROMIUM?.trim();
  if (env && existsSync(env)) return env;
  const fixed = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/snap/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  for (const p of fixed) if (existsSync(p)) return p;
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() || join(process.env.HOME ?? '', '.cache/ms-playwright');
  try {
    for (const d of readdirSync(pw)) {
      if (!/^chromium-\d+$/.test(d)) continue;
      for (const c of [join(pw, d, 'chrome-linux/chrome'), join(pw, d, 'chrome-linux64/chrome'), join(pw, d, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium')]) if (existsSync(c)) return c;
    }
  } catch { /* no Playwright browsers */ }
  return null;
}

export const pdfConfigured = (): boolean => Boolean(chromiumPath());

export async function htmlToPdf(html: string, opts: { timeoutMs?: number; chromium?: string | null } = {}): Promise<Buffer> {
  const bin = opts.chromium ?? chromiumPath();
  if (!bin) throw new Error('No Chromium on this server: set PITCH_CHROMIUM to a Chromium or Chrome binary (the Docker image installs one).');
  const dir = mkdtempSync(join(tmpdir(), 'bf-pitch-'));
  const src = join(dir, 'deck.html'), out = join(dir, 'deck.pdf');
  writeFileSync(src, html);
  const args = ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--run-all-compositor-stages-before-draw', '--virtual-time-budget=12000', '--no-pdf-header-footer', `--print-to-pdf=${out}`, `--user-data-dir=${join(dir, 'profile')}`, `file://${src}`];
  try {
    await new Promise<void>((resolve, reject) => execFile(bin, args, { timeout: opts.timeoutMs ?? 90000, maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => (err ? reject(new Error(`Chromium: ${err.message}${stderr ? ` ${String(stderr).slice(0, 300)}` : ''}`)) : resolve())));
    if (!existsSync(out)) throw new Error('Chromium produced no PDF.');
    return readFileSync(out);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
