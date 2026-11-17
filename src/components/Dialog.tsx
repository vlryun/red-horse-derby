import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

interface DialogState {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** 입력이 필요하면: 입력값이 이 문자열과 같아야 확인 버튼 활성화 (타이핑 확인) */
  requireText?: string;
  /** 자유 입력 (비밀번호 등) */
  input?: { type: 'text' | 'password'; placeholder?: string; minLength?: number };
  resolve: (v: string | null) => void;
}

/**
 * 화면 안 확인 창. 브라우저 기본 confirm/prompt 대신 사용
 * (일부 휴대폰·키오스크 브라우저는 기본 팝업을 막거나 숨김 → 버튼이 "아무 반응 없음"이 되는 사고 방지)
 */
export function useDialog() {
  const [state, setState] = useState<DialogState | null>(null);

  const open = useCallback(
    (opts: Omit<DialogState, 'resolve'>) =>
      new Promise<string | null>((resolve) => {
        setState({ ...opts, resolve });
      }),
    [],
  );

  const confirm = useCallback(
    async (title: string, body?: ReactNode, opts: { confirmLabel?: string; danger?: boolean; requireText?: string } = {}) =>
      (await open({ title, body, confirmLabel: opts.confirmLabel ?? '확인', danger: opts.danger, requireText: opts.requireText })) !== null,
    [open],
  );

  const prompt = useCallback(
    (title: string, input: DialogState['input'], body?: ReactNode, confirmLabel = '확인') =>
      open({ title, body, confirmLabel, input }),
    [open],
  );

  const close = (v: string | null) => {
    state?.resolve(v);
    setState(null);
  };

  const node = state ? <DialogView state={state} onClose={close} /> : null;
  return { confirm, prompt, node };
}

function DialogView({ state, onClose }: { state: DialogState; onClose: (v: string | null) => void }) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    (state.requireText || state.input ? inputRef.current : okRef.current)?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, onClose]);

  const ready = state.requireText
    ? text.trim() === state.requireText
    : state.input
      ? text.length >= (state.input.minLength ?? 1)
      : true;

  return (
    <div className="dialog-backdrop" onClick={() => onClose(null)}>
      <form
        className={`dialog ${state.danger ? 'danger' : ''}`}
        role="alertdialog"
        aria-modal="true"
        aria-label={state.title}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) onClose(state.input ? text : 'ok');
        }}
      >
        <h2>{state.title}</h2>
        {state.body && <div className="dialog-body">{state.body}</div>}
        {(state.requireText || state.input) && (
          <input
            ref={inputRef}
            type={state.input?.type ?? 'text'}
            value={text}
            placeholder={state.requireText ? `"${state.requireText}" 입력` : state.input?.placeholder}
            onChange={(e) => setText(e.target.value)}
            autoComplete="off"
          />
        )}
        <div className="row dialog-actions">
          <button type="button" className="ghost" onClick={() => onClose(null)}>
            취소
          </button>
          <button ref={okRef} type="submit" className={state.danger ? 'danger' : 'cta'} disabled={!ready}>
            {state.confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
