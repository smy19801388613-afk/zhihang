import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && [0,2].includes(c) || b === 88 && c === 99) || a === 100 && b >= 64 && b <= 127 || a === 198 && ([18,19].includes(b) || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) !== 6) return false;
  const [first, second] = address.toLowerCase().split(':').map(part => parseInt(part || '0', 16));
  // Global unicast only; exclude special-purpose, documentation and 6to4 ranges.
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002
    && !(first === 0x2001 && (second < 0x0200 || second === 0x0db8))
    && !(first === 0x3fff && second <= 0x0fff);
}
export function publicHttpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
    || url.hostname === 'localhost' || url.hostname.endsWith('.local') || url.hostname.endsWith('.localhost')
    || isIP(url.hostname.replace(/^\[|\]$/g, '')) && !isPublicAddress(url.hostname.replace(/^\[|\]$/g, ''))) throw new Error('只能读取公开的 HTTPS 网页。');
  url.hash = '';
  return url;
}
export interface FetchedPage { url: string; html: string }
/** Resolve and pin the public destination per request, including redirects. No cookies or browser sessions. */
export async function fetchResearchPage(value: string, signal: AbortSignal): Promise<FetchedPage> {
  let url = publicHttpsUrl(value);
  for (let hop = 0; hop < 4; hop++) {
    signal.throwIfAborted();
    const records = await Promise.race([
      lookup(url.hostname, { all: true }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('来源域名解析超时。')), 5000);
        timer.unref();
      }),
    ]);
    signal.throwIfAborted();
    if (!records.length || records.some(r => !isPublicAddress(r.address))) throw new Error('来源不是公开网络地址。');
    const address = records.find(r => r.family === 4) || records[0];
    const response = await new Promise<{ status: number; location?: string; type: string; body: Buffer }>((resolve, reject) => {
      const req = https.get(url, {
        signal, timeout: 10000,
        headers: { 'User-Agent': 'Zhihang-CompanyResearch/0.5 (public pages; no account access)', Accept: 'text/html,application/xhtml+xml', 'Accept-Encoding': 'identity' },
        lookup: ((_hostname: unknown, options: { all?: boolean }, callback: (...args: unknown[]) => void) => options.all ? callback(null, [address]) : callback(null, address.address, address.family)) as never,
      }, res => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) { res.destroy(); resolve({ status, location: res.headers.location, type: '', body: Buffer.alloc(0) }); return; }
        const type = String(res.headers['content-type'] || '');
        if (status !== 200 || !/text\/html|application\/xhtml/i.test(type)) { res.destroy(); reject(new Error(`来源暂不可读（HTTP ${status}，仅支持网页正文）。`)); return; }
        if (Number(res.headers['content-length']) > 1_500_000) { res.destroy(); reject(new Error('来源网页超过读取大小限制。')); return; }
        const buffers: Buffer[] = []; let length = 0;
        res.on('data', (chunk: Buffer) => { length += chunk.length; if (length > 1_500_000) { res.destroy(); reject(new Error('来源网页超过读取大小限制。')); } else buffers.push(chunk); });
        res.on('error', reject);
        res.on('end', () => resolve({ status, type, body: Buffer.concat(buffers) }));
      });
      req.on('timeout', () => req.destroy(new Error('读取来源超时。')));
      req.on('error', reject);
    });
    if (response.status >= 300 && response.status < 400) {
      if (!response.location) throw new Error('来源重定向缺少地址。');
      url = publicHttpsUrl(new URL(response.location, url).href); continue;
    }
    return { url: url.href, html: new TextDecoder(/charset\s*=\s*["']?gb/i.test(response.type) ? 'gb18030' : 'utf-8').decode(response.body) };
  }
  throw new Error('来源网页重定向过多。');
}
