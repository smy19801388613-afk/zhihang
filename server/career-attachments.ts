import { randomUUID } from 'node:crypto';
import type { CareerAttachment, CareerChatContext } from '../shared/types.ts';
import { parseResumeFile, type ResumeFileInput } from './resume-import.ts';

export const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
type Stored = { meta: CareerAttachment; dataUrl?: string; expiresAt: number };
const badImage = () => new Error('图片文件结构不完整或格式损坏，请重新导出为 PNG、JPEG 或静态 WebP。');
function checkImageSize(width: number, height: number) {
  if (!width || !height) throw badImage();
  if (width > 8192 || height > 8192 || width * height > 32_000_000) throw new Error('图片尺寸过大，请缩小到 8192 像素以内且总像素不超过 3200 万。');
}
// Inspect bounded headers and container structure without decoding image pixels.
// JPEG SOFn layout: https://www.w3.org/Graphics/JPEG/jfif.pdf
function checkJpeg(buffer: Buffer) {
  if (buffer.length < 20 || buffer.readUInt16BE(buffer.length - 2) !== 0xffd9) throw badImage();
  let offset = 2, frame = false;
  while (offset < buffer.length - 2) {
    if (buffer[offset++] !== 0xff) throw badImage();
    while (buffer[offset] === 0xff) offset++;
    if (offset >= buffer.length - 2) throw badImage();
    const marker = buffer[offset++];
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || marker >= 0xd0 && marker <= 0xd7) throw badImage();
    if (marker === 0x01) continue;
    if (offset + 2 > buffer.length - 2) throw badImage();
    const size = buffer.readUInt16BE(offset);
    if (size < 2 || offset + size > buffer.length - 2) throw badImage();
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (frame || size < 8) throw badImage();
      const components = buffer[offset + 7];
      if (components < 1 || components > 4 || size !== 8 + components * 3) throw badImage();
      checkImageSize(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3));
      frame = true;
    }
    if (marker === 0xda) {
      const components = buffer[offset + 2];
      if (!frame || size < 6 || components < 1 || components > 4 || size !== 6 + components * 2 || offset + size >= buffer.length - 2) throw badImage();
      return; // Entropy decoding is delegated to the image-capable provider.
    }
    offset += size;
  }
  throw badImage();
}
// RIFF/VP8X and VP8L layouts: https://developers.google.com/speed/webp/docs/riff_container
// VP8 key frame header: https://www.rfc-editor.org/rfc/rfc6386#section-9.1
function checkWebp(buffer: Buffer) {
  if (buffer.length < 26 || buffer.readUInt32LE(4) + 8 !== buffer.length) throw badImage();
  let offset = 12, canvas: [number, number] | undefined, image = false;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw badImage();
    const kind = buffer.toString('ascii', offset, offset + 4), size = buffer.readUInt32LE(offset + 4), start = offset + 8;
    const end = start + size, paddedEnd = end + (size % 2);
    if (paddedEnd > buffer.length || size % 2 && buffer[end] !== 0) throw badImage();
    if (offset === 12 && !['VP8X', 'VP8 ', 'VP8L'].includes(kind)) throw badImage();
    if (kind === 'ANIM' || kind === 'ANMF') throw new Error('暂不支持动态 WebP，请先另存为静态图片后上传。');
    if (kind === 'VP8X') {
      if (offset !== 12 || size !== 10 || buffer[start] & 0xc1 || buffer.readUIntLE(start + 1, 3)) throw badImage();
      if (buffer[start] & 0x02) throw new Error('暂不支持动态 WebP，请先另存为静态图片后上传。');
      canvas = [buffer.readUIntLE(start + 4, 3) + 1, buffer.readUIntLE(start + 7, 3) + 1];
      checkImageSize(...canvas);
    }
    if (kind === 'VP8 ' || kind === 'VP8L') {
      if (image) throw badImage();
      let width: number, height: number;
      if (kind === 'VP8 ') {
        if (size < 11 || buffer[start] & 1 || buffer.readUIntLE(start + 3, 3) !== 0x2a019d) throw badImage();
        width = buffer.readUInt16LE(start + 6) & 0x3fff; height = buffer.readUInt16LE(start + 8) & 0x3fff;
      } else {
        if (size < 6 || buffer[start] !== 0x2f) throw badImage();
        const bits = buffer.readUInt32LE(start + 1);
        if (bits >>> 29) throw badImage();
        width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
      }
      checkImageSize(width, height);
      if (canvas && (canvas[0] !== width || canvas[1] !== height)) throw badImage();
      image = true;
    }
    offset = paddedEnd;
  }
  if (!image || offset !== buffer.length) throw badImage();
}
export function imageType(buffer: Buffer): string | undefined {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    if (buffer.length < 33 || buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') throw badImage();
    checkImageSize(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
    return 'image/png';
  }
  if (buffer.length >= 2 && buffer[0] === 255 && buffer[1] === 216) { checkJpeg(buffer); return 'image/jpeg'; }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') { checkWebp(buffer); return 'image/webp'; }
  return undefined;
}

/** Pending uploads are memory-only, expire, and never become confirmed profile facts. */
export class CareerAttachments {
  private pending = new Map<string, Stored>();
  private reservedCount = 0;
  private reservedBytes = 0;
  private epoch = 0;
  constructor(private now = () => Date.now()) {}
  private prune() { for (const [id, item] of this.pending) if (item.expiresAt <= this.now()) this.pending.delete(id); }
  async add(file: ResumeFileInput, imageEnabled: boolean): Promise<CareerAttachment> {
    this.prune();
    if (!file.buffer.length || file.buffer.length > ATTACHMENT_MAX_BYTES) throw new Error('每个附件应为 1 字节至 8 MB。');
    if (this.pending.size + this.reservedCount >= 24 || [...this.pending.values()].reduce((n, item) => n + item.meta.size, 0) + this.reservedBytes + file.buffer.length > 64 * 1024 * 1024) throw new Error('暂存附件过多，请先移除附件或发送后再上传。');
    this.reservedCount++; this.reservedBytes += file.buffer.length;
    const epoch = this.epoch;
    try {
    const type = imageType(file.buffer);
    const id = randomUUID(), name = file.name.replace(/[\x00-\x1f]/g, '').slice(0, 200);
    let meta: CareerAttachment, dataUrl: string | undefined;
    if (type) {
      if (!imageEnabled) throw new Error('当前模型未启用图片理解，请在模型设置使用 DeepSeek 的 deepseek-flash，或上传 PDF、DOCX、TXT 文字文件。');
      meta = { id, name, kind: 'image', size: file.buffer.length };
      dataUrl = `data:${type};base64,${file.buffer.toString('base64')}`;
    } else {
      if (!/\.(pdf|docx|txt)$/i.test(name)) throw new Error('支持 PDF、DOCX、TXT、PNG、JPEG、WebP；图片必须是有效图像文件。');
      const parsed = await parseResumeFile(file);
      meta = { id, name, kind: 'document', size: file.buffer.length, text: parsed.text };
    }
    if (epoch !== this.epoch) throw new Error('上传期间聊天已清空，请在新对话中重新上传。');
    this.pending.set(id, { meta, dataUrl, expiresAt: this.now() + 30 * 60 * 1000 });
    return structuredClone(meta);
    } finally { this.reservedCount--; this.reservedBytes -= file.buffer.length; }
  }
  resolve(ids: string[]): { context: NonNullable<CareerChatContext['attachments']>; meta: CareerAttachment[] } {
    this.prune();
    if (ids.length > 3 || new Set(ids).size !== ids.length) throw new Error('每轮最多使用 3 个不同附件。');
    const entries = ids.map(id => { const entry = this.pending.get(id); if (!entry) throw new Error('附件已过期或服务已重启，请重新上传后发送。'); return entry; });
    if (entries.reduce((sum, entry) => sum + (entry.meta.text?.length || 0), 0) > 45000) throw new Error('本轮文件文字超过 45,000 字，请分批发送。');
    return { context: entries.map(({ meta, dataUrl }) => ({ name: meta.name, kind: meta.kind, text: meta.text, dataUrl })), meta: entries.map(({ meta }) => structuredClone(meta)) };
  }
  remove(id: string) { this.pending.delete(id); }
  clear() { this.epoch++; this.pending.clear(); }
}
