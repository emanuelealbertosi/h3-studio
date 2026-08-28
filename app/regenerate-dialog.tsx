"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Props = {
  busy?: boolean;
  initialPrompt: string;
  initialSecondaryValue?: string;
  secondaryLabel?: string;
  mediaLabel: string;
  scopeLabel: string;
  onCancel: () => void;
  onConfirm: (prompt: string, secondaryValue?: string) => void | Promise<void>;
};

export default function RegenerateDialog({
  busy = false,
  initialPrompt,
  initialSecondaryValue = "",
  secondaryLabel,
  mediaLabel,
  scopeLabel,
  onCancel,
  onConfirm,
}: Props) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [secondaryValue, setSecondaryValue] = useState(initialSecondaryValue);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const secondaryRef = useRef<HTMLTextAreaElement>(null);
  onCancelRef.current = onCancel;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => {
      promptRef.current?.focus();
      const end = promptRef.current?.value.length ?? 0;
      promptRef.current?.setSelectionRange(end, end);
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancelRef.current();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
    };
  }, [busy]);

  const cleanPrompt = prompt.trim();
  const cleanSecondaryValue = secondaryValue.trim();
  const dialog = (
    <div
      className="regenerate-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <form
        aria-labelledby="regenerate-dialog-title"
        aria-modal="true"
        className="regenerate-dialog"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const controls = [promptRef.current, secondaryRef.current, cancelRef.current, confirmRef.current]
            .filter((control): control is HTMLTextAreaElement | HTMLButtonElement =>
              Boolean(control && !control.disabled),
            );
          const first = controls[0];
          const last = controls.at(-1);
          if (!first || !last) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && cleanPrompt.length >= 3) void onConfirm(cleanPrompt, secondaryLabel ? cleanSecondaryValue : undefined);
        }}
        role="dialog"
      >
        <header>
          <span aria-hidden="true">↻</span>
          <div>
            <small>Nuovo seed</small>
            <h2 id="regenerate-dialog-title">Rigenera {mediaLabel}</h2>
          </div>
        </header>
        <p>
          Il prompt precedente è già inserito. Puoi modificarlo prima di creare una nuova generazione; l’originale resterà invariato.
        </p>
        <label>
          <span>Prompt della nuova generazione</span>
          <textarea
            disabled={busy}
            maxLength={20_000}
            onChange={(event) => setPrompt(event.target.value)}
            ref={promptRef}
            rows={7}
            value={prompt}
          />
          <small>{cleanPrompt.length.toLocaleString("it-IT")} / 20.000 caratteri</small>
        </label>
        {secondaryLabel && <label>
          <span>{secondaryLabel}</span>
          <textarea
            disabled={busy}
            maxLength={30_000}
            onChange={(event) => setSecondaryValue(event.target.value)}
            ref={secondaryRef}
            rows={8}
            value={secondaryValue}
          />
          <small>{cleanSecondaryValue.length.toLocaleString("it-IT")} / 30.000 caratteri</small>
        </label>}
        <div className="regenerate-dialog-summary">
          <span>Ambito</span>
          <strong>{scopeLabel}</strong>
          <span>Seed</span>
          <strong>Nuovo casuale</strong>
        </div>
        <footer>
          <button disabled={busy} onClick={onCancel} ref={cancelRef} type="button">Annulla</button>
          <button className="confirm" disabled={busy || cleanPrompt.length < 3} ref={confirmRef} type="submit">
            {busy ? "Avvio…" : "Rigenera"}
          </button>
        </footer>
      </form>
    </div>
  );

  return createPortal(dialog, document.body);
}
