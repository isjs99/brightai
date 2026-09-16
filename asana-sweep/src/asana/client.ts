import { config } from '../config.js';
import { log } from '../logger.js';
import type { SweepTask } from '../sweep/match.js';

export class AsanaError extends Error {
  constructor(message: string, public status: number | null = null) {
    super(message);
    this.name = 'AsanaError';
  }
}

interface AsanaEnvelope<T> {
  data: T;
  next_page?: { offset: string; path: string; uri: string } | null;
  errors?: { message: string; help?: string }[];
}

export interface AsanaProject {
  gid: string;
  name: string;
  workspace?: { gid: string; name: string };
}

export interface AsanaWorkspace {
  gid: string;
  name: string;
}

interface RawTask {
  gid: string;
  name: string;
  completed: boolean;
  completed_at: string | null;
  num_subtasks?: number;
  memberships?: { project?: { gid: string } | null; section?: { gid: string; name: string } | null }[];
}

const TASK_FIELDS = 'gid,name,completed,completed_at,num_subtasks,memberships.project.gid,memberships.section.name';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Thin Asana REST client on top of fetch. Handles pagination (limit=100, follow next_page.offset)
 * and 429 / 5xx with exponential backoff honouring Retry-After.
 */
export class AsanaClient {
  constructor(private token: string = config.asanaPat, private baseUrl: string = config.asanaBaseUrl) {}

  private ensureToken() {
    if (!this.token) throw new AsanaError('ASANA_PAT is not set. Add it to your .env and restart.');
  }

  async request<T>(method: 'GET' | 'DELETE' | 'POST', path: string, params?: Record<string, string>): Promise<AsanaEnvelope<T>> {
    this.ensureToken();
    const url = new URL(this.baseUrl + path);
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const maxAttempts = 6;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
        });
      } catch (err) {
        if (attempt >= maxAttempts) throw new AsanaError(`Network error talking to Asana: ${(err as Error).message}`);
        await sleep(500 * 2 ** attempt);
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt >= maxAttempts) {
          throw new AsanaError(`Asana returned ${res.status} after ${attempt} attempts for ${method} ${path}`, res.status);
        }
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
        log.warn(`Asana ${res.status} on ${method} ${path}, retrying in ${waitMs}ms (attempt ${attempt})`);
        await sleep(waitMs);
        continue;
      }

      const text = await res.text();
      let body: AsanaEnvelope<T>;
      try {
        body = text ? (JSON.parse(text) as AsanaEnvelope<T>) : ({ data: undefined as unknown as T });
      } catch {
        throw new AsanaError(`Asana returned non-JSON (${res.status}) for ${method} ${path}`, res.status);
      }

      if (!res.ok) {
        const msg = body.errors?.map((e) => e.message).join('; ') || res.statusText;
        if (res.status === 401) throw new AsanaError(`Asana rejected the token (401): ${msg}. Check ASANA_PAT.`, 401);
        if (res.status === 403) throw new AsanaError(`Asana access denied (403): ${msg}. The token may not have access to this project.`, 403);
        if (res.status === 404) throw new AsanaError(`Asana object not found (404): ${msg}. The project may have been deleted or is inaccessible.`, 404);
        throw new AsanaError(`Asana error ${res.status}: ${msg}`, res.status);
      }
      return body;
    }
  }

  async getAll<T>(path: string, params: Record<string, string>): Promise<T[]> {
    const out: T[] = [];
    let offset: string | undefined;
    for (;;) {
      const page = await this.request<T[]>('GET', path, { ...params, limit: '100', ...(offset ? { offset } : {}) });
      out.push(...(page.data ?? []));
      if (page.next_page?.offset) offset = page.next_page.offset;
      else return out;
    }
  }

  async me(): Promise<{ gid: string; name: string }> {
    return (await this.request<{ gid: string; name: string }>('GET', '/users/me', { opt_fields: 'gid,name' })).data;
  }

  async getProject(gid: string): Promise<AsanaProject> {
    return (await this.request<AsanaProject>('GET', `/projects/${gid}`, { opt_fields: 'gid,name,workspace.name' })).data;
  }

  async listWorkspaces(): Promise<AsanaWorkspace[]> {
    return this.getAll<AsanaWorkspace>('/workspaces', { opt_fields: 'gid,name' });
  }

  /** Search projects by name across all workspaces the token can see (typeahead). */
  async searchProjects(query: string): Promise<AsanaProject[]> {
    const workspaces = await this.listWorkspaces();
    const results: AsanaProject[] = [];
    for (const ws of workspaces) {
      const page = await this.request<AsanaProject[]>('GET', `/workspaces/${ws.gid}/typeahead`, {
        resource_type: 'project',
        query,
        count: '20',
        opt_fields: 'gid,name',
      });
      for (const p of page.data ?? []) results.push({ ...p, workspace: { gid: ws.gid, name: ws.name } });
    }
    return results;
  }

  /** All tasks in a project, completed and incomplete, mapped to the section within that project. */
  async listProjectTasks(projectGid: string): Promise<SweepTask[]> {
    const raw = await this.getAll<RawTask>(`/projects/${projectGid}/tasks`, { opt_fields: TASK_FIELDS });
    return raw.map((t) => {
      const membership = (t.memberships ?? []).find((m) => m.project?.gid === projectGid);
      return {
        gid: t.gid,
        name: t.name ?? '',
        completed: Boolean(t.completed),
        completed_at: t.completed_at ?? null,
        section_name: membership?.section?.name ?? null,
        num_subtasks: t.num_subtasks ?? 0,
      };
    });
  }

  async deleteTask(gid: string): Promise<void> {
    await this.request<unknown>('DELETE', `/tasks/${gid}`);
  }
}

export const asana = new AsanaClient();
