import { inflateRawSync } from 'node:zlib';
import { extname } from 'node:path';
import mammoth from 'mammoth';
import type { Profile } from '../shared/types.ts';

export const MAX_RESUME_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_RESUME_TEXT_LENGTH = 30_000;
const MAX_ZIP_CONTENT_BYTES = 32 * 1024 * 1024;
const MAX_ZIP_ENTRY_BYTES = 8 * 1024 * 1024;

export interface ResumeFileInput { name: string; mimeType: string; buffer: Buffer }
export interface ParsedResumeFile { text: string; warnings: string[] }

function cleanText(value: string): string {
  return value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function finishText(value: string, warnings: string[]): ParsedResumeFile {
  const text = cleanText(value);
  if (!text || !/[\p{L}\p{N}]/u.test(text)) throw new Error('文件中没有可读取的简历文字，请上传包含文字的文件。');
  if (text.length > MAX_RESUME_TEXT_LENGTH) throw new Error('提取的文字超过 30,000 字符，请精简简历后重新上传。');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) throw new Error('文件包含无法识别的二进制内容，请重新导出为 PDF、DOCX 或 UTF-8 文本。');
  return { text, warnings };
}

function decodeText(buffer: Buffer): string {
  try {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      if (buffer.length % 2) throw new Error('Invalid UTF-16');
      return new TextDecoder('utf-16le', { fatal: true }).decode(buffer.subarray(2));
    }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      if (buffer.length % 2) throw new Error('Invalid UTF-16');
      return new TextDecoder('utf-16be', { fatal: true }).decode(buffer.subarray(2));
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error('TXT 编码无法读取，请另存为 UTF-8 文本后上传。');
  }
}

/** Validate and bound actual ZIP expansion before Mammoth opens the same in-memory archive. */
function validateDocxArchive(buffer: Buffer): void {
  const badZip = () => new Error('DOCX 文件损坏或使用了不支持的压缩格式，请用 Word 重新保存为 .docx。');
  let eocd = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65_557); index--) {
    if (buffer.readUInt32LE(index) === 0x06054b50 && index + 22 + buffer.readUInt16LE(index + 20) === buffer.length) { eocd = index; break; }
  }
  if (eocd < 0) throw badZip();
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (buffer.readUInt16LE(eocd + 4) || buffer.readUInt16LE(eocd + 6) || entryCount !== buffer.readUInt16LE(eocd + 8)
    || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff || centralOffset + centralSize !== eocd) throw badZip();
  if (entryCount > 1000) throw new Error('DOCX 内部文件过多，请精简简历后重新上传。');
  let offset = centralOffset;
  let totalBytes = 0;
  const filenames = new Set<string>();
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > eocd || buffer.readUInt32LE(offset) !== 0x02014b50) throw badZip();
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const filenameSize = buffer.readUInt16LE(offset + 28);
    const extraSize = buffer.readUInt16LE(offset + 30);
    const commentSize = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + filenameSize + extraSize + commentSize;
    if (nextOffset > eocd || flags & 1 || ![0, 8].includes(method)) throw badZip();
    const filenameBytes = buffer.subarray(offset + 46, offset + 46 + filenameSize);
    const filename = filenameBytes.toString('utf8');
    if (filenames.has(filename) || filename.includes('\\') || filename.split('/').includes('..') || filename.startsWith('/') || filename.includes('\0')) throw badZip();
    filenames.add(filename);
    totalBytes += uncompressedSize;
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES || totalBytes > MAX_ZIP_CONTENT_BYTES) throw new Error('DOCX 解压后的内容过大，请删除多余图片或精简文件后上传。');
    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw badZip();
    const localNameSize = buffer.readUInt16LE(localOffset + 26);
    const localExtraSize = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameSize + localExtraSize;
    if (buffer.readUInt16LE(localOffset + 6) !== flags || buffer.readUInt16LE(localOffset + 8) !== method
      || !buffer.subarray(localOffset + 30, localOffset + 30 + localNameSize).equals(filenameBytes)
      || dataOffset + compressedSize > centralOffset) throw badZip();
    try {
      const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
      const expanded = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.min(MAX_ZIP_ENTRY_BYTES, uncompressedSize + 1) });
      if (expanded.length !== uncompressedSize) throw badZip();
    } catch { throw badZip(); }
    offset = nextOffset;
  }
  if (offset !== eocd || !filenames.has('word/document.xml') || !filenames.has('[Content_Types].xml')) throw badZip();
}

