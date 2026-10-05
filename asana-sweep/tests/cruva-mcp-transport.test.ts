import { describe, it, expect, afterAll } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { CruvaMcp } from '../src/cruva/mcp';

/**
 * A stand-in for mcp.cruva.com's SSE server: GET /sse needs ?api_key, sets a sticky cookie and hands out
 * a message endpoint WITHOUT the key; POST /messages only knows the session when the cookie and the key
 * come back with it (the real one answers 404 "Could not find session" otherwise).
 */
function fakeCruva(): Promise<{ server: Server; url: string; posts: { path: string; cookie: string | null; key: string | null }[] }> {
  const posts: { path: string; cookie: string | null; key: string | null }[] = [];
  let stream: ServerResponse | null = null;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const key = url.searchParams.get('api_key') ?? req.headers['x-api-key']?.toString() ?? null;
    if (req.method === 'GET' && url.pathname === '/sse') {
      if (key !== 'good-key') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"unauthorized"}'); }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'set-cookie': 'AWSALB=node-7; Path=/' });
      stream = res;
      res.write('event: endpoint\ndata: /messages/?session_id=abc123\n\n');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/messages/') {
      posts.push({ path: url.pathname + url.search, cookie: req.headers.cookie ?? null, key });
      if (!req.headers.cookie?.includes('AWSALB=node-7') || key !== 'good-key' || url.searchParams.get('session_id') !== 'abc123') { res.writeHead(404); return res.end('Could not find session'); }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(202); res.end('Accepted');
        const msg = JSON.parse(body) as { id?: number; method?: string };
        if (msg.method === 'initialize') stream?.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake-cruva', version: '1' } } })}\n\n`);
        if (msg.method === 'tools/call') stream?.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '{"result":"- Shop One (ID: 6a0000000000000000000001, plan: scale)"}' }] } })}\n\n`);
      });
      return;
    }
    // Streamable HTTP endpoints do not exist on this server, like the real one for API keys.
    res.writeHead(404); res.end('not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, posts })));
}

describe('Cruva MCP transport', () => {
  const servers: Server[] = [];
  afterAll(() => { for (const s of servers) s.close(); });

  it('connects over SSE with the key, carries the sticky cookie and the key onto the message posts, and lists shops', async () => {
    const f = await fakeCruva(); servers.push(f.server);
    const mcp = new CruvaMcp('good-key', f.url);
    const r = await mcp.test();
    expect(r.error).toBeNull();
    expect(r.ok).toBe(true);
    expect(r.transport).toBe('SSE ?api_key');
    expect(r.shops).toBe(1);
    expect(f.posts.length).toBeGreaterThan(0);
    expect(f.posts.every((p) => p.cookie?.includes('AWSALB=node-7') && p.key === 'good-key' && p.path.includes('session_id=abc123'))).toBe(true);
    await mcp.close();
  });

  it('names every refused attempt when the key is wrong', async () => {
    const f = await fakeCruva(); servers.push(f.server);
    const mcp = new CruvaMcp('bad-key', f.url);
    const r = await mcp.test();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/refused every connection/);
    expect(r.error).toMatch(/SSE \?api_key: .*401/);
    expect(r.error).toMatch(/HTTP \/mcp x-api-key/);
    await mcp.close();
  });
});
