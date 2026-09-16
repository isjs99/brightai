import { createContext, useContext } from 'react';

export type Role = 'admin' | 'am';

export interface Session {
  role: Role;
}

export const SessionContext = createContext<Session>({ role: 'admin' });

export function useSession(): Session {
  return useContext(SessionContext);
}

export function useIsAdmin(): boolean {
  return useContext(SessionContext).role === 'admin';
}

/** Renders children only for admins. Account managers get view access. */
export function AdminOnly({ children }: { children: React.ReactNode }) {
  return useIsAdmin() ? <>{children}</> : null;
}
