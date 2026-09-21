"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, DatabaseBackup, LoaderCircle, RefreshCw, RotateCcw, ShieldCheck } from "lucide-react";
import { useAppConfirm } from "./overlay-dialog";
import type { BackupReason, BackupSummary } from "@/lib/workspace-backups";
import "./workspace-backups.css";
import { t , apiError , getClientLocale , messageValue } from "@/lib/client-language";

type Entry = { id: string; reason: BackupReason; createdAt: string; expiresAt: string; byteSize: number; summary: BackupSummary };
type Listing = { backups: Entry[]; nextCursor: string | null; state: { last_success_at: string | null; last_daily_date: string | null; last_attempt_at: string | null; last_error: string | null } | null };
type Preview = Entry & { current: BackupSummary; cycles: Array<{ id: string; name: string; version: number; startDate: string; endDate: string }>; projects: Array<{ id: string; title: string; status: string }> };
const reasonLabels: Record<BackupReason, string> = { daily: "일일 자동 백업", manual: "수동 백업", before_cleanup: "클린업 전", before_okr_delete: "OKR 파일 삭제 전", before_restore: "복원 직전 상태" };
const backupSummaryLabels: Record<keyof BackupSummary, string> = { cycles: "OKR 파일", objectives: "Objective", keyResults: "Key Result", initiatives: "Initiative", projects: "Project", tasks: "Task", routines: "Routine", documents: "프로젝트 본문", dailyReports: "데일리 기록" };
const formatTime = (value: string) => new Intl.DateTimeFormat(getClientLocale(), { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

async function requestBackup<T>(workspaceId: string, path = "", method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  // Only reads time out: losing a write response does not mean the write failed.
  const controller = method === "GET" ? new AbortController() : null;
  let timedOut = false;
  const abort = () => controller?.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = controller ? setTimeout(() => { timedOut = true; controller.abort(); }, 15_000) : undefined;
  try {
    const response = await fetch(`/api/workspace-backups${path}`, { method, headers: { "x-okri-workspace-id": workspaceId, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: "no-store", signal: controller?.signal ?? signal });
    const data = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(apiError(data, "백업 작업을 완료하지 못했습니다."));
    return data;
  } catch (error) {
    if (timedOut) throw new Error(t("백업 조회가 지연되고 있습니다. 다시 시도해 주세요."));
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export default function WorkspaceBackups({ workspaceId, workspaceName, onNotice }: { workspaceId: string; workspaceName: string; onNotice: (message: string) => void }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState("loading");
  const [error, setError] = useState("");
  const [restored, setRestored] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const confirm = useAppConfirm();
  async function request<T = unknown>(path = "", method = "GET", body?: unknown): Promise<T> {
    return requestBackup<T>(workspaceId, path, method, body);
  }
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    requestBackup<Listing>(workspaceId, "", "GET", undefined, controller.signal)
      .then((data) => { if (mounted.current) setListing(data); })
      .catch((err) => { if (!controller.signal.aborted && mounted.current) setError(err instanceof Error ? err.message : t("백업 목록을 불러오지 못했습니다.")); })
      .finally(() => { if (mounted.current) setBusy(""); });
    return () => { mounted.current = false; controller.abort(); };
  }, [workspaceId]);

  async function perform(kind: string, operation: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(kind); setError("");
    try { await operation(); }
    catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : t("백업 작업을 완료하지 못했습니다.")); }
    finally { inFlight.current = false; if (mounted.current) setBusy(""); }
  }
  const reload = () => perform("loading", async () => { const next = await request<Listing>(); if (mounted.current) setListing(next); });
  const create = () => perform("create", async () => { await request("", "POST", { action: "create" }); const next = await request<Listing>(); if (mounted.current) { setListing(next); onNotice(t("현재 상태를 백업했습니다.")); } });
  const inspect = (id: string) => perform(id, async () => { const next = await request<Preview>(`?id=${encodeURIComponent(id)}`); if (mounted.current) setPreview(next); });
  async function restore() {
    if (!preview || busy || restored) return;
    const selected = preview;
    if (!await confirm({ title: t("이 날짜로 복원할까요?"), message: t("{value1}의 업무 데이터를 {value2} 상태로 바꿉니다. 이후 추가한 업무는 현재 화면에서 사라집니다. 복원 직전 상태도 자동 백업하므로 다시 되돌릴 수 있습니다. 멤버·권한·연동·결제 정보는 변경하지 않습니다.", { value1: messageValue(workspaceName), value2: messageValue(formatTime(selected.createdAt)) }), confirmLabel: t("백업 후 복원"), danger: true })) return;
    await perform("restore", async () => {
      await request("", "PATCH", { action: "restore", id: selected.id, confirmation: "RESTORE WORKSPACE" });
      setRestored(true);
      onNotice(t("복원했습니다. 복원 직전 상태도 백업에 보관했습니다."));
      // Reload every cached view and document editor after the atomic restore.
      window.location.assign(`/?settings=workspace&tab=backups`);
    });
  }

  return <div className="workspace-backups" aria-busy={Boolean(busy)}>
    <header className="backup-header"><div><h3>{t("백업 및 복원")}</h3><p>{t("30일 보관 · 한국 시간 기준")}</p></div><div className="backup-actions"><button type="button" onClick={() => void reload()} disabled={Boolean(busy)} aria-label={t("백업 목록 새로고침")} title={t("새로고침")}><RefreshCw size={15} /></button><button type="button" onClick={() => void create()} disabled={Boolean(busy)}>{busy === "create" ? <LoaderCircle className="spin" size={15} /> : <DatabaseBackup size={15} />}{busy === "create" ? t("백업 중") : t("지금 백업")}</button></div></header>
    {error && <p className="backup-error" role="alert">{error}</p>}
    {listing?.state?.last_error && <p className="backup-error" role="status">{t("최근 백업 작업을 완료하지 못했습니다. 다시 시도해 주세요.")}</p>}
    <div className="backup-scope"><ShieldCheck size={17} /><p>{t("OKR·Project·Ticket·Task·루틴·속성·프로젝트 본문·데일리 기록을 보관합니다. 멤버·그룹·권한·연동·결제·휴지통·첨부파일은 복원 대상에서 제외됩니다.")}</p></div>
    {listing?.state?.last_success_at && <p className="backup-last">{t("마지막 백업")}{formatTime(listing.state.last_success_at)}</p>}
    {listing && <p className="backup-last">{listing.state?.last_daily_date ? t("최근 자동 백업 {value1}", { value1: messageValue(listing.state.last_daily_date) }) : t("자동 백업 실행 기록이 아직 없습니다.")}</p>}
    {busy && <p className="backup-progress" role="status"><LoaderCircle className="spin" size={16} />{busy === "restore" ? t("현재 상태를 백업하고 복원하고 있습니다. 완료될 때까지 기다려 주세요.") : busy === "create" ? t("현재 데이터를 별도 저장소에 백업하고 있습니다.") : t("백업을 불러오고 있습니다.")}</p>}
    {preview ? <section className="backup-preview">
      <button className="backup-back" type="button" disabled={Boolean(busy)} onClick={() => setPreview(null)}><ArrowLeft size={14} />{t("백업 목록")}</button>
      <header><h4>{formatTime(preview.createdAt)}</h4><p>{t(reasonLabels[preview.reason])} · {t("{date}까지 보관", { date: formatTime(preview.expiresAt) })}</p></header>
      <table><caption>{t("복원 전 항목 수 비교")}</caption><thead><tr><th scope="col">{t("데이터")}</th><th scope="col">{t("현재")}</th><th scope="col">{t("복원 후")}</th></tr></thead><tbody>{(Object.keys(backupSummaryLabels) as Array<keyof BackupSummary>).map((key) => <tr key={key}><th scope="row">{t(backupSummaryLabels[key])}</th><td>{preview.current[key]}</td><td>{preview.summary[key]}</td></tr>)}</tbody></table>
      <p className="backup-last">{t("항목 수에는 아카이브된 업무도 포함됩니다. 탈퇴한 멤버의 담당 지정과 개인 데일리 초안은 복원하지 않습니다.")}</p>
      <details><summary>{t("백업에 포함된 OKR·Project")}</summary><ul>{preview.cycles.map((cycle) => <li key={cycle.id}><b>{cycle.name} · v{cycle.version}</b><small>{cycle.startDate} ~ {cycle.endDate}</small></li>)}{preview.projects.map((project) => <li key={project.id}><span>{project.title}</span><small>{project.status}</small></li>)}</ul>{preview.summary.projects > preview.projects.length && <p>{t("Project는 처음 100개까지 표시합니다.")}</p>}</details>
      <button className="backup-restore" type="button" disabled={Boolean(busy) || restored} onClick={() => void restore()}>{busy === "restore" ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}{t("이 날짜로 복원")}</button>
    </section> : <section aria-label={t("날짜별 백업 목록")}>
      {listing && !listing.backups.length && <p className="backup-empty">{t("아직 백업이 없습니다. 지금 첫 백업을 만들 수 있습니다.")}</p>}
      <ul className="backup-list">{listing?.backups.map((entry) => <li key={entry.id}><div><time dateTime={entry.createdAt}>{formatTime(entry.createdAt)}</time><span>{t(reasonLabels[entry.reason])}</span><small>OKR {entry.summary.cycles} · Project {entry.summary.projects} · Task {entry.summary.tasks} · {Math.max(1, Math.round(entry.byteSize / 1024))} KB</small></div><button type="button" onClick={() => void inspect(entry.id)} disabled={Boolean(busy)} aria-label={t("{value1} 백업 미리보기", { value1: messageValue(formatTime(entry.createdAt)) })}>{t("미리보기")}</button></li>)}</ul>
      {listing?.nextCursor && <button type="button" disabled={Boolean(busy)} onClick={() => void perform("more", async () => { const next = await request(`?before=${encodeURIComponent(listing.nextCursor!)}`) as Listing; if (mounted.current) setListing({ ...next, backups: [...listing.backups, ...next.backups] }); })}>{t("이전 백업 더 보기")}</button>}
    </section>}
  </div>;
}
