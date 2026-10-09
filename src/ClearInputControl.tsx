import { useEffect, useState } from 'react';
import { Eraser, Undo2 } from 'lucide-react';

type DraftProps<T> = {
  value: T; emptyValue: T; onChange: (value: T) => void; label: string;
  disabled?: boolean; resetKey?: string | number; clearLabel?: string; undoLabel?: string;
};

/** A local-only clear. Any subsequent edit or persisted revision invalidates undo. */
export function ClearDraftControl<T>({ value, emptyValue, onChange, label, disabled = false, resetKey, clearLabel = '清空', undoLabel = '撤销清空' }: DraftProps<T>) {
  const [undo, setUndo] = useState<{ value: T; clearedKey: string; resetKey?: string | number } | null>(null);
  const currentKey = JSON.stringify(value), emptyKey = JSON.stringify(emptyValue);
  const canUndo = !!undo && currentKey === undo.clearedKey && resetKey === undo.resetKey;
  useEffect(() => { if (undo && !canUndo) setUndo(null); }, [undo, canUndo]);
  function clear() {
    if (disabled || currentKey === emptyKey) return;
    setUndo({ value: structuredClone(value), clearedKey: emptyKey, resetKey });
    onChange(structuredClone(emptyValue));
  }
  function restore() {
    if (disabled || !canUndo || !undo) return;
    const previous = undo.value; setUndo(null); onChange(previous);
  }
  return <div className="clear-input-control" role="group" aria-label={`${label}编辑操作`}>
    <button className="button quiet" type="button" aria-label={`清空${label}`} disabled={disabled || currentKey === emptyKey} onClick={clear}><Eraser size={14} />{clearLabel}</button>
    {canUndo && <><button className="button quiet" type="button" aria-label={`撤销清空${label}`} disabled={disabled} onClick={restore}><Undo2 size={14} />{undoLabel}</button><span role="status">仅修改当前输入，尚未保存</span></>}
  </div>;
}

export default function ClearInputControl(props: Omit<DraftProps<string>, 'emptyValue'>) {
  return <ClearDraftControl {...props} emptyValue="" />;
}
