"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, X } from "lucide-react";
import { OverlayDialog } from "./overlay-dialog";
import { t } from "@/lib/client-language";
import type { ProjectTaskGoal } from "@/lib/project-task-goals";
import "./project-completion-goal.css";

type GoalState = { goal: ProjectTaskGoal | null; apiConnected: boolean; progress: number };
export function ProjectCompletionGoal({ projectId, completedCount, progress, readOnly, onChange }: {
  projectId: string; completedCount: number; progress: number; readOnly: boolean;
  onChange: (progress: number, enabled: boolean) => void;
}) {
  const [state, setState] = useState<GoalState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [target, setTarget] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const savingRef = useRef(false);
  const goal = state?.goal;
  useEffect(() => {
    const controller = new AbortController();
    setLoadError(false);
    void fetch(`/api/project-task-goals?projectId=${encodeURIComponent(projectId)}`, { signal: controller.signal, cache: "no-store" })
      .then(async response => { if (!response.ok) throw new Error(); return response.json() as Promise<GoalState>; })
      .then(setState).catch(() => { if (!controller.signal.aborted) setLoadError(true); });
    return () => controller.abort();
  }, [projectId, attempt]);
  useEffect(() => {
    if (!state) return;
    const next = goal ? Math.min(100, Math.round(completedCount / goal.targetCount * 100)) : progress;
    onChangeRef.current(next, Boolean(goal));
  }, [state, goal, completedCount, progress]);

  function edit() {
    setEnabled(Boolean(goal) || !state?.apiConnected);
    setTarget(goal ? String(goal.targetCount) : "");
    setError(""); setConflict(false); setOpen(true);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (savingRef.current || !state || conflict) return;
    const targetCount = Number(target);
    if (enabled && (!target.trim() || !Number.isSafeInteger(targetCount) || targetCount < 1 || targetCount > 1_000_000)) {
      setError(t("목표 Task 수를 1부터 1,000,000 사이의 정수로 입력해 주세요.")); return;
    }
    savingRef.current = true; setSaving(true); setError("");
    try {
      const response = await fetch("/api/project-task-goals", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, enabled, targetCount, expectedVersion: goal?.version ?? 0, expectedId: goal?.id }) });
      const data = await response.json() as GoalState;
      if (!response.ok) {
        if (response.status === 409) {
          setConflict(true);
          throw new Error("goal_conflict");
        }
        throw new Error(t("저장하지 못했습니다. 입력한 내용을 확인하고 다시 시도해 주세요."));
      }
      setState(data); onChangeRef.current(data.progress, Boolean(data.goal)); setOpen(false);
    } catch (failure) {
      setError(failure instanceof Error && failure.message === "goal_conflict" ? t("설정이 바뀌었습니다. 창을 닫고 최신 설정을 불러온 뒤 다시 저장해 주세요.") : t("저장하지 못했습니다. 입력한 내용을 확인하고 다시 시도해 주세요."));
    } finally { savingRef.current = false; setSaving(false); }
  }
  function close() { if (savingRef.current) return; setOpen(false); if (conflict) setAttempt(value => value + 1); }
  return <div className="completion-goal">
    {loadError ? <p role="alert">{t("진행 방식을 불러오지 못했습니다.")} <button className="secondary" onClick={() => setAttempt(value => value + 1)}>{t("다시 시도")}</button></p>
      : !state ? <span role="status">{t("데이터를 불러오는 중")}</span>
      : <><div className="completion-goal-summary">{goal ? <><b>{t("완료 쌓기")}</b><span>{t("{completed} / {target}개 완료", { completed: completedCount, target: goal.targetCount })}</span></> : <span>{state.apiConnected ? t("API 연결") : t("직접 조절")}</span>}</div>
        {!readOnly && <button type="button" className="secondary" disabled={state.apiConnected} onClick={edit}>{goal ? t("진행 방식 변경") : t("완료 쌓기 설정")}</button>}
        {state.apiConnected && !readOnly && <small>{t("완료 쌓기를 사용하려면 데이터 화면에서 API 연결을 먼저 해제해 주세요.")}</small>}</>}
    {open && <OverlayDialog title={t("진행 방식")} dirty={enabled !== (Boolean(goal) || !state?.apiConnected) || target !== (goal ? String(goal.targetCount) : "")} onRequestClose={close}>
      <section className="completion-goal-dialog"><header><h2>{t("진행 방식")}</h2><button type="button" className="icon-button" aria-label={t("닫기")} disabled={saving} onClick={close}><X size={18} /></button></header>
        <form className="property-form" onSubmit={event => void save(event)} aria-busy={saving}>
          <label><span>{t("진행 방식")}</span><select disabled={saving} value={enabled ? "completion" : "manual"} onChange={event => { setEnabled(event.target.value === "completion"); setError(""); }}><option value="manual">{t("직접 조절")}</option><option value="completion">{t("완료 쌓기")}</option></select></label>
          {enabled ? <><p>{t("Task 하나를 완료할 때마다 1개씩 쌓입니다. 완료를 취소하면 다시 빠집니다.")}</p><label><span>{t("목표 Task 수")}</span><input autoFocus type="number" inputMode="numeric" min="1" max="1000000" step="1" required value={target} disabled={saving} onChange={event => setTarget(event.target.value)} aria-invalid={Boolean(error) && !conflict} aria-describedby="completion-goal-help" /></label><small id="completion-goal-help">{t("이미 완료한 Task도 포함합니다. 목표를 채우면 진행률이 100%가 됩니다.")}</small></>
            : <p>{t("현재 진행률을 유지하고 직접 조절합니다.")}</p>}
          {error && <p className="completion-goal-error" role="alert">{error}</p>}
          <footer><button type="button" className="secondary" disabled={saving} onClick={close}>{t("취소")}</button><button type="submit" className="primary-action" disabled={saving || conflict}>{saving ? t("저장 중") : <><Check size={16} />{t("저장")}</>}</button></footer>
        </form>
      </section>
    </OverlayDialog>}
  </div>;
}