async function parsePdf(buffer: Buffer): Promise<ParsedResumeFile> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // No URL, font URL, or CMap URL is accepted from source documents or callers.
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer), useSystemFonts: false, enableXfa: false,
    disableFontFace: true, useWorkerFetch: false, stopAtErrors: true, verbosity: 0,
  });
  const pages: string[] = [];
  const warnings: string[] = [];
  try {
    const document = await task.promise;
    if (document.numPages > 30) throw new Error('简历 PDF 超过 30 页，请仅保留简历相关页面后上传。');
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const viewport = page.getViewport({ scale: 1 });
      const lines: { y: number; items: { x: number; width: number; text: string }[] }[] = [];
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const [a, b, c, d, e, f] = viewport.transform;
        const x = a * item.transform[4] + c * item.transform[5] + e;
        const y = b * item.transform[4] + d * item.transform[5] + f;
        let line = lines.find(existing => Math.abs(existing.y - y) < 3);
        if (!line) { line = { y, items: [] }; lines.push(line); }
        line.items.push({ x, width: item.width, text: item.str });
      }
      const text = lines.sort((left, right) => left.y - right.y).map(line => {
        const items = line.items.sort((left, right) => left.x - right.x);
        return items.map((item, index) => {
          if (!index) return item.text;
          const previous = items[index - 1];
          const gap = item.x - previous.x - previous.width;
          const separator = gap > 18 ? ' | ' : gap > 1.5 || /[A-Za-z0-9]$/.test(previous.text) && /^[A-Za-z0-9]/.test(item.text) ? ' ' : '';
          return separator + item.text;
        }).join('');
      }).join('\n');
      if (!text.trim()) warnings.push(`第 ${number} 页没有提取到文字，可能是图片页面。`);
      pages.push(text);
      if (pages.join('\n\n').length > MAX_RESUME_TEXT_LENGTH) throw new Error('提取的文字超过 30,000 字符，请精简简历后重新上传。');
      page.cleanup();
    }
    if (!pages.some(page => /[\p{L}\p{N}]/u.test(page))) throw new Error('该 PDF 没有可提取的文字，可能是扫描件。目前尚未支持 OCR，请上传文字版 PDF、DOCX，或粘贴简历文字。');
    warnings.push('PDF 文字顺序可能受分栏排版影响，请核对导入内容。');
    return finishText(pages.join('\n\n'), warnings);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/超过|OCR|没有可读取|二进制/.test(message)) throw error;
    if (error instanceof Error && error.name === 'PasswordException') throw new Error('PDF 已加密，请移除密码后重新上传。');
    throw new Error('PDF 读取失败，文件可能已损坏或使用了不支持的格式，请重新导出后上传。');
  } finally { await task.destroy(); }
}

