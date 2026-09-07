"use client";

import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Briefcase,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  ListChecks,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Target,
  Trash2,
  X,
} from "lucide-react";
import { t , apiError , messageValue } from "@/lib/client-language";

type ItemStatus = "backlog" | "todo" | "policy_discussion" | "in_progress" | "developing" | "development_done" | "done" | "blocked";
type CycleStatus = "planned" | "active" | "closed";

export type OkrFileCycleSummary = {
  id: string;
  name: string;
  department: string;
  version: number;
  startDate: string;
  endDate: string;
  status: CycleStatus;
  createdAt: string;
  updatedAt: string;
};

type LinkedProject = {
  id: string;
  title: string;
  parentId: string;
  cycleId: string | null;
  taskCount: number;
  canTrash: boolean;
  updatedAt: string;
};

type Initiative = {
  id: string | null;
  clientId: string;
  title: string;
  status: ItemStatus;
  sortOrder?: number;
  updatedAt?: string;
  linkedProjects: LinkedProject[];
};

type KeyResult = {
  id: string | null;
  clientId: string;
  title: string;
  status: ItemStatus;
  progress: number;
  sortOrder?: number;
  updatedAt?: string;
  initiatives: Initiative[];
};

type Objective = {
  id: string | null;
  clientId: string;
  title: string;
  status: ItemStatus;
  updatedAt?: string;
  keyResults: KeyResult[];
};

type InitiativeOption = { id: string; title: string; cycleId: string; cycleName: string };
type OkrFile = {
  cycle: OkrFileCycleSummary;
  revision: string;
  objective: Objective | null;
  objectiveCount: number;
  needsSplit: boolean;
  initiativeOptions: InitiativeOption[];
};

type Draft = {
  metadata: { name: string; department: string; startDate: string; endDate: string; status: CycleStatus };
  objective: Objective;
};

type Resolution = { action: "move" | "trash"; targetInitiativeRef?: string };
type ConfirmOptions = { title: string; message: string; confirmLabel: string; danger?: boolean };

export type OkrExecutionItem = {
  id: string;
  parentId: string | null;
  cycleId: string | null;
  kind: "objective" | "key_result" | "initiative" | "project" | "task";
  title: string;
  status: ItemStatus | "archived";
  progress: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

const editableOkrRequests = new Map<string, Promise<OkrFile>>();
const okrExpandedRows = new Map<string, Set<string>>();

async function fetchEditableOkrFile(workspaceId: string, cycleId: string) {
  const key = `${workspaceId}:${cycleId}`;
  const pending = editableOkrRequests.get(key);
  if (pending) return pending;
  const request = (async () => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(`/api/okr-files/${encodeURIComponent(cycleId)}`, {
        signal: controller.signal,
        cache: "no-store",
      });
      const data = await response.json() as { file?: OkrFile; error?: string };
      if (!response.ok || !data.file) throw new Error(apiError(data, "OKR 파일을 불러오지 못했습니다."));
      return data.file;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw new Error(t("응답이 오래 걸려 불러오기를 중단했습니다. 다시 시도해 주세요."));
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  })();
  editableOkrRequests.set(key, request);
  void request.finally(() => {
    if (editableOkrRequests.get(key) === request) editableOkrRequests.delete(key);
  }).catch(() => undefined);
  return request;
}

function buildBootstrapOkrFile(cycle: OkrFileCycleSummary, items: OkrExecutionItem[], focusId?: string | null): OkrFile {
  const rows = items
    .filter((item): item is OkrExecutionItem & { status: ItemStatus } => item.cycleId === cycle.id && !item.archivedAt && item.status !== "archived" && ["objective", "key_result", "initiative"].includes(item.kind))
    .sort(compareExecutionItems);
  const objectives = rows.filter((item) => item.kind === "objective");
  let target = rows.find((row) => row.id === focusId);
  for (let depth = 0; target?.parentId && depth < 3; depth += 1) target = rows.find((row) => row.id === target?.parentId);
  const objectiveRow = objectives.find((row) => row.id === target?.id) ?? objectives[0] ?? null;
  const keyResultRows = objectiveRow ? rows.filter((item) => item.kind === "key_result" && item.parentId === objectiveRow.id) : [];
  const objective: Objective | null = objectiveRow ? {
    id: objectiveRow.id,
    clientId: objectiveRow.id,
    title: objectiveRow.title,
    status: objectiveRow.status,
    updatedAt: objectiveRow.updatedAt,
    keyResults: keyResultRows.map((keyResult) => ({
      id: keyResult.id,
      clientId: keyResult.id,
      title: keyResult.title,
      status: keyResult.status,
      progress: keyResult.progress,
      sortOrder: keyResult.sortOrder,
      updatedAt: keyResult.updatedAt,
      initiatives: rows
        .filter((item) => item.kind === "initiative" && item.parentId === keyResult.id)
        .map((initiative) => ({
          id: initiative.id,
          clientId: initiative.id,
          title: initiative.title,
          status: initiative.status,
          sortOrder: initiative.sortOrder,
          updatedAt: initiative.updatedAt,
          linkedProjects: [],
        })),
    })),
  } : null;
  return {
    cycle,
    revision: `bootstrap:${cycle.updatedAt}:${rows.map((item) => `${item.id}:${item.updatedAt}`).join("|")}`,
    objective,
    objectiveCount: objectives.length,
    needsSplit: objectives.length > 1,
    initiativeOptions: [],
  };
}

