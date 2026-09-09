"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Check, LoaderCircle, Users, UserRound, X } from "lucide-react";
import { OverlayDialog } from "./overlay-dialog";
import { displayDate, t, useLanguage } from "@/lib/client-language";
import { initialOnboarding, setupGoalErrors, setupSteps, type OnboardingState, type SetupDraft, type SetupStep } from "@/lib/onboarding";
import "./first-run-setup.css";

type Workspace = { id: string; name: string; kind: "personal" | "team"; role: string; scheduledDeletionAt: string | null };
type Destination = "okr" | "work" | "projects" | "routines" | "scrum" | "members" | "integrations";
export function FirstRunSetup({ initial, workspaces, onState, onClose, onFinish }: {
  initial: OnboardingState | null; workspaces: Workspace[];
  onState: (state: OnboardingState) => void; onClose: () => void;
  onFinish: (state: OnboardingState, destination: Destination) => Promise<void>;
}) {
  useLanguage();
  const [state, setState] = useState(initial ?? initialOnboarding());
  const [draft, setDraft] = useState(() => {
    const value = structuredClone(initial?.draft ?? initialOnboarding().draft);
    if (!value.startDate) {
      const now = new Date();
      const date = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      value.startDate = date(now);
      value.endDate = date(new Date(now.getFullYear(), now.getMonth() + 1, now.getDate()));
    }
    return value;
  });
  const [step, setStep] = useState<SetupStep>(initial?.step ?? "purpose");
  const [selection, setSelection] = useState(initial?.draft.workspaceChoiceId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [invalid, setInvalid] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const stateRef = useRef(state);
  const mounted = useRef(true);
  const working = useRef(false);
  const idleWaiters = useRef<(() => void)[]>([]);
  const flowBusy = useRef(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.draft) || step !== state.step;
  const personal = draft.kind === "personal";
  const stepIndex = setupSteps.indexOf(step);
  const options = workspaces.filter((w) => w.kind === draft.kind && !w.scheduledDeletionAt);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { heading.current?.focus(); }, [step]);
  useEffect(() => {
    if (invalid.length) heading.current?.closest("section")?.querySelector<HTMLElement>("[aria-invalid=true]")?.focus();
  }, [invalid]);
  // Timed draft saves share one queue with explicit actions; no overlapping revisions.
  useEffect(() => {
    if (!dirty || busy || conflict || state.cycleId || step === "tour") return;
    const timer = window.setTimeout(() => { void act({ action: "draft", draft, step }, false); }, 900);
    return () => window.clearTimeout(timer);
    // act reads the latest persisted revision through stateRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, step, dirty, busy, conflict, state.cycleId]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function accept(next: OnboardingState) {
    stateRef.current = next;
    setState(next);
    onState(next);
  }
  async function act(payload: Record<string, unknown>, showBusy = true): Promise<OnboardingState | null> {
    if (working.current) {
      if (!showBusy) return null;
      await new Promise<void>((resolve) => idleWaiters.current.push(resolve));
      if (!mounted.current) return null;
      return act(payload, showBusy);
    }
    working.current = true;
    if (showBusy) setBusy(true);
    try {
      // An explicit re-entry for older accounts initializes their own setup only.
      if (!initial && stateRef.current.revision === 0 && payload.action !== "start") {
        const start = await fetch("/api/account/onboarding", { method: "POST", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start", revision: 0 }) });
        const result = await start.json() as { onboarding?: OnboardingState; code?: string };
        if (!start.ok || !result.onboarding) throw new Error("setup_save_failed");
        accept(result.onboarding);
      }
      const response = await fetch("/api/account/onboarding", { method: "POST", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, revision: stateRef.current.revision }) });
      const data = await response.json() as { onboarding?: OnboardingState; code?: string };
      if (!response.ok || !data.onboarding) {
        if (response.status === 409) setConflict(true);
        throw new Error(response.status === 403 ? "setup_permission" : data.code ?? "setup_save_failed");
      }
      if (!mounted.current) return null;
      accept(data.onboarding);
      setError("");
      return data.onboarding;
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error && failure.message === "setup_permission"
        ? t("이 공간에 OKR을 만들 권한이 없습니다. 관리자에게 권한을 요청하거나 기능 안내를 먼저 확인하세요.")
        : t("입력한 내용은 화면에 남아 있습니다. 연결을 확인하고 다시 저장해 주세요."));
      return null;
    } finally { working.current = false; idleWaiters.current.splice(0).forEach((resolve) => resolve()); if (mounted.current) setBusy(false); }
  }
  async function saveDraft(nextStep: SetupStep = step) {
    const saved = await act({ action: "draft", draft, step: nextStep });
    if (saved) { setStep(nextStep); setInvalid([]); }
    return saved;
  }
  async function close() {
    if (flowBusy.current) return;
    if (stateRef.current.status === "completed") { onClose(); return; }
    if (!state.cycleId && step !== "tour" && !await saveDraft()) return;
    if (await act({ action: "pause" })) onClose();
  }
  async function advance(event: FormEvent) {
    event.preventDefault();
    if (flowBusy.current) return;
    flowBusy.current = true;
    try {
    setError("");
    const errors = setupGoalErrors(draft);
    if (step === "goal" && errors.some((e) => e !== "keyResults") || step === "results" && errors.includes("keyResults")) {
      setInvalid(errors); return;
    }
    if (step === "workspace") {
      if (!personal && !selection && !draft.workspaceName.trim()) { setInvalid(["workspace"]); return; }
      if (!await saveDraft()) return;
      const saved = await act({ action: "workspace", workspaceId: selection || undefined, confirmed: true });
      if (saved) setStep(saved.step);
    } else if (step === "review") {
      if (!confirmed) { setInvalid(["confirm"]); return; }
      if (!await saveDraft()) return;
      const saved = await act({ action: "save", confirmed: true });
      if (saved) setStep("tour");
    } else await saveDraft(setupSteps[stepIndex + 1]);
    } finally { flowBusy.current = false; }
  }
  async function finish(destination: Destination) {
    if (working.current) return;
    const saved = await act({ action: "complete" });
    if (!saved) return;
    setBusy(true);
    try { await onFinish(saved, destination); }
    catch { setError(t("화면을 열지 못했습니다. 다시 눌러 주세요. 저장한 내용은 유지됩니다.")); }
    finally { setBusy(false); }
  }
  async function reloadSaved() {
    if (working.current) return;
    setBusy(true);
    try {
      const response = await fetch("/api/account/onboarding", { cache: "no-store", signal: AbortSignal.timeout(15000) });
      const data = await response.json() as { onboarding?: OnboardingState };
      if (!response.ok || !data.onboarding) throw new Error();
      // Keep typed answers on conflict. A completed write wins over an obsolete draft.
      const previousWorkspaceId = stateRef.current.workspaceId;
      accept(data.onboarding);
      if (data.onboarding.cycleId || data.onboarding.workspaceId !== previousWorkspaceId) {
        setDraft(data.onboarding.draft); setStep(data.onboarding.step);
      }
      setConflict(false); setError("");
    } catch { setError(t("입력한 내용은 화면에 남아 있습니다. 연결을 확인하고 다시 저장해 주세요.")); }
    finally { setBusy(false); }
  }
  async function returnToGoal() {
    if (state.status === "completed" && !await act({ action: "start" })) return;
    await saveDraft(state.workspaceId ? "goal" : "purpose");
  }
  function edit(patch: Partial<SetupDraft>) { setDraft((current) => ({ ...current, ...patch })); setInvalid([]); setConfirmed(false); }
  const titles: Record<SetupStep, string> = {
    purpose: t("누구의 목표를 관리할까요?"), workspace: personal ? t("개인 목표를 위한 공간이 준비되어 있어요") : t("어느 팀의 목표를 함께 관리할까요?"),
    goal: personal ? t("앞으로 무엇을 이루고 싶으세요?") : t("팀이 함께 이루려는 목표는 무엇인가요?"),
    results: t("무엇을 보면 목표에 가까워졌다고 알 수 있을까요?"), approach: t("그 결과를 만들기 위해 무엇을 해볼까요?"),
    review: t("작성한 목표를 함께 확인해 볼까요?"), tour: state.cycleId ? t("첫 OKR을 저장했어요") : t("필요한 기능부터 시작해 보세요"),
  };
  const features: { title: string; body: string; target: Destination }[] = [
    { title: t("OKR"), body: t("목표와 결과를 함께 정하고, 변화가 생기면 한곳에서 수정하세요."), target: "okr" },
    { title: t("Project · Task"), body: t("실행할 일을 Project로 묶고, 오늘 처리할 작은 일을 Task로 나누세요."), target: "projects" },
    { title: t("내 업무"), body: t("내가 맡은 일과 기한을 한곳에서 확인하세요."), target: "work" },
    { title: t("Routine"), body: t("매번 반복되는 운영 업무는 목표와 별도로 관리할 수 있어요."), target: "routines" },
    { title: t("데일리"), body: t("어제 완료한 일과 오늘 할 일을 정리하세요. Slack 연결은 나중에 해도 돼요."), target: "scrum" },
  ];
  return <OverlayDialog title={t("처음 시작하기")} className="first-run-dialog" dismissPolicy="critical" history={false} onRequestClose={() => { void close(); }}>
    <section className="first-run-setup" aria-busy={busy}>
      <header className="setup-toolbar"><span>{t("처음 시작하기")}</span><span>{step === "tour" ? t("기능 안내") : t("{current} / {total} 단계", { current: stepIndex + 1, total: 6 })}</span><button type="button" className="setup-icon" onClick={() => void close()} disabled={busy} aria-label={t("저장하고 나중에 계속")}><X size={18} /></button></header>
      <div className="setup-conversation">
        {state.workspaceId && <p className="setup-context">{state.workspaceName}</p>}
        <h1 ref={heading} tabIndex={-1}>{titles[step]}</h1>
        {step === "purpose" && <p>{t("OKR은 이루고 싶은 목표와, 잘하고 있는지 확인할 결과를 함께 정하는 방법이에요. 하나씩 만들어 볼게요.")}</p>}
        {step === "workspace" && <p>{personal ? t("개인 워크스페이스에서 나의 성장이나 생활 목표를 관리해요. 팀 공간과 업무가 섞이지 않아요.") : t("워크스페이스는 목표와 업무를 함께 보는 팀의 공간이에요. 멤버 초대는 목표를 정한 뒤에도 할 수 있어요.")}</p>}
        {step === "goal" && <p>{t("이루고 싶은 변화를 한 문장으로 적어 주세요. 이것이 Objective예요. 할 일 목록보다 원하는 결과를 떠올려 보세요.")}</p>}
        {step === "results" && <><p className="setup-answer">{draft.objective}</p><p>{t("성공 여부를 확인할 수 있는 결과가 KR이에요. 횟수·비율·금액처럼 확인 가능한 기준을 넣어 보세요. 처음에는 하나면 충분해요.")}</p></>}
        {step === "approach" && <p>{t("결과를 만들기 위한 실행 방향을 Initiative라고 해요. 아직 모르겠다면 비워 두고 나중에 추가해도 돼요.")}</p>}
        {step === "review" && <p>{t("아래 내용으로 OKR 하나를 저장합니다. Project와 Task는 이후에 필요한 만큼 만들 수 있어요.")}</p>}
        {step === "tour" && <p>{t("모든 기능을 한 번에 익힐 필요는 없어요. 목표를 보고, 실행할 일을 하나 정하는 것부터 시작하세요.")}</p>}
        <form onSubmit={(event) => void advance(event)} noValidate>
          <fieldset disabled={busy || conflict}>
            <legend className="sr-only">{titles[step]}</legend>
            {step === "purpose" && <div className="setup-choices">{(["personal", "team"] as const).map((kind) => <label key={kind}><input type="radio" name="setup-purpose" checked={draft.kind === kind} onChange={() => { edit({ kind, workspaceChoiceId: "" }); setSelection(""); }} />{kind === "personal" ? <UserRound size={20} /> : <Users size={20} />}<span><b>{kind === "personal" ? t("개인으로 사용할게요") : t("팀과 함께 사용할게요")}</b><small>{kind === "personal" ? t("나의 목표와 실행을 차근히 관리해요.") : t("팀의 목표를 맞추고 역할을 나눠 실행해요.")}</small></span></label>)}</div>}
            {step === "workspace" && <div className="setup-fields">
              {!personal && <label><span>{t("사용할 워크스페이스")}</span><select value={selection} onChange={(event) => { setSelection(event.target.value); edit({ workspaceChoiceId: event.target.value }); }}><option value="">{t("새 팀 워크스페이스 만들기")}</option>{options.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>}
              {!personal && !selection && <label><span id="setup-team-name-label">{t("팀 이름")}</span><input aria-labelledby="setup-team-name-label" value={draft.workspaceName} maxLength={80} onChange={(event) => edit({ workspaceName: event.target.value })} placeholder={t("예: 우리 팀")} aria-invalid={invalid.includes("workspace")} aria-describedby="setup-workspace-error" /><small id="setup-workspace-error">{invalid.includes("workspace") ? t("팀 이름을 입력해 주세요.") : t("회사나 팀 이름을 쓰세요. 나중에 변경할 수 있어요.")}</small></label>}
              {personal && options[0] && <p className="setup-answer">{options[0].name}</p>}
              {selection && options.find((w) => w.id === selection)?.role === "viewer" && <p>{t("이 공간은 읽기 전용이에요. 목표 작성 대신 기능 안내로 이어집니다.")}</p>}
            </div>}
            {step === "goal" && <div className="setup-fields"><label><span id="setup-goal-label">{t("이루고 싶은 목표")}</span><textarea aria-labelledby="setup-goal-label" value={draft.objective} maxLength={200} onChange={(event) => edit({ objective: event.target.value })} placeholder={personal ? t("예: 영어로 내 생각을 자신 있게 말하기") : t("예: 고객이 다시 찾는 서비스를 만들기")} aria-invalid={invalid.includes("objective")} />{invalid.includes("objective") && <small role="alert">{t("목표를 한 문장으로 적어 주세요.")}</small>}</label><div className="setup-dates"><label><span>{t("시작일")}</span><input type="date" value={draft.startDate} onChange={(event) => edit({ startDate: event.target.value })} aria-invalid={invalid.includes("dates")} /></label><label><span>{t("목표일")}</span><input type="date" value={draft.endDate} min={draft.startDate} onChange={(event) => edit({ endDate: event.target.value })} aria-invalid={invalid.includes("dates")} /></label></div>{invalid.includes("dates") && <p role="alert">{t("시작일과 목표일을 확인해 주세요.")}</p>}<small>{t("우선 한 달 정도로 시작해도 좋아요. 기간은 나중에 조정할 수 있어요.")}</small></div>}
            {(step === "results" || step === "approach") && <div className="setup-fields">{draft.keyResults.map((row, index) => <div className="setup-result" key={index}><label><span>{step === "results" ? t("결과 {number}", { number: index + 1 }) : row.title}</span><textarea value={step === "results" ? row.title : row.initiative} maxLength={200} onChange={(event) => edit({ keyResults: draft.keyResults.map((entry, i) => i === index ? { ...entry, [step === "results" ? "title" : "initiative"]: event.target.value } : entry) })} placeholder={step === "results" ? personal ? t("예: 영어로 10분 대화하기를 8회 완료하기") : t("예: 가입 후 한 달 내 재방문율을 20%에서 30%로 높이기") : personal ? t("예: 주 2회 회화 연습하기") : t("예: 첫 사용 경험을 개선하기")} aria-invalid={step === "results" && invalid.includes("keyResults") && !row.title.trim()} /></label>{step === "results" && draft.keyResults.length > 1 && <button type="button" onClick={() => edit({ keyResults: draft.keyResults.filter((_, i) => i !== index) })} aria-label={t("결과 {number} 삭제", { number: index + 1 })}>{t("삭제")}</button>}</div>)}{step === "results" && draft.keyResults.length < 5 && <button type="button" onClick={() => edit({ keyResults: [...draft.keyResults, { title: "", initiative: "" }] })}>{t("결과 하나 더 추가")}</button>}{invalid.includes("keyResults") && <p role="alert">{t("각 결과를 적거나 비어 있는 결과를 삭제해 주세요.")}</p>}</div>}
            {step === "review" && <><dl className="setup-review"><div><dt>{t("목표 · Objective")}</dt><dd>{draft.objective}</dd></div><div><dt>{t("기간")}</dt><dd>{displayDate(draft.startDate)} — {displayDate(draft.endDate)}</dd></div>{draft.keyResults.map((row, index) => <div key={index}><dt>{t("결과 {number} · KR", { number: index + 1 })}</dt><dd>{row.title}{row.initiative && <div className="setup-initiative"><span>{t("실행 방향 · Initiative")}</span>{row.initiative}</div>}</dd></div>)}</dl><label className="setup-confirm"><input type="checkbox" aria-invalid={invalid.includes("confirm")} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>{t("이 내용으로 OKR을 저장할게요.")}</span></label>{invalid.includes("confirm") && <p role="alert">{t("내용을 확인한 뒤 체크해 주세요.")}</p>}</>}
            {step === "tour" && <><div className="setup-features">{features.map((feature) => <button type="button" key={feature.target} onClick={() => void finish(feature.target)}><span><b>{feature.title}</b><small>{feature.body}</small></span><ArrowRight size={18} /></button>)}</div>{!personal && <p>{t("팀 멤버 초대와 Slack 봇은 워크스페이스 이름 옆 톱니바퀴에서 설정해요.")}</p>}{!personal && !["member", "viewer"].includes(options.find(w => w.id === state.workspaceId)?.role ?? "owner") && <button type="button" onClick={() => void finish("members")}>{t("팀 멤버 초대하러 가기")}</button>}</>}
          </fieldset>
          {error && <div className="setup-error" role="alert"><p>{conflict ? t("다른 화면에서 설정이 변경됐어요. 최신 저장 상태를 확인한 뒤 계속해 주세요.") : error}</p><button type="button" disabled={busy} onClick={() => void reloadSaved()}>{t("저장 상태 확인")}</button></div>}
          {step === "tour" && !state.cycleId && options.find(w => w.id === state.workspaceId)?.role !== "viewer" && <button type="button" disabled={busy || conflict} onClick={() => void returnToGoal()}>{t("처음 설정 이어하기")}</button>}
          {["goal", "results", "approach"].includes(step) && <button type="button" disabled={busy || conflict} onClick={async () => { if (!await saveDraft()) return; const saved = await act({ action: "tour" }); if (saved) setStep("tour"); }}>{t("목표는 나중에 정하고 기능 먼저 둘러보기")}</button>}
          <footer className="setup-actions">{stepIndex > 0 && step !== "tour" && !(step === "goal" && state.workspaceId) && <button type="button" disabled={busy || conflict} onClick={() => { setStep(setupSteps[stepIndex - 1]); setInvalid([]); }}><ArrowLeft size={16} />{t("이전")}</button>}<button type="button" className="setup-later" onClick={() => void close()} disabled={busy}>{t("나중에 계속")}</button>{step === "tour" ? <button className="setup-primary" type="button" disabled={busy} onClick={() => void finish(state.cycleId ? "okr" : "work")}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{t("시작하기")}</button> : <button className="setup-primary" type="submit" disabled={busy || conflict}>{busy && <LoaderCircle size={16} className="spin" />}{step === "review" ? t("확인한 OKR 저장") : step === "workspace" && !personal && !selection ? t("워크스페이스 만들고 계속") : t("다음")}<ArrowRight size={16} /></button>}</footer>
          <p className="setup-save-status" role="status">{error ? t("아직 저장하지 못했어요.") : dirty ? t("입력한 내용을 저장하는 중이에요.") : t("여기까지 계정에 저장했어요. 나중에 이어서 할 수 있어요.")}</p>
        </form>
      </div>
    </section>
  </OverlayDialog>;
}