export async function parseResumeFile(input: ResumeFileInput): Promise<ParsedResumeFile> {
  if (!Buffer.isBuffer(input.buffer) || !input.buffer.length) throw new Error('上传文件为空，请选择有效的简历文件。');
  if (input.buffer.length > MAX_RESUME_FILE_BYTES) throw new Error('简历文件不能超过 8 MB。');
  const extension = extname(input.name).toLowerCase();
  if (!['.pdf', '.docx', '.txt'].includes(extension)) throw new Error('目前支持 PDF、DOCX 和 TXT 文件；旧版 DOC 请先另存为 DOCX。');
  if (extension === '.pdf') {
    if (input.buffer.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('文件内容与 PDF 扩展名不符，请上传真实的 PDF 文件。');
    return parsePdf(input.buffer);
  }
  if (extension === '.docx') {
    if (input.buffer.length < 22 || input.buffer.readUInt32LE(0) !== 0x04034b50) throw new Error('文件内容与 DOCX 扩展名不符，请上传真实的 DOCX 文件。');
    validateDocxArchive(input.buffer);
    try {
      const result = await mammoth.extractRawText({ buffer: input.buffer });
      return finishText(result.value, result.messages.length ? ['文档包含部分无法完整识别的格式，请核对导入文字。'] : []);
    } catch (error) {
      if (error instanceof Error && /没有可读取|超过|二进制/.test(error.message)) throw error;
      throw new Error('DOCX 文字读取失败，请用 Word 重新保存后上传。');
    }
  }
  return finishText(decodeText(input.buffer), []);
}

const CONTACT_LABELS = '邮箱|电子邮箱|邮件|Email|E-mail|电话|电话号码|联系电话|手机|手机号|手机号码|移动电话|Phone|Mobile|Tel';
const FIELD_LABELS = `姓名|姓[ ]*名|Name|${CONTACT_LABELS}|学校|毕业院校|院校|就读院校|School|University|学历|学位|最高学历|专业|所学专业|毕业时间|预计毕业|毕业年份|毕业|目标城市|意向城市|期望城市|现居地|现居城市|所在城市|城市|到岗时间|可到岗时间|实习时间|到岗安排|求职意向|意向岗位|目标岗位|目标职位`;
function labelledValue(text: string, labels: string): string | undefined {
  const match = text.match(new RegExp(`(?:^|[\\n|｜;；,，\\t]|\\s)(?:${labels})\\s*[:：]\\s*([^\\n|｜;；]+?)(?=\\s+(?:${FIELD_LABELS})\\s*[:：]|$|[\\n|｜;；])`, 'im'));
  return match?.[1].trim();
}

const BODY_HEADING = /^(?:[一二三四五六七八九十\d]+[、.．)）]\s*)?(?:项目(?:经历|经验|实践)|实习(?:经历|经验)|工作(?:经历|经验)|实践(?:经历|经验)|社会实践|校园(?:经历|实践|活动)|志愿(?:经历|服务)|科研(?:经历|项目)|研究经历|技能(?:特长|清单)?|专业技能|个人技能|自我评价|个人(?:简介|优势)|获奖(?:经历|情况)|荣誉(?:奖励)?|证书|Experience|Projects?|Internships?|Work Experience|Skills|Summary)\s*[:：]?\s*$/i;
const BODY_INLINE_HEADING = /^(?:项目(?:经历|经验|实践)|实习(?:经历|经验)|工作(?:经历|经验)|实践(?:经历|经验)|社会实践|校园(?:经历|实践|活动)|科研(?:经历|项目)|技能(?:特长|清单)?|专业技能|个人技能|自我评价|个人(?:简介|优势)|获奖(?:经历|情况)|证书|Experience|Projects?|Skills|Summary)\s*[:：]\s*(.+)$/i;
const METADATA_HEADING = /^(?:个人简历|求职简历|简历|基本(?:资料|信息)|个人(?:资料|信息)|联系(?:方式|信息)|教育(?:背景|经历)|学历信息|Resume|Curriculum Vitae|Education|Contact(?: Information)?)\s*[:：]?$/i;
const RESUME_TITLE = /^(?:基础|个人|求职)?简历(?:\s*[·•|｜—–-]\s*[^。！？!?\n]{1,60})?\s*$/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const MOBILE = /(?<!\d)(?:\+?86[\s-]?)?1[3-9]\d(?:[\s-]?\d){8}(?!\d)/g;
const PROSE_ACTION = /负责|参与|协助|组织|完成|设计|开发|维护|研究|检索|分析|撰写|整理|担任|制作|实现|提升|获得|建立|管理|推动|开展|运用|使用|学习|支持|处理|收集|审核|联系|访谈|调查|沟通/;

function isContactOnly(value: string): boolean {
  const remainder = value.replace(EMAIL, '').replace(MOBILE, '').replace(/[\s|｜;；,，/·•()（）:+-]/g, '');
  return !remainder && /@|\d{3}/.test(value);
}

