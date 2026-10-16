/* eslint-disable jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { t } from "@/lib/client-language";

export type OverlayCloseReason = "backdrop" | "escape" | "close-button" | "history";
export type OverlayVariant = "modal" | "drawer" | "sheet" | "docked";
export type OverlayDismissPolicy = "normal" | "critical";

type OverlayDialogProps = {
  title: string;
  children: ReactNode | ((requestClose: (reason?: OverlayCloseReason) => void) => ReactNode);
  onRequestClose: (reason: OverlayCloseReason) => void;
  variant?: OverlayVariant;
  dismissPolicy?: OverlayDismissPolicy;
  dirty?: boolean;
  initialFocus?: string;
  className?: string;
  history?: boolean;
  discardTitle?: string;
  discardMessage?: string;
};

export type ConfirmDialogOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmationText?: string;
  danger?: boolean;
};

type PendingConfirmation = ConfirmDialogOptions & { resolve: (confirmed: boolean) => void };
const ConfirmationContext = createContext<((options: ConfirmDialogOptions) => Promise<boolean>) | null>(null);

const overlayStack: string[] = [];
let bodyOverlayCount = 0;
let previousBodyOverflow = "";

function isTopOverlay(id: string) {
  return overlayStack.at(-1) === id;
}

export function OverlayDialog({
  title,
  children,
  onRequestClose,
  variant = "modal",
  dismissPolicy = "normal",
  dirty = false,
  initialFocus,
  className = "",
  history: useHistory = false,
  discardTitle = "변경사항을 버릴까요?",
  discardMessage = "저장하지 않은 변경사항이 있습니다. 닫으면 작성한 내용이 사라집니다.",
}: OverlayDialogProps) {
  const reactId = useId();
  const overlayId = `overlay-${reactId.replace(/:/g, "")}`;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const discardFocusRef = useRef<HTMLButtonElement>(null);
  const requestCloseRef = useRef<(reason?: OverlayCloseReason) => void>(() => undefined);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 72rem)").matches);
  const modeless = variant === "docked" && wide;
  useEffect(() => {
    const media = window.matchMedia("(min-width: 72rem)");
    const update = () => setWide(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const finishClose = useCallback((reason: OverlayCloseReason) => {
    onRequestClose(reason);
  }, [onRequestClose]);

  const requestClose = useCallback((reason: OverlayCloseReason = "close-button") => {
    if (!isTopOverlay(overlayId)) return;
    if (dirty) {
      if (reason === "history" && useHistory) {
        window.history.pushState({ ...window.history.state, __okriOverlay: overlayId }, "", window.location.href);
      }
      setConfirmingDiscard(true);
      return;
    }
    if (dismissPolicy === "critical" && reason === "backdrop") return;
    if (useHistory && reason !== "history" && window.history.state?.__okriOverlay === overlayId) {
      const nextState = { ...window.history.state };
      delete nextState.__okriOverlay;
      window.history.replaceState(nextState, "", window.location.href);
    }
    finishClose(reason);
  }, [dirty, dismissPolicy, finishClose, overlayId, useHistory]);

  useEffect(() => { requestCloseRef.current = requestClose; }, [requestClose]);
  useEffect(() => {
    if (!dirty) return;
    function warnBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlayStack.push(overlayId);
    if (!modeless && bodyOverlayCount === 0) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    if (!modeless) bodyOverlayCount += 1;
    if (!dialog.open) { if (modeless) dialog.show(); else dialog.showModal(); }
    const focusTarget = initialFocus ? dialog.querySelector<HTMLElement>(initialFocus) : null;
    window.requestAnimationFrame(() => (focusTarget ?? dialog.querySelector<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])"))?.focus());

    if (useHistory) {
      window.history.pushState({ ...window.history.state, __okriOverlay: overlayId }, "", window.location.href);
    }

    const handlePopState = () => {
      if (!useHistory) return;
      if (!isTopOverlay(overlayId)) return;
      if (window.history.state?.__okriOverlay === overlayId) return;
      requestCloseRef.current("history");
    };
    window.addEventListener("popstate", handlePopState);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (modeless && event.key === "Escape" && !event.defaultPrevented && isTopOverlay(overlayId)) {
        event.preventDefault();
        requestCloseRef.current("escape");
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("popstate", handlePopState);
      document.removeEventListener("keydown", handleKeyDown);
      const index = overlayStack.lastIndexOf(overlayId);
      if (index >= 0) overlayStack.splice(index, 1);
      if (!modeless) {
        bodyOverlayCount = Math.max(0, bodyOverlayCount - 1);
        if (bodyOverlayCount === 0) document.body.style.overflow = previousBodyOverflow;
      }
      if (dialog.open) dialog.close();
      if (window.history.state?.__okriOverlay === overlayId) {
        const nextState = { ...window.history.state };
        delete nextState.__okriOverlay;
        window.history.replaceState(nextState, "", window.location.href);
      }
      returnFocusRef.current?.focus({ preventScroll: true });
    };
  }, [initialFocus, overlayId, useHistory, modeless]);

  useEffect(() => {
    if (confirmingDiscard) discardFocusRef.current?.focus();
  }, [confirmingDiscard]);

  function handleBackdropClick(event: ReactMouseEvent<HTMLDialogElement>) {
    if (event.target !== event.currentTarget) return;
    requestClose("backdrop");
  }

  return (
    <dialog
      ref={dialogRef}
      className={`modal-backdrop overlay-dialog overlay-${variant} ${variant === "drawer" || variant === "docked" ? "align-right" : ""} ${className}`.trim()}
      aria-labelledby={`${overlayId}-title`}
      onClick={handleBackdropClick}
      onCancel={(event) => {
        event.preventDefault();
        if (confirmingDiscard) setConfirmingDiscard(false);
        else requestClose("escape");
      }}
    >
      <span className="sr-only" id={`${overlayId}-title`}>{title}</span>
      {typeof children === "function" ? children(requestClose) : children}
      {confirmingDiscard && (
        <div className="overlay-confirm-layer">
          <section className="overlay-confirm" role="alertdialog" aria-modal="true" aria-labelledby={`${overlayId}-discard-title`} aria-describedby={`${overlayId}-discard-message`}>
            <h2 id={`${overlayId}-discard-title`}>{discardTitle}</h2>
            <p id={`${overlayId}-discard-message`}>{discardMessage}</p>
            <footer>
              <button ref={discardFocusRef} type="button" onClick={() => setConfirmingDiscard(false)}>{t("계속 작성")}</button>
              <button type="button" className="danger" onClick={() => finishClose("close-button")}>{t("변경사항 버리기")}</button>
            </footer>
          </section>
        </div>
      )}
    </dialog>
  );
}

export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const [confirmationValue, setConfirmationValue] = useState("");

  const confirm = useCallback((options: ConfirmDialogOptions) => new Promise<boolean>((resolve) => {
    setConfirmationValue("");
    setPending({ ...options, resolve });
  }), []);

  function settle(confirmed: boolean) {
    const current = pending;
    setPending(null);
    setConfirmationValue("");
    current?.resolve(confirmed);
  }

  return (
    <ConfirmationContext.Provider value={confirm}>
      {children}
      {pending && (
        <OverlayDialog title={pending.title} dismissPolicy="critical" initialFocus={pending.confirmationText ? "input" : "button"} onRequestClose={() => settle(false)}>
          {(requestClose) => <section className="overlay-confirm app-confirm-dialog" role="document">
            <h2>{pending.title}</h2>
            <p>{pending.message}</p>
            {pending.confirmationText && <label><span>{t("확인 문구")}</span><input value={confirmationValue} onChange={(event) => setConfirmationValue(event.target.value)} placeholder={pending.confirmationText} /></label>}
            <footer>
              <button type="button" onClick={() => requestClose("close-button")}>{pending.cancelLabel ?? t("취소")}</button>
              <button type="button" className={pending.danger ? "danger" : "primary"} disabled={Boolean(pending.confirmationText) && confirmationValue !== pending.confirmationText} onClick={() => settle(true)}>{pending.confirmLabel ?? t("확인")}</button>
            </footer>
          </section>}
        </OverlayDialog>
      )}
    </ConfirmationContext.Provider>
  );
}

export function useAppConfirm() {
  const confirm = useContext(ConfirmationContext);
  if (!confirm) throw new Error("useAppConfirm must be used inside ConfirmationProvider");
  return confirm;
}
