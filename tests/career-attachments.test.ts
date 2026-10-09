import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { z } from 'zod';
import { CareerAttachments, imageType } from '../server/career-attachments.ts';
import { createJsonRequester, supportsImageInput } from '../server/model-provider.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lMsAAAAASUVORK5CYII=', 'base64');
// Actual 2×3 solid-color images encoded locally with Pillow, containing no user data.
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDk6KKK9I4D/9k=', 'base64');
const webpLossy = Buffer.from('UklGRjIAAABXRUJQVlA4ICYAAACQAQCdASoCAAMAAUAmJQBOl0AAcwAA/vDXA+KAUjhzvzfY9pgAAA==', 'base64');
const webpLossless = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvAYAAAAdQrfIUr/+BiOh/AAA=', 'base64');
function extendedWebp(width = 2, height = 3, flags = 0) {
  const extended = Buffer.alloc(18); extended.write('VP8X'); extended.writeUInt32LE(10, 4); extended[8] = flags;
  extended.writeUIntLE(width - 1, 12, 3); extended.writeUIntLE(height - 1, 15, 3);
  const output = Buffer.concat([webpLossy.subarray(0, 12), extended, webpLossy.subarray(12)]);
  output.writeUInt32LE(output.length - 8, 4); return output;
}
test('documents are parsed locally, images are content-sniffed and pending attachments expire', async () => {
  let now = 0; const store = new CareerAttachments(() => now);
  const file = await store.add({ name: '岗位.txt', mimeType: 'text/plain', buffer: Buffer.from('岗位职责：整理资料，任职要求：本科在读。') }, false);
  assert.equal(file.kind, 'document'); assert.match(file.text!, /本科在读/);
  await assert.rejects(store.add({ name: 'screen.png', mimeType: 'image/png', buffer: png }, false), /图片理解/);
  const image = await store.add({ name: 'screen.png', mimeType: 'image/png', buffer: png }, true);
  assert.equal(image.kind, 'image'); assert.equal(image.text, undefined);
  assert.match(store.resolve([image.id]).context[0].dataUrl!, /^data:image\/png;base64,/);
  assert.equal(JSON.stringify(image).includes('base64'), false, 'Image payload is not exposed by metadata');
  assert.throws(() => store.resolve([file.id, file.id]), /不同附件/);
  store.remove(image.id); assert.throws(() => store.resolve([image.id]), /过期/);
  now += 31 * 60 * 1000; assert.throws(() => store.resolve([file.id]), /过期/);
});
test('unsupported, oversized, disguised and pixel-bomb attachment inputs are rejected', async () => {
  const store = new CareerAttachments();
  await assert.rejects(store.add({ name: 'a.html', mimeType: 'text/html', buffer: Buffer.from('<script>unsafe</script>') }, true), /支持/);
  await assert.rejects(store.add({ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from('<svg/>') }, true), /有效图像/);
  await assert.rejects(store.add({ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.alloc(8 * 1024 * 1024 + 1) }, true), /8 MB/);
  const huge = Buffer.from(png); huge.writeUInt32BE(100000, 16);
  await assert.rejects(store.add({ name: 'huge.png', mimeType: 'image/png', buffer: huge }, true), /尺寸过大/);
});
test('parallel uploads reserve capacity and clear invalidates in-flight parsing', async () => {
  const store = new CareerAttachments();
  const file = { name: 'test.txt', mimeType: 'text/plain', buffer: Buffer.from('合成岗位资料内容') };
  const results = await Promise.allSettled(Array.from({ length: 25 }, () => store.add(file, false)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 24);
  store.clear();
  const pending = store.add(file, false); store.clear();
  await assert.rejects(pending, /聊天已清空/);
  const fresh = await store.add(file, false); assert.equal(store.resolve([fresh.id]).meta.length, 1);
});
test('JPEG scans real SOF/SOS markers and rejects short, truncated, malformed and oversized frames', () => {
  assert.equal(imageType(jpeg), 'image/jpeg');
  const frame = jpeg.indexOf(Buffer.from([0xff, 0xc0])); assert.ok(frame > 0);
  const extended = Buffer.from(jpeg); extended[frame + 1] = 0xc1; assert.equal(imageType(extended), 'image/jpeg');
  const progressive = Buffer.from(jpeg); progressive[frame + 1] = 0xc2; assert.equal(imageType(progressive), 'image/jpeg');
  for (const bad of [Buffer.from([0xff, 0xd8, 0xff, 0]), jpeg.subarray(0, jpeg.length - 2)]) assert.throws(() => imageType(bad), /结构不完整|损坏/u);
  const wrongSegment = Buffer.from(jpeg); wrongSegment.writeUInt16BE(65535, 4); assert.throws(() => imageType(wrongSegment), /结构不完整|损坏/u);
  const noFrame = Buffer.from(jpeg); noFrame[frame + 1] = 0xe1; assert.throws(() => imageType(noFrame), /结构不完整|损坏/u);
  for (const [width, height] of [[8193, 1], [6000, 6000]]) {
    const oversized = Buffer.from(jpeg); oversized.writeUInt16BE(height, frame + 5); oversized.writeUInt16BE(width, frame + 7);
    assert.throws(() => imageType(oversized), /尺寸过大/u);
  }
});
test('WebP VP8, VP8L and VP8X validate actual canvas dimensions, chunks and bounds', () => {
  for (const valid of [webpLossy, webpLossless, extendedWebp()]) assert.equal(imageType(valid), 'image/webp');
  for (const [width, height] of [[8193, 1], [6000, 6000]]) {
    const lossy = Buffer.from(webpLossy); lossy.writeUInt16LE(width, 26); lossy.writeUInt16LE(height, 28);
    const lossless = Buffer.from(webpLossless); lossless.writeUInt32LE(((height - 1) * 16384 + width - 1) >>> 0, 21);
    for (const oversized of [lossy, lossless, extendedWebp(width, height)]) assert.throws(() => imageType(oversized), /尺寸过大/u);
  }
  const badRiffSize = Buffer.from(webpLossless); badRiffSize.writeUInt32LE(99999, 4);
  const badChunkSize = Buffer.from(webpLossy); badChunkSize.writeUInt32LE(99999, 16);
  const badVp8Signature = Buffer.from(webpLossy); badVp8Signature[23] = 0;
  const badVp8lVersion = Buffer.from(webpLossless); badVp8lVersion[24] |= 0xe0;
  for (const bad of [webpLossy.subarray(0, 20), badRiffSize, badChunkSize, badVp8Signature, badVp8lVersion, extendedWebp(3, 3)]) assert.throws(() => imageType(bad), /结构不完整|损坏/u);
  const noBitstream = extendedWebp().subarray(0, 30); noBitstream.writeUInt32LE(22, 4);
  assert.throws(() => imageType(noBitstream), /结构不完整|损坏/u);
  assert.throws(() => imageType(extendedWebp(2, 3, 0x02)), /动态 WebP/u);
});
test('native vision uses image_url blocks only in user input; unsupported providers fail without network', async t => {
  const payloads: any[] = [];
  const server = createServer(async (req, res) => { let raw = ''; for await (const part of req) raw += part; payloads.push(JSON.parse(raw)); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] })); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); t.after(() => new Promise<void>(done => server.close(() => done())));
  const env = { MODEL_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, MODEL_NAME: 'fixture', MODEL_API_KEY: 'fixture' };
  const request = createJsonRequester(env, 'JSON only')!;
  await request('Read image', { question: '图里有什么' }, z.object({ ok: z.boolean() }), { imageDataUrls: [`data:image/png;base64,${png.toString('base64')}`] });
  assert.equal(payloads.length, 1); assert.equal(typeof payloads[0].messages[0].content, 'string');
  assert.equal(payloads[0].messages[1].content[1].type, 'image_url');
  assert.equal(payloads[0].messages[1].content[0].type, 'text');
  const unsupported = { MODEL_BASE_URL: 'https://api.deepseek.com', MODEL_NAME: 'deepseek-v4-pro', MODEL_API_KEY: 'fixture' };
  assert.equal(supportsImageInput(unsupported), false);
  await assert.rejects(createJsonRequester(unsupported, '')!('', {}, z.object({ ok: z.boolean() }), { imageDataUrls: [`data:image/png;base64,${png.toString('base64')}`] }), /图片能力/);
});
