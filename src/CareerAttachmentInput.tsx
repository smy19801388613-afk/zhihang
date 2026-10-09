import { useRef, useState } from 'react';
import { Paperclip, X, LoaderCircle, FileText, Image } from 'lucide-react';
import type { CareerAttachment } from '../shared/types';
type Props = { value: CareerAttachment[]; onChange: (value: CareerAttachment[]) => void; disabled: boolean; onBusy: (busy: boolean) => void };
export default function CareerAttachmentInput({ value, onChange, disabled, onBusy }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false), [error, setError] = useState('');
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    if (value.length + files.length > 3) { setError('每轮最多 3 个附件。'); return; }
    setUploading(true); onBusy(true); setError('');
    const next = [...value];
    try {
      for (const file of files) {
        if (file.size > 8 * 1024 * 1024) throw new Error('每个文件最大 8 MB。');
        const form = new FormData(); form.append('file', file);
        const response = await fetch('/api/career-attachments', { method: 'POST', body: form });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || '附件读取失败，请重试。');
        next.push(body); onChange([...next]);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : '附件上传失败。'); }
    finally { setUploading(false); onBusy(false); if (input.current) input.current.value = ''; }
  }
  async function remove(id: string) {
    try { const response = await fetch(`/api/career-attachments/${id}`, { method: 'DELETE' }); if (!response.ok) throw new Error('移除失败，请重试。'); onChange(value.filter(item => item.id !== id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '移除失败。'); }
  }
  return <div className="career-attachment-input">
    <input ref={input} type="file" hidden multiple accept=".pdf,.docx,.txt,.png,.jpg,.jpeg,.webp" aria-label="聊天附件" disabled={disabled || uploading} onChange={event => void upload(event.target.files)} />
    <button type="button" className="button quiet" disabled={disabled || uploading || value.length >= 3} onClick={() => input.current?.click()}>{uploading ? <LoaderCircle size={15} className="spin" /> : <Paperclip size={15} />}添加文件或图片</button>
    {value.length > 0 && <><div className="career-attachments">{value.map(item => <div className="career-attachment" key={item.id}>{item.kind === 'image' ? <Image size={16} /> : <FileText size={16} />}<span>{item.name}</span><button type="button" aria-label={`移除附件 ${item.name}`} disabled={disabled || uploading} onClick={() => void remove(item.id)}><X size={14} /></button>{item.text && <details><summary>查看提取文字</summary><pre>{item.text}</pre></details>}</div>)}</div><p className="attachment-note">发送时交给当前模型读取；附件不自动变成已确认经历。未发送附件保留 30 分钟。</p></>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}
