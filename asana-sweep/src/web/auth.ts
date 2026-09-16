import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

/**
 * Auth layer. Kept behind a small interface so it can be swapped for real multi-user auth
 * later (e.g. when this module is mounted inside the agency dashboard).
 */
export interface AuthProvider {
  /** Attempt a login from the request body. Returns true and sets the session on success. */
  login(req: Request, res: Response): boolean;
  logout(res: Response): void;
  isAuthenticated(req: Request): boolean;
}

const COOKIE = 'sweep_session';
const SESSION_DAYS = 30;

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function sign(payload: string): string {
  return createHmac('sha256', config.sessionSecret).update(payload).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export class SharedPasswordAuth implements AuthProvider {
  login(req: Request, res: Response): boolean {
    const password = String((req.body as { password?: unknown })?.password ?? '');
    if (!password || !safeEqual(password, config.dashboardPassword)) return false;
    const expires = Date.now() + SESSION_DAYS * 86400000;
    const payload = `ok.${expires}`;
    res.cookie(COOKIE, `${payload}.${sign(payload)}`, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.publicUrl.startsWith('https://'),
      maxAge: SESSION_DAYS * 86400000,
      path: '/',
    });
    return true;
  }

  logout(res: Response): void {
    res.clearCookie(COOKIE, { path: '/' });
  }

  isAuthenticated(req: Request): boolean {
    const raw = parseCookies(req.headers.cookie)[COOKIE];
    if (!raw) return false;
    const [ok, expires, sig] = raw.split('.');
    if (ok !== 'ok' || !expires || !sig) return false;
    if (Number(expires) < Date.now()) return false;
    return safeEqual(sig, sign(`${ok}.${expires}`));
  }
}

export function requireAuth(auth: AuthProvider) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (auth.isAuthenticated(req)) return next();
    res.status(401).json({ error: 'Not logged in' });
  };
}
