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

export type Role = 'admin' | 'am';

/**
 * Two shared passwords: DASHBOARD_PASSWORD signs in as admin (can change settings),
 * AM_PASSWORD signs in as account manager (read only). The role is baked into the signed cookie.
 */
export class SharedPasswordAuth implements AuthProvider {
  login(req: Request, res: Response): boolean {
    const password = String((req.body as { password?: unknown })?.password ?? '');
    if (!password) return false;
    let role: Role | null = null;
    if (safeEqual(password, config.dashboardPassword)) role = 'admin';
    else if (config.amPassword && safeEqual(password, config.amPassword)) role = 'am';
    if (!role) return false;
    const expires = Date.now() + SESSION_DAYS * 86400000;
    const payload = `ok.${role}.${expires}`;
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

  roleOf(req: Request): Role | null {
    const raw = parseCookies(req.headers.cookie)[COOKIE];
    if (!raw) return null;
    const [ok, role, expires, sig] = raw.split('.');
    if (ok !== 'ok' || (role !== 'admin' && role !== 'am') || !expires || !sig) return null;
    if (Number(expires) < Date.now()) return null;
    return safeEqual(sig, sign(`${ok}.${role}.${expires}`)) ? role : null;
  }

  isAuthenticated(req: Request): boolean {
    return this.roleOf(req) !== null;
  }
}

export function requireAuth(auth: AuthProvider) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (auth.isAuthenticated(req)) return next();
    res.status(401).json({ error: 'Not logged in' });
  };
}

/** Writes account managers may make with the view-only login: ticking their own checklist. */
export const AM_WRITABLE = [/^\/checklists\/tick(-all)?$/];

/** Anything that changes state is admin only. Account managers get read access, plus the checklist ticks. */
export function requireAdminForWrites(auth: SharedPasswordAuth) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const role = auth.roleOf(req);
    if (role === 'admin') return next();
    if (role === 'am' && req.method === 'POST' && AM_WRITABLE.some((re) => re.test(req.path))) return next();
    res.status(403).json({ error: 'Admin only. Account managers have view access; ask an admin to make this change.' });
  };
}