function isMetadataSegment(value: string, fields: Partial<Omit<Profile, 'facts'>>, inBody: boolean): boolean {
  if (isContactOnly(value)) return true;
  const pieces = value.split(new RegExp(`\\s+(?=(?:${FIELD_LABELS})\\s*[:：])`, 'i'));
  if (pieces.length > 1) return pieces.every(piece => isMetadataSegment(piece.trim(), fields, inBody));
  const labelled = value.match(new RegExp(`^(${FIELD_LABELS})\\s*[:：]\\s*(.*)$`, 'i'));
  if (labelled) {
    const [, label, content] = labelled;
    if (!content.trim()) return !inBody;
    if (new RegExp(`^(?:${CONTACT_LABELS})$`, 'i').test(label)) return isContactOnly(content);
    if (inBody || PROSE_ACTION.test(content)) return false;
    if (/^(?:姓名|姓[ ]*名|Name)$/i.test(label)) return content === fields.name;
    if (/学校|院校|School|University/i.test(label)) return content === fields.school && content.length <= 60;
    if (/学历|学位/.test(label)) return /^(?:博士(?:研究生)?|硕士(?:研究生)?|本科|学士|大专|专科)(?:在读|毕业)?$/.test(content);
    if (/专业/.test(label)) return content === fields.major && content.length <= 40 && !/[。！？!?]/.test(content);
    if (/毕业/.test(label)) return /^(?:预计)?\s*20\d{2}(?:[年./-]\d{1,2}月?)?(?:年|届)?(?:毕业)?$/.test(content);
    if (/城市|现居/.test(label)) return content === fields.city && content.length <= 40 && !/[。！？!?]/.test(content);
    if (/到岗|实习时间/.test(label)) return content === fields.availability && content.length <= 100;
    if (/意向|目标/.test(label)) return content === fields.targetRole && content.length <= 80 && !/[。！？!?]/.test(content);
    return false;
  }
  if (inBody) return false;
  // Only remove an unlabelled row if every token is a known personal field or an education date.
  let remainder = value;
  let matched = false;
  for (const key of ['name', 'school', 'education', 'major', 'graduation', 'email', 'phone'] as const) {
    const known = fields[key];
    if (known && remainder.includes(known)) { remainder = remainder.split(known).join(''); matched = true; }
  }
  if (!matched) return false;
  return !remainder.replace(/20\d{2}(?:[年./-]\d{1,2}月?)?(?:年|届)?/g, '').replace(/[\s|｜;；,，/·•()（）:：—–~至-]/g, '');
}

function experienceBody(source: string, fields: Partial<Omit<Profile, 'facts'>>): { text: string; warnings: string[] } {
  const retained: string[] = [];
  let inBody = false;
  let removed = false;
  let hasBodyHeading = false;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (!line) { if (retained.length && retained.at(-1) !== '') retained.push(''); continue; }
    if (BODY_HEADING.test(line)) { inBody = true; hasBodyHeading = true; removed = true; continue; }
    const inline = line.match(BODY_INLINE_HEADING);
    if (inline) { inBody = true; hasBodyHeading = true; removed = true; retained.push(inline[1]); continue; }
    if (!inBody && RESUME_TITLE.test(line) && !PROSE_ACTION.test(line)) { removed = true; continue; }
    if (METADATA_HEADING.test(line)) { inBody = false; removed = true; continue; }
    const segments = line.split(/\s*[|｜;；]\s*/);
    const kept = segments.filter(segment => !isMetadataSegment(segment, fields, inBody));
    if (kept.length !== segments.length) removed = true;
    if (kept.length) retained.push(kept.length === segments.length ? line : kept.join('；'));
  }
  const text = cleanText(retained.join('\n'));
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return { text: source, warnings: ['未找到可独立识别的经历正文，暂时保留原文。请在经历框中补充或选取实践内容，避免将基本资料当作经历。'] };
  if (!removed && !hasBodyHeading) return { text: source, warnings: ['未识别到明确的资料与经历分区，已保留原文；请核对经历框中是否混入基本信息。'] };
  return { text, warnings: [] };
}

