import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ConfirmContext, type ConfirmRequest } from "./confirmContext"

// Owns the one confirm pop-up for everything below it. It lives here, at the
// top, rather than inside whatever asked: the asker is often short-lived (a
// hover popover, the drive menu) and would take the pop-up with it when it
// closed. Uses the shared confirm-scrim / confirm-card styles
// (SettingsOverlay.css).
export default function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  const resolveRef = useRef<((ok: boolean) => void) | null>(null)

  const confirm = useCallback((req: ConfirmRequest) => {
    resolveRef.current?.(false)  // a newer question replaces an unanswered one
    setRequest(req)
    return new Promise<boolean>(resolve => { resolveRef.current = resolve })
  }, [])

  const answer = (ok: boolean) => {
    resolveRef.current?.(ok)
    resolveRef.current = null
    setRequest(null)
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request && <ConfirmDialog request={request} onAnswer={answer} />}
    </ConfirmContext.Provider>
  )
}

function ConfirmDialog({ request, onAnswer }: { request: ConfirmRequest; onAnswer: (ok: boolean) => void }) {
  const onAnswerRef = useRef(onAnswer)
  useEffect(() => { onAnswerRef.current = onAnswer })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onAnswerRef.current(false) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return createPortal(
    <div className="confirm-scrim" onClick={e => e.target === e.currentTarget && onAnswer(false)}>
      <div className="confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <p id="confirm-title">{request.title}</p>
        {request.detail && <p className="confirm-detail">{request.detail}</p>}
        <div className="restart-confirm-actions">
          <button className="text-link-btn" onClick={() => onAnswer(false)} autoFocus>{request.cancelLabel ?? "Cancel"}</button>
          <button className="tinted-btn tint-re" onClick={() => onAnswer(true)}>{request.confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
