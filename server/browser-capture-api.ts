import express from 'express';
import { z, ZodError } from 'zod';
import { BrowserConnections, ConnectionError, EXTENSION_ORIGIN } from './browser-connections.ts';
import { captureBatchSchema } from './validation.ts';
import type { Workflow } from './workflow.ts';

const pairSchema = z.object({ code: z.string().trim().max(32), clientName: z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/u) }).strict();
const managementMethods: Record<string, string[]> = { '/pair': ['POST'], '/status': ['POST'], '/connection': ['DELETE'], '/import': ['POST'] };
function limiter(limit: number, windowMs: number) {
  const buckets = new Map<string, { start: number; count: number }>();
  return (key: string) => {
    const now = Date.now();
    for (const [id, bucket] of buckets) if (now - bucket.start >= windowMs) buckets.delete(id);
    const bucket = buckets.get(key) || { start: now, count: 0 };
    buckets.set(key, bucket);
    if (++bucket.count > limit) throw new ConnectionError('请求过于频繁，请稍后重试。', 429);
  };
}
/** Mount only under /extension/v1, before the general API same-origin gate. */
export function extensionCaptureRouter(connections: BrowserConnections, workflow: Workflow, assertIdle: () => void) {
  const router = express.Router();
  const pairLimit = limiter(12, 5 * 60_000); const importLimit = limiter(60, 60_000);
  router.use((req, res, next) => {
    const origin = req.get('origin') || '';
    const methods = managementMethods[req.path];
    if (!EXTENSION_ORIGIN.test(origin) || !methods) return res.status(403).json({ error: '仅接受已安装扩展的专用采集请求。' });
    res.setHeader('Access-Control-Allow-Origin', origin); res.vary('Origin');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
      const method = req.get('access-control-request-method') || '';
      const headers = (req.get('access-control-request-headers') || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
      if (!methods.includes(method) || headers.some(x => !['authorization', 'content-type'].includes(x))) return res.status(403).json({ error: '请求方法或头部不受支持。' });
      res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      if (req.get('access-control-request-private-network') === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
      return res.status(204).end();
    }
    if (!methods.includes(req.method)) return res.status(405).json({ error: '请求方法不受支持。' });
    if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ error: '采集请求必须为 JSON。' });
    next();
  });
  router.use(express.json({ limit: '512kb', strict: true }));
  router.post('/pair', (req, res) => {
    pairLimit('all-pair-attempts');
    const input = pairSchema.parse(req.body);
    res.json(connections.pair(input.code, req.get('origin')!, input.clientName));
  });
  router.use((req, res, next) => {
    const header = req.get('authorization') || '';
    const match = header.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
    const connection = connections.authorize(match?.[1] || '', req.get('origin')!);
    res.locals.connection = connection;
    next();
  });
  // Chromium omits Origin on privileged extension GETs; POST keeps the origin check strict.
  router.post('/status', (_req, res) => res.json({ connected: true, connectionId: res.locals.connection.id, expiresAt: res.locals.connection.expiresAt }));
  router.delete('/connection', (_req, res) => { connections.revoke(res.locals.connection.id); res.json({ revoked: true }); });
  router.post('/import', async (req, res) => {
    importLimit(res.locals.connection.id); assertIdle();
    const batch = captureBatchSchema.parse(req.body);
    const result = await workflow.importBrowserCaptures(batch);
    connections.used(res.locals.connection.id);
    res.json(result);
  });
  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ZodError) return res.status(400).json({ error: error.issues.some(issue => issue.path[0] === 'jobs' && issue.path.at(-1) === 'platform') ? '当前仅支持 BOSS直聘岗位导入，请更新扩展后重试。' : '岗位字段、数量或格式不符合要求，请检查预览后重试。', fields: error.issues.slice(0, 6).map(issue => issue.path.join('.')) });
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') return res.status(413).json({ error: '本次导入超过 512 KB，请减少岗位数量或 JD 长度。' });
    if (error instanceof SyntaxError) return res.status(400).json({ error: '无法读取采集数据，请重新预览。' });
    const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 500;
    return res.status(status >= 400 && status < 600 ? status : 500).json({ error: status >= 500 ? '本机导入暂未完成，请保留预览并重试。' : error instanceof Error ? error.message : '请求未完成。' });
  });
  return router;
}