export function inferProfileFromText(text: string): { fields: Partial<Omit<Profile, 'facts'>>; warnings: string[] } {
  const source = cleanText(text);
  const fields: Partial<Omit<Profile, 'facts'>> = {};
  const warnings = ['自动识别的资料尚未确认，请核对后保存；未明确出现的信息不会自动补全。'];
  const put = (key: keyof Omit<Profile, 'facts'>, value: string | undefined) => { if (value?.trim()) fields[key] = value.trim(); };
  put('email', source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]);
  const phone = source.match(/(?<!\d)(?:\+?86[\s-]?)?1[3-9]\d(?:[\s-]?\d){8}(?!\d)/)?.[0];
  put('phone', phone?.replace(/[\s-]/g, '').replace(/^\+?86(?=1\d{10}$)/, ''));
  const labelName = labelledValue(source, '姓名|姓[ ]*名|Name');
  const firstLines = source.split('\n').slice(0, 3).map(line => line.trim());
  const name = labelName || firstLines.find(line => /^[\p{Script=Han}]{2,5}$/u.test(line)
    && /^(?:欧阳|司马|上官|诸葛|司徒|慕容|[赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜谢邹喻柏水窦章云苏潘葛奚范彭鲁韦马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝安常乐于傅齐康伍余元顾孟平黄和穆萧尹姚邵汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵季贾路娄江童颜郭梅盛林刁钟徐邱骆高夏蔡田胡凌霍虞万支柯管卢莫经房裘缪干解应宗丁宣邓郁单杭洪包诸左石崔吉龚程邢裴陆荣翁荀羊甄曲封储仲伊宫宁仇栾甘戎符刘景詹束龙叶黎白蒲鄂索谭赖卓蔺屠蒙池乔阴胥能苍闻莘党翟谯申冉雍桑桂濮牛寿边燕冀浦尚农温庄柴阎连艾鱼容向古易慎廖庾终居衡步耿满弘匡阙文寇广阚巩聂晁冷辛那简饶曾关蒯相查后荆红游竺权逯盖益桓公])/u.test(line)
    && !/简历|求职|教育|经历|背景|信息|本科|硕士|博士|大学|学院|法学|专业/.test(line));
  if (name && /^[\p{L} ·.'-]{2,60}$/u.test(name)) put('name', name);
  put('school', labelledValue(source, '学校|毕业院校|就读院校|院校|School|University'));
  if (!fields.school) {
    const schoolMatch = source.match(/(?:^|[\s|｜:：,，])([\p{Script=Han}]{2,20}(?:大学|学院))(?![\p{Script=Han}])/u);
    put('school', schoolMatch?.[1].replace(/^(?:毕业于|就读于|曾就读于)/, ''));
  }
  const educationLabel = labelledValue(source, '学历|最高学历|学位');
  const educationRows = source.split('\n').filter(line => /大学|学院|University|College|学历|学位|教育|本科在读|硕士在读|博士在读/i.test(line)).join('\n');
  const degree = (educationLabel || educationRows).match(/博士(?:研究生)?|硕士(?:研究生)?|本科|学士|大专|专科|Bachelor(?:'s)?(?: degree)?|Master(?:'s)?(?: degree)?|Ph\.?D\.?/i)?.[0];
  put('education', degree);
  put('major', labelledValue(source, '专业|所学专业'));
  if (!fields.major) {
    const educationLine = source.split('\n').find(line => /大学|学院/.test(line) && /本科|硕士|博士|学士|大专|专科/.test(line));
    const major = educationLine?.match(/(?:\s|[|｜/])([\p{Script=Han}]{2,16})(?:专业)?(?=\s|[|｜/]|$)/gu)
      ?.map(item => item.replace(/^[\s|｜/]+|专业$/g, '').trim())
      .find(item => !/大学|学院|本科|硕士|博士|学士|大专|专科|教育|毕业|就读|在读|学位/.test(item));
    put('major', major);
  }
  const graduation = labelledValue(source, '毕业时间|预计毕业|毕业年份|毕业')
    || source.match(/(?:预计\s*)?(20\d{2}(?:[年./-]\d{1,2}月?)?)\s*(?:年)?\s*(?:届|毕业)/)?.[1];
  put('graduation', graduation?.match(/20\d{2}(?:[年./-]\d{1,2}月?)?/u)?.[0]);
  if (!fields.graduation) {
    const educationLine = source.split('\n').find(line => /大学|学院/.test(line));
    const range = educationLine?.match(/20\d{2}(?:[年./-]\d{1,2}月?)?\s*[-—–~至]\s*(20\d{2}(?:[年./-]\d{1,2}月?)?)/);
    put('graduation', range?.[1]);
  }
  put('city', labelledValue(source, '目标城市|意向城市|期望城市|现居地|现居城市|所在城市|城市'));
  put('availability', labelledValue(source, '到岗时间|可到岗时间|实习时间|到岗安排'));
  put('targetRole', labelledValue(source, '求职意向|意向岗位|目标岗位|目标职位'));
  const experience = experienceBody(source, fields);
  put('experienceText', experience.text);
  warnings.push(...experience.warnings);
  return { fields, warnings };
}
