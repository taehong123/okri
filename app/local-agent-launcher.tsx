"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  LoaderCircle,
  Play,
  RefreshCw,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { apiError, displayDate, t } from "@/lib/client-language";
import { OverlayDialog, useAppConfirm } from "./overlay-dialog";

type Device = {
  id: string;
  name: string;
  platform: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  online: boolean;
};

type Job = {
  id: string;
  deviceId: string | null;
  targetKind: string;
  targetId: string;
  targetTitle: string;
  instruction: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progressText: string | null;
  resultText: string | null;
  errorText: string | null;
  createdAt: string;
  completedAt: string | null;
};

type Pairing = { id: string; code: string; expiresAt: string };

export function LocalAgentLauncher({ targetKind, targetId, targetTitle, readOnly, onNotice }: {
  targetKind: "task" | "project";
  targetId: string;
  targetTitle: string;
  readOnly: boolean;
  onNotice: (message: string) => void;
}) {
  const confirmAction = useAppConfirm();
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [instruction, setInstruction] = useState(t("이 업무를 확인하고 필요한 작업을 진행한 뒤 변경 내용과 검증 결과를 정리해 주세요."));
  const [folder, setFolder] = useState("");
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [copyDone, setCopyDone] = useState(false);
  const [error, setError] = useState("");

  const activeDevices = useMemo(() => devices.filter((device) => !device.revokedAt), [devices]);
  const selectedDevice = activeDevices.find((device) => device.id === selectedDeviceId) ?? null;

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const query = new URLSearchParams({ targetKind, targetId });
      const [deviceResponse, jobResponse] = await Promise.all([
        fetch("/api/local-agent/devices", { cache: "no-store" }),
        fetch(`/api/local-agent/jobs?${query}`, { cache: "no-store" }),
      ]);
      const [devicePayload, jobPayload] = await Promise.all([
        deviceResponse.json() as Promise<{ devices?: Device[]; error?: string; code?: string }>,
        jobResponse.json() as Promise<{ jobs?: Job[]; error?: string; code?: string }>,
      ]);
      if (!deviceResponse.ok) throw new Error(apiError(devicePayload, t("로컬 실행기 상태를 확인하지 못했습니다.")));
      if (!jobResponse.ok) throw new Error(apiError(jobPayload, t("실행 기록을 확인하지 못했습니다.")));
      const nextDevices = devicePayload.devices ?? [];
      setDevices(nextDevices);
      setJobs(jobPayload.jobs ?? []);
      setSelectedDeviceId((current) => {
        if (nextDevices.some((device) => !device.revokedAt && device.id === current)) return current;
        return nextDevices.find((device) => !device.revokedAt && device.online)?.id
          ?? nextDevices.find((device) => !device.revokedAt)?.id
          ?? "";
      });
      setError("");
    } catch (refreshError) {
      if (!quiet) setError(refreshError instanceof Error ? refreshError.message : t("로컬 실행기 상태를 확인하지 못했습니다."));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [targetId, targetKind]);

  useEffect(() => {
    if (!open) return;
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(true), 3_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [open, refresh]);

  useEffect(() => {
    if (!open || !pairing) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/local-agent/pairing?id=${encodeURIComponent(pairing.id)}`, { cache: "no-store" });
        const payload = await response.json() as { pairing?: { status: string }; error?: string; code?: string };
        if (!response.ok) throw new Error(apiError(payload));
        if (payload.pairing?.status === "claimed") {
          setPairing(null);
          await refresh();
          onNotice(t("로컬 실행기가 연결되었습니다."));
        } else if (payload.pairing?.status === "expired") {
          setPairing(null);
          setError(t("연결 코드가 만료되었습니다. 새 코드를 만들어 주세요."));
        }
      } catch { /* The main status refresh remains available. */ }
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [onNotice, open, pairing, refresh]);

  async function createPairing() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/local-agent/pairing", { method: "POST" });
      const payload = await response.json() as { pairing?: Pairing; error?: string; code?: string };
      if (!response.ok || !payload.pairing) throw new Error(apiError(payload, t("연결 코드를 만들지 못했습니다.")));
      setPairing(payload.pairing);
      setCopyDone(false);
    } catch (pairingError) {
      setError(pairingError instanceof Error ? pairingError.message : t("연결 코드를 만들지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }

  function runnerCommand() {
    if (!pairing) return "";
    const origin = window.location.origin;
    const isWindows = /Windows/i.test(window.navigator.userAgent);
    if (isWindows) {
      const safeFolder = (folder.trim() || "C:\\path\\to\\project").replace(/'/g, "''");
      return `node "$env:USERPROFILE\\Downloads\\okri-local-agent.mjs" --url ${origin} --code ${pairing.code} --cwd '${safeFolder}'`;
    }
    const safeFolder = (folder.trim() || "/path/to/project").replace(/'/g, `'\\''`);
    return `node "$HOME/Downloads/okri-local-agent.mjs" --url ${origin} --code ${pairing.code} --cwd '${safeFolder}'`;
  }

  async function copyCommand() {
    await navigator.clipboard.writeText(runnerCommand());
    setCopyDone(true);
    window.setTimeout(() => setCopyDone(false), 2_000);
  }

  async function submitJob(event: FormEvent) {
    event.preventDefault();
    if (!selectedDeviceId || !selectedDevice?.online || !instruction.trim() || sending) return;
    setSending(true);
    setError("");
    try {
      const response = await fetch("/api/local-agent/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: selectedDeviceId, targetKind, targetId, instruction: instruction.trim() }),
      });
      const payload = await response.json() as { job?: Job; error?: string; code?: string };
      if (!response.ok || !payload.job) throw new Error(apiError(payload, t("로컬 작업을 보내지 못했습니다.")));
      setJobs((current) => [payload.job!, ...current]);
      onNotice(t("로컬 Codex에 작업을 보냈습니다."));
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t("로컬 작업을 보내지 못했습니다."));
    } finally {
      setSending(false);
    }
  }

  async function revoke(device: Device) {
    const confirmed = await confirmAction({
      title: t("로컬 실행기 연결을 해제할까요?"),
      message: t("이 기기는 새 작업을 받을 수 없게 됩니다. 실행 중인 작업은 로컬에서 직접 중지해 주세요."),
      confirmLabel: t("연결 해제"),
      danger: true,
    });
    if (!confirmed) return;
    const response = await fetch("/api/local-agent/devices", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: device.id }),
    });
    const payload = await response.json() as { error?: string; code?: string };
    if (!response.ok) { setError(apiError(payload, t("연결을 해제하지 못했습니다."))); return; }
    await refresh();
  }

  const statusLabel = (status: Job["status"]) => ({
    queued: t("대기 중"),
    running: t("실행 중"),
    completed: t("완료"),
    failed: t("실패"),
    cancelled: t("취소됨"),
  })[status];

  return (
    <>
      <button
        type="button"
        className="local-agent-launcher-button"
        disabled={readOnly}
        title={readOnly ? t("편집 권한이 있어야 로컬 Codex에 작업을 보낼 수 있습니다.") : t("내 컴퓨터의 Codex에 이 업무 맡기기")}
        onClick={() => setOpen(true)}
      >
        <SquareTerminal size={16} />{t("Codex에 맡기기")}
      </button>
      {open && <OverlayDialog title={t("로컬 Codex 실행")} className="local-agent-overlay" initialFocus="textarea, input, button" onRequestClose={() => setOpen(false)}>
        {(requestClose) => <section className="local-agent-dialog" role="document">
          <header>
            <div><SquareTerminal size={20} /><div><h2>{t("로컬 Codex 실행")}</h2><p>{targetTitle}</p></div></div>
            <button type="button" className="icon-button" aria-label={t("닫기")} onClick={() => requestClose("close-button")}><X size={17} /></button>
          </header>

          {error && <p className="local-agent-error" role="alert"><AlertTriangle size={15} />{error}</p>}
          {loading && !activeDevices.length ? <div className="local-agent-loading"><LoaderCircle className="spin" size={18} />{t("연결 상태 확인 중")}</div> : activeDevices.length === 0 ? (
            <div className="local-agent-setup">
              <div className="local-agent-intro">
                <h3>{t("이 컴퓨터를 한 번 연결하세요")}</h3>
                <p>{t("OKRI가 내 컴퓨터로 들어오지 않습니다. 실행기가 새 작업을 확인하고 선택한 폴더 안에서만 Codex를 실행합니다.")}</p>
              </div>
              <ol>
                <li><span>1</span><div><b>{t("실행기 받기")}</b><a href="/local-agent/okri-local-agent.mjs" download><Download size={15} />{t("로컬 실행기 다운로드")}</a><small>Node.js 22+ · Codex CLI</small></div></li>
                <li><span>2</span><label><b>{t("작업할 폴더")}</b><input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder={/Windows/i.test(typeof navigator === "undefined" ? "" : navigator.userAgent) ? "C:\\work\\my-project" : "/Users/me/work/my-project"} /></label></li>
                <li><span>3</span><div><b>{t("연결 명령 실행")}</b>{pairing ? <><code className="local-agent-code">{pairing.code}</code><pre>{runnerCommand()}</pre><button type="button" onClick={() => void copyCommand()}><Copy size={15} />{copyDone ? t("복사됨") : t("명령 복사")}</button><small>{t("코드는 10분 뒤 만료되고 한 번만 사용할 수 있습니다.")}</small></> : <button type="button" className="primary-action" disabled={loading} onClick={() => void createPairing()}>{loading ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}{t("연결 코드 만들기")}</button>}</div></li>
              </ol>
              <p className="local-agent-security"><CheckCircle2 size={15} />{t("Codex 로그인과 API 키는 이 브라우저나 OKRI 서버로 전송되지 않습니다.")}</p>
            </div>
          ) : (
            <>
              <form className="local-agent-job-form" onSubmit={submitJob}>
                <label><span>{t("실행할 컴퓨터")}</span><select value={selectedDeviceId} onChange={(event) => setSelectedDeviceId(event.target.value)}>{activeDevices.map((device) => <option key={device.id} value={device.id}>{device.name} · {device.online ? t("온라인") : t("오프라인")}</option>)}</select></label>
                <label><span>{t("할 일")}</span><textarea rows={5} maxLength={4_000} value={instruction} onChange={(event) => setInstruction(event.target.value)} /></label>
                {selectedDevice && !selectedDevice.online && <p className="local-agent-offline"><Clock3 size={15} />{t("실행기가 꺼져 있습니다. 아래에서 새 연결 코드를 만든 뒤 작업을 보내 주세요.")}</p>}
                <div className="local-agent-form-actions">
                  <button type="button" onClick={() => void refresh()} disabled={loading} aria-label={t("상태 새로고침")} title={t("상태 새로고침")}><RefreshCw className={loading ? "spin" : ""} size={15} /></button>
                  <button type="submit" className="primary-action" disabled={sending || !selectedDevice?.online || !instruction.trim()}>{sending ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}{sending ? t("보내는 중") : t("실행 요청")}</button>
                </div>
              </form>

              <section className="local-agent-devices" aria-label={t("연결된 실행기")}>
                <header><h3>{t("연결된 실행기")}</h3><button type="button" onClick={() => void createPairing()}>{t("다른 컴퓨터 연결")}</button></header>
                {pairing && <div className="local-agent-new-pairing">
                  <label><span>{t("작업할 폴더")}</span><input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder={/Windows/i.test(window.navigator.userAgent) ? "C:\\work\\my-project" : "/Users/me/work/my-project"} /></label>
                  <div><a href="/local-agent/okri-local-agent.mjs" download><Download size={14} />{t("로컬 실행기 다운로드")}</a><code>{pairing.code}</code><button type="button" onClick={() => void copyCommand()}><Copy size={14} />{copyDone ? t("복사됨") : t("명령 복사")}</button></div>
                  <pre>{runnerCommand()}</pre>
                  <small>{t("코드는 10분 뒤 만료되고 한 번만 사용할 수 있습니다.")}</small>
                </div>}
                {activeDevices.map((device) => <div key={device.id}><span className={device.online ? "online" : ""} aria-hidden="true" /><div><b>{device.name}</b><small>{device.online ? t("온라인") : device.lastSeenAt ? t("마지막 연결 {value1}", { value1: displayDate(device.lastSeenAt, { dateStyle: "short", timeStyle: "short" }) }) : t("연결 기록 없음")}</small></div><button type="button" className="icon-button danger" aria-label={t("{value1} 연결 해제", { value1: device.name })} onClick={() => void revoke(device)}><Trash2 size={15} /></button></div>)}
              </section>

              <section className="local-agent-history" aria-label={t("실행 기록")}>
                <h3>{t("실행 기록")}</h3>
                {jobs.length ? jobs.map((job) => <article key={job.id} data-status={job.status}>
                  <header><span>{statusLabel(job.status)}</span><time dateTime={job.createdAt}>{displayDate(job.createdAt, { dateStyle: "short", timeStyle: "short" })}</time></header>
                  <p>{job.instruction}</p>
                  {job.status === "running" && <small><LoaderCircle className="spin" size={14} />{job.progressText || t("Codex가 로컬에서 작업 중입니다.")}</small>}
                  {job.resultText && <pre>{job.resultText}</pre>}
                  {job.errorText && <p className="local-agent-job-error">{job.errorText}</p>}
                </article>) : <p className="local-agent-empty">{t("아직 실행 기록이 없습니다.")}</p>}
              </section>
            </>
          )}
        </section>}
      </OverlayDialog>}
    </>
  );
}