const statuses: Array<{ value: ItemStatus; label: string }> = [
  { value: "backlog", get label() { return t("백로그"); } },
  { value: "todo", get label() { return t("할 일"); } },
  { value: "policy_discussion", get label() { return t("정책 논의 중"); } },
  { value: "in_progress", get label() { return t("진행 중"); } },
  { value: "developing", get label() { return t("개발 중"); } },
  { value: "development_done", get label() { return t("개발 완료"); } },
  { value: "done", get label() { return t("완료"); } },
  { value: "blocked", get label() { return t("막힘"); } },
];

const cycleStatuses: Array<{ value: CycleStatus; label: string }> = [
  { value: "planned", get label() { return t("예정"); } },
  { value: "active", get label() { return t("진행 중"); } },
  { value: "closed", get label() { return t("종료"); } },
];

export function OkrFileSurface({
  focusId,
  workspaceId,
  cycle,
  creating = false,
  readOnly,
  executionItems,
  onSaved,
  onSplit,
  onCancelCreate,
  onOpenProject,
  onOpenTask,
  onNotice,
  onDirtyChange,
  onConfirm,
}: {
  focusId?: string | null;
  workspaceId: string;
  cycle: OkrFileCycleSummary | null;
  creating?: boolean;
  readOnly: boolean;
  executionItems: OkrExecutionItem[];
  onSaved: (file: OkrFile) => void;
  onSplit: (cycles: OkrFileCycleSummary[]) => void;
  onCancelCreate: () => void;
  onOpenProject: (id: string) => void;
  onOpenTask: (id: string) => void;
  onNotice: (message: string, tone?: "error") => void;
  onDirtyChange: (dirty: boolean) => void;
  onConfirm: (options: ConfirmOptions) => Promise<boolean>;
}) {
  const cycleId = cycle?.id ?? null;
  const fileCacheKey = cycleId ? `${workspaceId}:${cycleId}` : `${workspaceId}:new`;
  const readFile = useMemo(() => !creating && cycle ? buildBootstrapOkrFile(cycle, executionItems, focusId) : null, [creating, cycle, executionItems, focusId]);
  const initialEditorDraft = readFile ? draftFromFile(readFile) : emptyDraft();
  const [file, setFile] = useState<OkrFile | null>(null);
  const [draft, setDraft] = useState<Draft>(initialEditorDraft);
  const [initialDraft, setInitialDraft] = useState(() => JSON.stringify({ draft: initialEditorDraft, resolutions: {} }));
  const [editing, setEditing] = useState(creating);
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({});
  const [editLoading, setEditLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set(okrExpandedRows.get(fileCacheKey) ?? []));
  const focusedKeyResultId = readFile?.objective?.keyResults.find((row) => row.initiatives.some((initiative) => initiative.id === focusId))?.id;
  useEffect(() => {
    if (!focusId || editing) return;
    const timer = window.setTimeout(() => {
      if (focusedKeyResultId) setExpandedRows((current) => {
        const next = new Set([...current, focusedKeyResultId]);
        okrExpandedRows.set(fileCacheKey, next); return next;
      });
      window.requestAnimationFrame(() => {
        const target = document.getElementById(`okr-search-${focusId}`);
        target?.scrollIntoView({ block: "center" }); target?.focus({ preventScroll: true });
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusId, focusedKeyResultId, editing, fileCacheKey]);

  const currentSnapshot = JSON.stringify({ draft, resolutions });
  const dirty = editing && currentSnapshot !== initialDraft;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const preventUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [dirty]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const originalInitiatives = useMemo(() => file?.objective?.keyResults.flatMap((keyResult) => keyResult.initiatives) ?? [], [file]);
  const draftInitiatives = useMemo(() => draft.objective.keyResults.flatMap((keyResult) => keyResult.initiatives), [draft]);
  const retainedInitiativeIds = new Set(draftInitiatives.map((initiative) => initiative.id).filter(Boolean));
  const removedInitiatives = originalInitiatives.filter((initiative) => initiative.id && !retainedInitiativeIds.has(initiative.id));
  const impactedProjects = removedInitiatives.flatMap((initiative) => initiative.linkedProjects);
  const originalKeyResultIds = new Set(file?.objective?.keyResults.map((keyResult) => keyResult.id).filter(Boolean) ?? []);
  const retainedKeyResultIds = new Set(draft.objective.keyResults.map((keyResult) => keyResult.id).filter(Boolean));
  const removedKeyResultCount = [...originalKeyResultIds].filter((id) => !retainedKeyResultIds.has(id)).length;
  const resolutionOptions = useMemo(() => {
    const removedIds = new Set(removedInitiatives.map((initiative) => initiative.id));
    const local = draftInitiatives.map((initiative) => ({ ref: initiative.clientId, label: `${draft.metadata.name || "현재 파일"} · ${initiative.title || "새 Initiative"}` }));
    const external = (file?.initiativeOptions ?? []).filter((initiative) => !removedIds.has(initiative.id) && !draftInitiatives.some((entry) => entry.id === initiative.id)).map((initiative) => ({ ref: initiative.id, label: `${initiative.cycleName} · ${initiative.title}` }));
    return [...local, ...external];
  }, [draft.metadata.name, draftInitiatives, file?.initiativeOptions, removedInitiatives]);
  const executionTree = useMemo(() => {
    const completed = new Set<ItemStatus>(["done", "development_done"]);
    const tasksByProject = new Map<string, OkrExecutionItem[]>();
    const projectsByInitiative = new Map<string, OkrExecutionItem[]>();
    const activeRows = executionItems.filter((item): item is OkrExecutionItem & { status: ItemStatus } => !item.archivedAt && item.status !== "archived");
    for (const task of activeRows) {
      if (task.kind !== "task" || !task.parentId || completed.has(task.status)) continue;
      tasksByProject.set(task.parentId, [...(tasksByProject.get(task.parentId) ?? []), task]);
    }
    for (const project of activeRows) {
      if (project.kind !== "project" || !project.parentId) continue;
      const hasIncompleteTasks = Boolean(tasksByProject.get(project.id)?.length);
      if (completed.has(project.status) && !hasIncompleteTasks) continue;
      projectsByInitiative.set(project.parentId, [...(projectsByInitiative.get(project.parentId) ?? []), project]);
    }
    for (const rows of [...tasksByProject.values(), ...projectsByInitiative.values()]) rows.sort(compareExecutionItems);
    return { projectsByInitiative, tasksByProject };
  }, [executionItems]);

  function toggleExpanded(id: string) {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      okrExpandedRows.set(fileCacheKey, next);
      return next;
    });
  }

  async function beginEdit() {
    if (!readFile || !cycleId || editLoading) return;
    setEditLoading(true);
    setError("");
    try {
      const editableFile = await fetchEditableOkrFile(workspaceId, cycleId);
      setFile(editableFile);
      const next = draftFromFile(editableFile);
      setDraft(next);
      setResolutions({});
      setInitialDraft(JSON.stringify({ draft: next, resolutions: {} }));
      setEditing(true);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("편집 정보를 불러오지 못했습니다."));
    } finally {
      setEditLoading(false);
    }
  }

  async function cancelEdit() {
    if (dirty && !await onConfirm({ title: "수정 취소", message: "저장하지 않은 변경사항을 버릴까요?", confirmLabel: "변경사항 버리기", danger: true })) return;
    onDirtyChange(false);
    if (creating) {
      onCancelCreate();
      return;
    }
    setFile(null);
    if (readFile) setDraft(draftFromFile(readFile));
    setResolutions({});
    setEditing(false);
    setError("");
  }

  async function save() {
    if (saving) return;
    if (!draft.metadata.name.trim() || !draft.objective.title.trim()) {
      setError(t("파일명과 Objective를 입력해 주세요."));
      return;
    }
    if (!draft.objective.keyResults.length || draft.objective.keyResults.some((keyResult) => !keyResult.title.trim() || keyResult.initiatives.some((initiative) => !initiative.title.trim()))) {
      setError(t("KR은 한 개 이상 필요하며 KR·Initiative의 빈 제목을 채워야 합니다."));
      return;
    }
    const unresolved = impactedProjects.filter((project) => {
      const resolution = resolutions[project.id];
      return !resolution || resolution.action === "move" && !resolution.targetInitiativeRef;
    });
    if (unresolved.length) {
      setError(t("연결된 Project {value1}개의 이동 또는 휴지통 처리를 선택해 주세요.", { value1: messageValue(unresolved.length) }));
      return;
    }
    if (removedKeyResultCount || removedInitiatives.length || impactedProjects.length) {
      const taskCount = impactedProjects.reduce((total, project) => total + project.taskCount, 0);
      const confirmed = await onConfirm({
        title: "OKR 파일 변경사항 저장",
        message: t("KR {value1}개와 Initiative {value2}개가 삭제됩니다.\n영향받는 Project는 {value3}개, 하위 Task는 {value4}개입니다.\n선택한 Project 이동·휴지통 처리와 함께 저장할까요?", { value1: messageValue(removedKeyResultCount), value2: messageValue(removedInitiatives.length), value3: messageValue(impactedProjects.length), value4: messageValue(taskCount) }),
        confirmLabel: "전체 변경 저장",
        danger: true,
      });
      if (!confirmed) return;
    }
    setSaving(true);
    setError("");
    const payload = {
      expectedRevision: file?.revision ?? null,
      metadata: draft.metadata,
      objective: {
        id: draft.objective.id,
        clientId: draft.objective.clientId,
        title: draft.objective.title,
        status: draft.objective.status,
        keyResults: draft.objective.keyResults.map((keyResult) => ({
          id: keyResult.id,
          clientId: keyResult.clientId,
          title: keyResult.title,
          status: keyResult.status,
          progress: keyResult.progress,
          initiatives: keyResult.initiatives.map((initiative) => ({ id: initiative.id, clientId: initiative.clientId, title: initiative.title, status: initiative.status })),
        })),
      },
      projectResolutions: impactedProjects.map((project) => ({ projectId: project.id, ...resolutions[project.id] })),
    };
    try {
      const response = await fetch(creating ? "/api/okr-files" : `/api/okr-files/${encodeURIComponent(cycleId!)}`, {
        method: creating ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json() as { file?: OkrFile; error?: string };
      if (!response.ok || !data.file) {
        if (response.status === 409) throw new Error(t("다른 사용자가 이 파일을 먼저 수정했습니다. 다시 불러온 뒤 변경해 주세요."));
        throw new Error(apiError(data, "OKR 파일을 저장하지 못했습니다."));
      }
      const next = draftFromFile(data.file);
      setDraft(next);
      setFile(null);
      setResolutions({});
      setInitialDraft(JSON.stringify({ draft: next, resolutions: {} }));
      setEditing(false);
      onDirtyChange(false);
      onSaved(data.file);
      onNotice(creating ? t("OKR 파일을 만들었습니다.") : t("OKR 파일 전체를 저장했습니다."));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t("OKR 파일을 저장하지 못했습니다."));
    } finally {
      setSaving(false);
    }
  }

  async function splitFile() {
    if (!readFile || !await onConfirm({ title: "Objective별 파일 분리", message: t("이 파일의 Objective {value1}개를 각각 별도 OKR 파일로 분리합니다. Project와 Task 연결은 그대로 유지됩니다.", { value1: messageValue(readFile.objectiveCount) }), confirmLabel: "파일 분리" })) return;
    setSaving(true);
    const response = await fetch(`/api/okr-files/${encodeURIComponent(readFile.cycle.id)}/split`, { method: "POST" });
    const data = await response.json() as { split?: boolean; cycles?: OkrFileCycleSummary[]; error?: string };
    setSaving(false);
    if (!response.ok || !data.cycles) {
      setError(apiError(data, "OKR 파일을 분리하지 못했습니다."));
      return;
    }
    onSplit(data.cycles);
    onNotice(t("Objective별로 OKR 파일을 분리했습니다."));
  }

  if (editing) {
    return <section className="okr-file-editor" aria-label={t("OKR 파일 전체 수정")}>
      <header className="okr-file-editor-toolbar">
        <div><span>{t("OKR 파일")}</span><h2>{creating ? t("새 파일 만들기") : t("파일 전체 수정")}</h2></div>
        <div><button type="button" onClick={() => void cancelEdit()} disabled={saving}><X size={14} />{t("취소")}</button><button type="button" className="primary" onClick={() => void save()} disabled={saving || !dirty && !creating}>{saving ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}{saving ? t("저장 중") : t("파일 저장")}</button></div>
      </header>
      <div className="okr-file-editor-body">
        <section className="okr-file-metadata-editor">
          <label className="wide"><span>{t("파일명")}</span><input value={draft.metadata.name} onChange={(event) => setDraft((current) => ({ ...current, metadata: { ...current.metadata, name: event.target.value } }))} /></label>
          <label><span>{t("부서")}</span><input value={draft.metadata.department} onChange={(event) => setDraft((current) => ({ ...current, metadata: { ...current.metadata, department: event.target.value } }))} placeholder={t("부서 미지정")} /></label>
          <label><span>{t("파일 상태")}</span><select value={draft.metadata.status} onChange={(event) => setDraft((current) => ({ ...current, metadata: { ...current.metadata, status: event.target.value as CycleStatus } }))}>{cycleStatuses.map((status) => <option value={status.value} key={status.value}>{status.label}</option>)}</select></label>
          <label><span>{t("시작일")}</span><input type="date" value={draft.metadata.startDate} onChange={(event) => setDraft((current) => ({ ...current, metadata: { ...current.metadata, startDate: event.target.value } }))} /></label>
          <label><span>{t("종료일")}</span><input type="date" value={draft.metadata.endDate} onChange={(event) => setDraft((current) => ({ ...current, metadata: { ...current.metadata, endDate: event.target.value } }))} /></label>
        </section>
        <section className="okr-file-objective-editor">
          <header><span className="type-icon type-objective">O</span><div><small>{t("Objective")}</small><textarea rows={2} value={draft.objective.title} onChange={(event) => setDraft((current) => ({ ...current, objective: { ...current.objective, title: event.target.value } }))} placeholder={t("이번 주기에 달성할 하나의 목표")} /></div><StatusSelect value={draft.objective.status} onChange={(status) => setDraft((current) => ({ ...current, objective: { ...current.objective, status } }))} /></header>
          <div className="okr-file-key-results">
            {draft.objective.keyResults.map((keyResult, keyResultIndex) => <section className="okr-file-key-result-editor" key={keyResult.clientId}>
              <header>
                <span className="type-icon type-key_result">KR</span>
                <div><small>{t("Key Result")}{keyResultIndex + 1}</small><textarea rows={2} value={keyResult.title} onChange={(event) => patchKeyResult(setDraft, keyResult.clientId, { title: event.target.value })} placeholder={t("측정 가능한 핵심 결과")} /></div>
                <div className="okr-file-row-tools"><button type="button" disabled={keyResultIndex === 0} onClick={() => moveKeyResult(setDraft, keyResultIndex, -1)} aria-label={t("KR 위로 이동")}><ArrowUp size={13} /></button><button type="button" disabled={keyResultIndex === draft.objective.keyResults.length - 1} onClick={() => moveKeyResult(setDraft, keyResultIndex, 1)} aria-label={t("KR 아래로 이동")}><ArrowDown size={13} /></button><button type="button" className="danger" disabled={draft.objective.keyResults.length === 1} onClick={() => setDraft((current) => ({ ...current, objective: { ...current.objective, keyResults: current.objective.keyResults.filter((entry) => entry.clientId !== keyResult.clientId) } }))} aria-label={t("KR 삭제")}><Trash2 size={13} /></button></div>
              </header>
              <div className="okr-file-kr-metrics"><StatusSelect value={keyResult.status} onChange={(status) => patchKeyResult(setDraft, keyResult.clientId, { status, ...(status === "done" || status === "development_done" ? { progress: 100 } : {}) })} /><label><span>{t("진척도")}</span><input type="range" min="0" max="100" step="5" value={keyResult.progress} onChange={(event) => patchKeyResult(setDraft, keyResult.clientId, { progress: Number(event.target.value) })} /><b>{keyResult.progress}%</b></label></div>
              <div className="okr-file-initiatives">
                {keyResult.initiatives.map((initiative, initiativeIndex) => <div className="okr-file-initiative-editor" key={initiative.clientId}>
                  <span className="type-icon type-initiative">I</span>
                  <div><small>{t("Initiative")}{initiativeIndex + 1}</small><textarea rows={2} value={initiative.title} onChange={(event) => patchInitiative(setDraft, initiative.clientId, { title: event.target.value })} placeholder={t("이 KR을 움직일 실행 방향")} /></div>
                  <select value={keyResult.clientId} onChange={(event) => moveInitiativeToKeyResult(setDraft, initiative.clientId, event.target.value)} aria-label={t("상위 KR 변경")}>{draft.objective.keyResults.map((target, index) => <option value={target.clientId} key={target.clientId}>KR {index + 1}</option>)}</select>
                  <StatusSelect value={initiative.status} onChange={(status) => patchInitiative(setDraft, initiative.clientId, { status })} />
                  <div className="okr-file-row-tools"><button type="button" disabled={initiativeIndex === 0} onClick={() => moveInitiative(setDraft, keyResult.clientId, initiativeIndex, -1)} aria-label={t("Initiative 위로 이동")}><ArrowUp size={12} /></button><button type="button" disabled={initiativeIndex === keyResult.initiatives.length - 1} onClick={() => moveInitiative(setDraft, keyResult.clientId, initiativeIndex, 1)} aria-label={t("Initiative 아래로 이동")}><ArrowDown size={12} /></button><button type="button" className="danger" onClick={() => removeInitiative(setDraft, initiative.clientId)} aria-label={t("Initiative 삭제")}><Trash2 size={12} /></button></div>
                </div>)}
                <button type="button" className="okr-file-add-row" onClick={() => addInitiative(setDraft, keyResult.clientId)}><Plus size={13} />{t("Initiative 추가")}</button>
              </div>
            </section>)}
            <button type="button" className="okr-file-add-kr" onClick={() => addKeyResult(setDraft)}><Plus size={14} />{t("Key Result 추가")}</button>
          </div>
        </section>
        {impactedProjects.length > 0 && <section className="okr-project-resolutions">
          <header><AlertTriangle size={16} /><div><b>{t("연결 Project 정리 필요")}</b><p>{t("삭제되는 Initiative 아래 Project는 다른 Initiative로 이동하거나 휴지통으로 보내야 합니다.")}</p></div></header>
          {impactedProjects.map((project) => {
            const value = resolutions[project.id]?.action === "trash" ? "trash" : resolutions[project.id]?.targetInitiativeRef ? `move:${resolutions[project.id].targetInitiativeRef}` : "";
            return <label key={project.id}><span><Briefcase size={13} /><b>{project.title}</b><small>{t("{kind} · {count}", { kind: t("하위 Task"), count: project.taskCount })}</small></span><select value={value} onChange={(event) => {
              const next = event.target.value;
              setError("");
              setResolutions((current) => ({ ...current, [project.id]: next === "trash" ? { action: "trash" } : next.startsWith("move:") ? { action: "move", targetInitiativeRef: next.slice(5) } : { action: "move" } }));
            }}><option value="">{t("처리 방법 선택")}</option><optgroup label={t("다른 Initiative로 이동")}>{resolutionOptions.map((option) => <option value={`move:${option.ref}`} key={option.ref}>{option.label}</option>)}</optgroup>{project.canTrash && <option value="trash">{t("Project·Task를 휴지통으로 이동")}</option>}</select>{!project.canTrash && <small>{t("생성자 또는 책임자만 휴지통으로 이동할 수 있습니다.")}</small>}</label>;
          })}
        </section>}
        {error && <p className="okr-file-editor-error" role="alert">{error}</p>}
      </div>
      <footer className="okr-file-editor-footer"><span>{dirty ? t("저장하지 않은 변경사항이 있습니다.") : t("변경사항 없음")}</span><div><button type="button" onClick={() => void cancelEdit()} disabled={saving}>{t("취소")}</button><button type="button" className="primary" onClick={() => void save()} disabled={saving || !dirty && !creating}><Check size={14} />{t("전체 저장")}</button></div></footer>
    </section>;
  }

  if (!readFile) return null;
  if (readFile.needsSplit) return <section className="okr-file-repair"><AlertTriangle size={22} /><div><h2>{t("Objective별 파일 분리가 필요합니다")}</h2><p>{t("이 파일에는 Objective가 {count}개 있습니다. 데이터는 자동으로 바꾸지 않았습니다.", { count: readFile.objectiveCount })}</p></div>{!readOnly && <button onClick={() => void splitFile()} disabled={saving}>{saving ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}{t("Objective별 파일로 분리")}</button>}</section>;

  return <article className="okr-file-read-surface">
    {error && <div className="okr-file-refresh-state error" role="status"><AlertTriangle size={12} />{error}</div>}
    {readFile.objective ? <section className="okr-file-read-tree">
      <div id={`okr-search-${readFile.objective.id}`} tabIndex={-1} className={`okr-file-read-objective ${focusId === readFile.objective.id ? "search-target" : ""}`}>
        <span className="type-icon type-objective">O</span>
        <div><small>{t("Objective")}</small><h3>{readFile.objective.title}</h3></div>
        {!readOnly && <button type="button" className="icon-button" onClick={() => void beginEdit()} disabled={editLoading} aria-busy={editLoading} aria-label={t("파일 수정")} title={editLoading ? t("편집 준비 중") : t("파일 수정")}>
          {editLoading ? <LoaderCircle className="spin" size={16} /> : <Pencil size={16} />}
        </button>}
      </div>
      {readFile.objective.keyResults.map((keyResult, keyResultIndex) => <OkrReadKeyResult
        key={keyResult.id}
        keyResult={keyResult}
        focusId={focusId}
        keyResultIndex={keyResultIndex}
        projectsByInitiative={executionTree.projectsByInitiative}
        tasksByProject={executionTree.tasksByProject}
        expandedRows={expandedRows}
        onToggle={toggleExpanded}
        onOpenProject={onOpenProject}
        onOpenTask={onOpenTask}
      />)}
    </section> : <div className="okr-file-empty"><Target size={22} /><div><h2>{t("이 파일의 Objective를 작성해 주세요")}</h2><p>{t("파일 수정에서 Objective와 KR을 한 번에 만들 수 있습니다.")}</p></div>{!readOnly && <button onClick={() => void beginEdit()}><Plus size={14} />{t("파일 작성")}</button>}</div>}
  </article>;
}

function OkrReadKeyResult({
  focusId,
  keyResult,
  keyResultIndex,
  projectsByInitiative,
  tasksByProject,
  expandedRows,
  onToggle,
  onOpenProject,
  onOpenTask,
}: {
  focusId?: string | null;
  keyResult: KeyResult;
  keyResultIndex: number;
  projectsByInitiative: Map<string, OkrExecutionItem[]>;
  tasksByProject: Map<string, OkrExecutionItem[]>;
  expandedRows: Set<string>;
  onToggle: (id: string) => void;
  onOpenProject: (id: string) => void;
  onOpenTask: (id: string) => void;
}) {
  const keyResultId = keyResult.id ?? keyResult.clientId;
  const keyResultExpanded = expandedRows.has(keyResultId);
  const initiativesId = `okr-tree-${keyResultId}`;
  const hasInitiatives = keyResult.initiatives.length > 0;
  return <section id={`okr-search-${keyResultId}`} tabIndex={-1} className={`okr-file-read-kr ${focusId === keyResultId ? "search-target" : ""}`}>
    {hasInitiatives ? <button type="button" className="okr-tree-row okr-tree-kr-row" aria-expanded={keyResultExpanded} aria-controls={initiativesId} onClick={() => onToggle(keyResultId)}>
      <TreeChevron expanded={keyResultExpanded} />
      <span className="type-icon type-key_result">KR</span>
      <span className="okr-tree-copy"><small>{t("Key Result")}{keyResultIndex + 1}</small><strong>{keyResult.title}</strong></span>
      <span className="okr-tree-count">{t("{kind} · {count}", { kind: t("Initiative"), count: keyResult.initiatives.length })}</span>
      <b className="okr-tree-progress">{keyResult.progress}%</b>
    </button> : <div className="okr-tree-row okr-tree-kr-row static">
      <span className="okr-tree-chevron-placeholder" />
      <span className="type-icon type-key_result">KR</span>
      <span className="okr-tree-copy"><small>{t("Key Result")}{keyResultIndex + 1}</small><strong>{keyResult.title}</strong></span>
      <span className="okr-tree-count empty">{t("Initiative 없음")}</span>
      <b className="okr-tree-progress">{keyResult.progress}%</b>
    </div>}
    {hasInitiatives && keyResultExpanded && <div className="okr-tree-initiatives" id={initiativesId} role="group" aria-label={t("{value1}의 Initiative", { value1: messageValue(keyResult.title) })}>
      {keyResult.initiatives.map((initiative, initiativeIndex) => {
        const initiativeId = initiative.id ?? initiative.clientId;
        const projects = projectsByInitiative.get(initiativeId) ?? [];
        const initiativeExpanded = expandedRows.has(initiativeId);
        const projectsId = `okr-tree-${initiativeId}`;
        return <section id={`okr-search-${initiativeId}`} tabIndex={-1} className={`okr-file-read-initiative ${focusId === initiativeId ? "search-target" : ""}`} key={initiativeId}>
          {projects.length ? <button type="button" className="okr-tree-row okr-tree-initiative-row" aria-expanded={initiativeExpanded} aria-controls={projectsId} onClick={() => onToggle(initiativeId)}>
            <TreeChevron expanded={initiativeExpanded} />
            <span className="type-icon type-initiative">I</span>
            <span className="okr-tree-copy"><small>{t("Initiative")}{initiativeIndex + 1}</small><strong>{initiative.title}</strong></span>
            <span className="okr-tree-count">{t("{kind} · {count}", { kind: t("Project"), count: projects.length })}</span>
          </button> : <div className="okr-tree-row okr-tree-initiative-row static">
            <span className="okr-tree-chevron-placeholder" />
            <span className="type-icon type-initiative">I</span>
            <span className="okr-tree-copy"><small>{t("Initiative")}{initiativeIndex + 1}</small><strong>{initiative.title}</strong></span>
            <span className="okr-tree-count empty">{t("미완료 Project 없음")}</span>
          </div>}
          {projects.length > 0 && initiativeExpanded && <div className="okr-tree-projects" id={projectsId} role="group" aria-label={t("{value1}의 미완료 Project", { value1: messageValue(initiative.title) })}>
            {projects.map((project) => {
              const tasks = tasksByProject.get(project.id) ?? [];
              const projectExpanded = expandedRows.has(project.id);
              const tasksId = `okr-tree-${project.id}`;
              return <section className="okr-tree-project" key={project.id}>
                <div className="okr-tree-project-row">
                  {tasks.length ? <button type="button" className="okr-tree-row okr-tree-project-main" aria-expanded={projectExpanded} aria-controls={tasksId} onClick={() => onToggle(project.id)}>
                    <TreeChevron expanded={projectExpanded} />
                    <Briefcase className="okr-tree-kind-icon" size={15} />
                    <span className="okr-tree-copy"><small>{t("Project")}</small><strong className="project-item-title">{project.title}</strong></span>
                    <span className="okr-tree-count">{t("{kind} · {count}", { kind: t("Task"), count: tasks.length })}</span>
                  </button> : <div className="okr-tree-row okr-tree-project-main static">
                    <span className="okr-tree-chevron-placeholder" />
                    <Briefcase className="okr-tree-kind-icon" size={15} />
                    <span className="okr-tree-copy"><small>{t("Project")}</small><strong className="project-item-title">{project.title}</strong></span>
                    <span className="okr-tree-count empty">{t("미완료 Task 없음")}</span>
                  </div>}
                  <button type="button" className="okr-tree-open-detail" aria-label={t("{value1} Project 상세 보기", { value1: messageValue(project.title) })} title={t("Project 상세 보기")} onClick={() => onOpenProject(project.id)}><ExternalLink size={13} /></button>
                </div>
                {tasks.length > 0 && projectExpanded && <div className="okr-tree-tasks" id={tasksId} role="group" aria-label={t("{value1}의 미완료 Task", { value1: messageValue(project.title) })}>
                  {tasks.map((task) => <button type="button" className="okr-tree-task" key={task.id} onClick={() => onOpenTask(task.id)}><ListChecks size={14} /><span>{task.title}</span><ChevronRight size={13} /></button>)}
                </div>}
              </section>;
            })}
          </div>}
        </section>;
      })}
    </div>}
  </section>;
}

function TreeChevron({ expanded }: { expanded: boolean }) {
  return expanded ? <ChevronDown className="okr-tree-chevron" size={14} aria-hidden="true" /> : <ChevronRight className="okr-tree-chevron" size={14} aria-hidden="true" />;
}

function StatusSelect({ value, onChange }: { value: ItemStatus; onChange: (status: ItemStatus) => void }) {
  return <select className={`okr-status-select status-${value}`} value={value} onChange={(event) => onChange(event.target.value as ItemStatus)} aria-label={t("상태")}>{statuses.map((status) => <option value={status.value} key={status.value}>{status.label}</option>)}</select>;
}

function emptyDraft(): Draft {
  const now = new Date();
  const quarter = Math.floor(now.getMonth() / 3) + 1;
  const start = new Date(Date.UTC(now.getFullYear(), (quarter - 1) * 3, 1));
  const end = new Date(Date.UTC(now.getFullYear(), quarter * 3, 0));
  return {
    metadata: { name: `${now.getFullYear()} Q${quarter} OKR`, department: "", startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10), status: "planned" },
    objective: { id: null, clientId: makeClientId("objective"), title: "", status: "in_progress", keyResults: [{ id: null, clientId: makeClientId("kr"), title: "", status: "todo", progress: 0, initiatives: [] }] },
  };
}

function draftFromFile(file: OkrFile): Draft {
  return {
    metadata: { name: file.cycle.name, department: file.cycle.department, startDate: file.cycle.startDate, endDate: file.cycle.endDate, status: file.cycle.status },
    objective: file.objective ? structuredClone(file.objective) : { id: null, clientId: makeClientId("objective"), title: "", status: "in_progress", keyResults: [{ id: null, clientId: makeClientId("kr"), title: "", status: "todo", progress: 0, initiatives: [] }] },
  };
}

function makeClientId(kind: string) { return `draft-${kind}-${crypto.randomUUID()}`; }

function compareExecutionItems(left: OkrExecutionItem, right: OkrExecutionItem) {
  return left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

type DraftSetter = Dispatch<SetStateAction<Draft>>;
function patchKeyResult(setDraft: DraftSetter, id: string, patch: Partial<KeyResult>) { setDraft((current) => ({ ...current, objective: { ...current.objective, keyResults: current.objective.keyResults.map((entry) => entry.clientId === id ? { ...entry, ...patch } : entry) } })); }
function patchInitiative(setDraft: DraftSetter, id: string, patch: Partial<Initiative>) { setDraft((current) => ({ ...current, objective: { ...current.objective, keyResults: current.objective.keyResults.map((keyResult) => ({ ...keyResult, initiatives: keyResult.initiatives.map((entry) => entry.clientId === id ? { ...entry, ...patch } : entry) })) } })); }
function addKeyResult(setDraft: DraftSetter) { setDraft((current) => ({ ...current, objective: { ...current.objective, keyResults: [...current.objective.keyResults, { id: null, clientId: makeClientId("kr"), title: "", status: "todo", progress: 0, initiatives: [] }] } })); }
function addInitiative(setDraft: DraftSetter, keyResultId: string) { setDraft((current) => ({ ...current, objective: { ...current.objective, keyResults: current.objective.keyResults.map((entry) => entry.clientId === keyResultId ? { ...entry, initiatives: [...entry.initiatives, { id: null, clientId: makeClientId("initiative"), title: "", status: "todo", linkedProjects: [] }] } : entry) } })); }
function removeInitiative(setDraft: DraftSetter, initiativeId: string) { setDraft((current) => ({ ...current, objective: { ...current.objective, keyResults: current.objective.keyResults.map((entry) => ({ ...entry, initiatives: entry.initiatives.filter((initiative) => initiative.clientId !== initiativeId) })) } })); }
function moveKeyResult(setDraft: DraftSetter, index: number, direction: -1 | 1) { setDraft((current) => { const keyResults = [...current.objective.keyResults]; const target = index + direction; if (target < 0 || target >= keyResults.length) return current; [keyResults[index], keyResults[target]] = [keyResults[target], keyResults[index]]; return { ...current, objective: { ...current.objective, keyResults } }; }); }
function moveInitiative(setDraft: DraftSetter, keyResultId: string, index: number, direction: -1 | 1) { setDraft((current) => ({ ...current, objective: { ...current.objective, keyResults: current.objective.keyResults.map((entry) => { if (entry.clientId !== keyResultId) return entry; const initiatives = [...entry.initiatives]; const target = index + direction; if (target < 0 || target >= initiatives.length) return entry; [initiatives[index], initiatives[target]] = [initiatives[target], initiatives[index]]; return { ...entry, initiatives }; }) } })); }
function moveInitiativeToKeyResult(setDraft: DraftSetter, initiativeId: string, targetKeyResultId: string) { setDraft((current) => { let moving: Initiative | null = null; const without = current.objective.keyResults.map((keyResult) => ({ ...keyResult, initiatives: keyResult.initiatives.filter((initiative) => { if (initiative.clientId !== initiativeId) return true; moving = initiative; return false; }) })); if (!moving) return current; return { ...current, objective: { ...current.objective, keyResults: without.map((keyResult) => keyResult.clientId === targetKeyResultId ? { ...keyResult, initiatives: [...keyResult.initiatives, moving!] } : keyResult) } }; }); }
