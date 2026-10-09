import type { ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';

export default function InlineRemovalConfirm({ title, children, confirmLabel, onConfirm, onCancel, busy = false, disabled = false }: {
  title: string; children: ReactNode; confirmLabel?: string; onConfirm?: () => void; onCancel: () => void; busy?: boolean; disabled?: boolean;
}) {
  return <div className="record-delete-confirm" role="alertdialog" aria-label={title} onKeyDown={event => { if (event.key === 'Escape' && !busy) onCancel(); }}>
    <h3>{title}</h3><div className="record-delete-description">{children}</div>
    <div className="inline-buttons"><button className="button secondary" type="button" disabled={busy} autoFocus onClick={onCancel}>取消</button>
      {onConfirm && <button className="button danger" type="button" disabled={busy || disabled} onClick={onConfirm}>{busy && <LoaderCircle size={15} className="spin" />}{confirmLabel || '确认删除'}</button>}
    </div>
  </div>;
}
