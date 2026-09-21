"use client";

import { AlertTriangle, Check, Database, Link2, LoaderCircle, Pencil, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { OverlayDialog, useAppConfirm } from "./overlay-dialog";
import { t , apiError , getClientLocale , messageValue } from "@/lib/client-language";

type DataTargetKind = "key_result" | "project";
export type DataItem = {
  id: string;
  kind: "objective" | "key_result" | "initiative" | "project" | "ticket" | "task";
  cycleId: string | null;
  parentId: string | null;
  title: string;
  progress: number;
};

export type DataCycle = { id: string; name: string };
type DataCadence = "hourly" | "daily" | "weekly" | "manual";
export type DataConnection = {
  id: string;
  itemId: string;
  targetKind: DataTargetKind;
  name: string;
  endpointUrl: string;
  valuePath: string;
  baselineValue: number;
  targetValue: number;
  unit: string;
  cadence: DataCadence;
  active: boolean;
  lastValue: number | null;
  lastSyncStatus: "never" | "success" | "error";
  lastError: string;
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type Draft = {
  targetKind: DataTargetKind;
  itemId: string;
  name: string;
  endpointUrl: string;
  valuePath: string;
  baselineValue: string;
  targetValue: string;
  unit: string;
  cadence: DataCadence;
  active: boolean;
};

const connectionMemoryCache = new Map<string, DataConnection[]>();
const connectionCacheTimestamps = new Map<string, number>();
const CONNECTION_CACHE_FRESH_MS = 30_000;
const cadenceLabels: Record<DataCadence, string> = { get hourly() { return t("매시간"); }, get daily() { return t("매일"); }, get weekly() { return t("매주"); }, get manual() { return t("수동만"); } };
const targetLabels: Record<DataTargetKind, string> = { key_result: "KR", get project() { return t("Project"); } };

function markConnectionCacheFresh(key: string) {
  connectionCacheTimestamps.set(key, Date.now());
}

export default function DataView({ cacheKey, items, cycles, readOnly, onProgressChange, onNotice }: {
  cacheKey: string;
  items: DataItem[];
  cycles: DataCycle[];
  readOnly: boolean;
  onProgressChange: (id: string, progress: number) => void;
  onNotice: (message: string) => void;
}) {
  const confirmAction = useAppConfirm();
  const [connections, setConnections] = useState<DataConnection[] | null>(() => connectionMemoryCache.get(cacheKey) ?? null);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [search, setSearch] = useState("");
  const [targetFilter, setTargetFilter] = useState<"all" | DataTargetKind>("all");
  const [sort, setSort] = useState<"structure" | "cadence" | "status">("structure");
  const [editing, setEditing] = useState<DataConnection | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft("key_result", ""));
  const [initialDraft, setInitialDraft] = useState<Draft>(() => emptyDraft("key_result", ""));
  const [saving, setSaving] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const storedAt = connectionCacheTimestamps.get(cacheKey);
    if (connectionMemoryCache.has(cacheKey) && typeof storedAt === "number" && Date.now() - storedAt < CONNECTION_CACHE_FRESH_MS && loadAttempt === 0) return () => { active = false; };
    fetch("/api/data-connections")
      .then(async (response) => response.ok ? response.json() as Promise<{ connections: DataConnection[] }> : Promise.reject())
      .then((data) => {
        if (!active) return;
        connectionMemoryCache.set(cacheKey, data.connections);
        markConnectionCacheFresh(cacheKey);
        setConnections(data.connections);
        setLoadError(false);
      })
      .catch(() => { if (active && !connectionMemoryCache.has(cacheKey)) setLoadError(true); });
    return () => { active = false; };
  }, [cacheKey, loadAttempt]);

  const targets = useMemo(() => items.filter((item): item is DataItem & { kind: DataTargetKind } => item.kind === "key_result" || item.kind === "project"), [items]);
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const byItem = useMemo(() => new Map((connections ?? []).map((connection) => [connection.itemId, connection])), [connections]);
  const cycleById = useMemo(() => new Map(cycles.map((cycle) => [cycle.id, cycle.name])), [cycles]);
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const rows = targets
      .filter((item) => targetFilter === "all" || item.kind === targetFilter)
      .filter((item) => !query || `${item.title} ${byItem.get(item.id)?.name ?? ""}`.toLocaleLowerCase().includes(query));
    if (sort === "cadence") return [...rows].sort((left, right) => cadenceOrder(byItem.get(left.id)?.cadence) - cadenceOrder(byItem.get(right.id)?.cadence));
    if (sort === "status") return [...rows].sort((left, right) => statusOrder(byItem.get(left.id)) - statusOrder(byItem.get(right.id)));
    return rows;
  }, [byItem, search, sort, targetFilter, targets]);

  const availableForKind = (kind: DataTargetKind) => targets.filter((item) => item.kind === kind && !byItem.has(item.id));

  function openCreate(item?: DataItem & { kind: DataTargetKind }) {
    const targetKind = item?.kind ?? (targetFilter === "project" ? "project" : availableForKind("key_result").length ? "key_result" : "project");
    const itemId = item?.id ?? availableForKind(targetKind)[0]?.id ?? "";
    const nextDraft = emptyDraft(targetKind, itemId);
    setDraft(nextDraft);
    setInitialDraft(nextDraft);
    setEditing("new");
  }

  function openEdit(connection: DataConnection) {
    const nextDraft = {
      targetKind: connection.targetKind,
      itemId: connection.itemId,
      name: connection.name,
      endpointUrl: connection.endpointUrl,
      valuePath: connection.valuePath,
      baselineValue: String(connection.baselineValue),
      targetValue: String(connection.targetValue),
      unit: connection.unit,
      cadence: connection.cadence,
      active: connection.active,
    };
    setDraft(nextDraft);
    setInitialDraft(nextDraft);
    setEditing(connection);
  }

  function changeTargetKind(targetKind: DataTargetKind) {
    if (editing !== "new") return;
    setDraft((current) => ({ ...current, targetKind, itemId: availableForKind(targetKind)[0]?.id ?? "" }));
  }

  const draftDirty = Object.keys(draft).some((key) => draft[key as keyof Draft] !== initialDraft[key as keyof Draft]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    const baselineValue = Number(draft.baselineValue);
    const targetValue = Number(draft.targetValue);
    if (!draft.itemId || !draft.name.trim() || !draft.endpointUrl.trim() || !Number.isFinite(baselineValue) || !Number.isFinite(targetValue) || baselineValue === targetValue) return;
    setSaving(true);
    const method = editing === "new" ? "POST" : "PATCH";
    const response = await fetch("/api/data-connections", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...draft, baselineValue, targetValue, id: editing === "new" ? undefined : editing?.id }),
    });
    const data = await response.json().catch(() => ({})) as { connection?: DataConnection; error?: string };
    setSaving(false);
    if (!response.ok || !data.connection) {
      onNotice(apiError(data, "데이터 연결을 저장하지 못했습니다."));
      return;
    }
    const next = editing === "new"
      ? [...(connections ?? []), data.connection]
      : (connections ?? []).map((connection) => connection.id === data.connection?.id ? data.connection : connection);
    connectionMemoryCache.set(cacheKey, next);
    markConnectionCacheFresh(cacheKey);
    setConnections(next);
    setEditing(null);
    onNotice(editing === "new" ? t("데이터 연결을 만들었습니다.") : t("데이터 연결을 저장했습니다."));
  }

  async function sync(connection: DataConnection) {
    setSyncingId(connection.id);
    const response = await fetch("/api/data-connections/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: connection.id }),
    });
    const data = await response.json().catch(() => ({})) as { connection?: DataConnection; progress?: number; error?: string };
    setSyncingId(null);
    if (!response.ok || !data.connection || typeof data.progress !== "number") {
      onNotice(apiError(data, "API 데이터를 업데이트하지 못했습니다."));
      setLoadAttempt((attempt) => attempt + 1);
      return;
    }
    const next = (connections ?? []).map((entry) => entry.id === connection.id ? data.connection! : entry);
    connectionMemoryCache.set(cacheKey, next);
    markConnectionCacheFresh(cacheKey);
    setConnections(next);
    onProgressChange(connection.itemId, data.progress);
    onNotice(t("{value1} 진행률을 {value2}%로 업데이트했습니다.", { value1: messageValue(targetLabels[connection.targetKind]), value2: messageValue(data.progress) }));
  }

  async function remove(connection: DataConnection) {
    const target = itemById.get(connection.itemId);
    if (!await confirmAction({ title: t("데이터 연결 삭제"), message: t("'{value1}' 연결을 삭제합니다. {value2} 자체와 현재 진행률은 유지됩니다.", { value1: messageValue(connection.name), value2: messageValue(targetLabels[connection.targetKind]) }), confirmLabel: t("연결 삭제"), danger: true })) return;
    const response = await fetch(`/api/data-connections?id=${encodeURIComponent(connection.id)}`, { method: "DELETE" });
    if (!response.ok) { onNotice(t("데이터 연결을 삭제하지 못했습니다.")); return; }
    const next = (connections ?? []).filter((entry) => entry.id !== connection.id);
    connectionMemoryCache.set(cacheKey, next);
    markConnectionCacheFresh(cacheKey);
    setConnections(next);
    onNotice(t("{value1}의 데이터 연결을 삭제했습니다.", { value1: messageValue(target?.title ?? targetLabels[connection.targetKind]) }));
  }

  if (loadError) return <DataState icon={AlertTriangle} title={t("데이터 연결을 불러오지 못했습니다")} action={t("다시 시도")} onAction={() => { setLoadError(false); setLoadAttempt((attempt) => attempt + 1); }} />;
  if (connections === null) return <DataState icon={LoaderCircle} title={t("데이터 연결을 불러오는 중입니다")} loading />;

  const hasAvailableTarget = targets.some((item) => !byItem.has(item.id));

  return <>
    <section className="kr-data-toolbar">
      <div className="view-tabs data-target-tabs" role="tablist" aria-label={t("데이터 대상 필터")}>
        {([["all", t("전체")], ["key_result", "KR"], ["project", t("Project")]] as const).map(([value, label]) => <button role="tab" aria-selected={targetFilter === value} className={targetFilter === value ? "active" : ""} onClick={() => setTargetFilter(value)} key={value}>{label}</button>)}
      </div>
      <label><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("항목 또는 데이터 소스 검색")} aria-label={t("데이터 검색")} /></label>
      <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} aria-label={t("데이터 정렬")}><option value="structure">{t("구조 순서")}</option><option value="cadence">{t("갱신 주기")}</option><option value="status">{t("연결 상태")}</option></select>
      <button className="primary-action" disabled={readOnly || !hasAvailableTarget} onClick={() => openCreate()}><Plus size={14} />{t("API 연결")}</button>
    </section>
    <aside className="kr-data-guide"><Database size={17} /><div><b>{t("KR과 Project를 각각 수치로 측정합니다")}</b><p>{t("공개 HTTPS JSON API의 숫자를 기준값·목표값 사이의 진행률로 변환합니다. 연결한 항목 하나만 갱신하며 다른 항목과 수치를 섞지 않습니다.")}</p></div></aside>
    {!targets.length ? <DataState icon={Database} title={t("연결할 KR 또는 Project가 없습니다")} detail={t("먼저 OKR이나 Project 화면에서 항목을 만들어 주세요.")} /> : (
      <section className="kr-data-list" aria-label={t("데이터 연결 목록")}>
        {filtered.map((item) => {
          const connection = byItem.get(item.id);
          const contextLabel = item.kind === "project" ? itemById.get(item.parentId ?? "")?.title ?? t("상위 Initiative 미연결") : cycleById.get(item.cycleId ?? "") ?? t("OKR 파일");
          return <article className={`kr-data-card ${connection ? "connected" : "unconnected"}`} key={item.id}>
            <header><span className={`type-icon type-${item.kind}`}>{targetLabels[item.kind]}</span><div><small>{contextLabel}</small><h2>{item.title}</h2></div><strong>{item.progress}%</strong></header>
            {connection ? <>
              <div className="kr-data-progress"><span><i style={{ width: `${item.progress}%` }} /></span><b>{formatDataMetric(connection.lastValue, connection.unit)} <em>/ {formatDataMetric(connection.targetValue, connection.unit)}</em></b></div>
              <dl><div><dt>{t("데이터 소스")}</dt><dd><Link2 size={12} />{connection.name}</dd></div><div><dt>{t("값 경로")}</dt><dd>{connection.valuePath || t("응답 자체")}</dd></div><div><dt>{t("갱신")}</dt><dd>{cadenceLabels[connection.cadence]}{connection.active ? t(" · 활성") : t(" · 일시정지")}</dd></div><div><dt>{t("최근 결과")}</dt><dd className={`sync-${connection.lastSyncStatus}`}>{dataSyncStatusLabel(connection)}</dd></div></dl>
              {connection.lastError && <p className="kr-data-error"><AlertTriangle size={13} />{t("최근 데이터 갱신에 실패했습니다. 연결 설정을 확인해 주세요.")}</p>}
              <footer><button disabled={readOnly || syncingId === connection.id} onClick={() => void sync(connection)}><RefreshCw className={syncingId === connection.id ? "spinning" : ""} size={13} />{syncingId === connection.id ? t("업데이트 중") : t("지금 업데이트")}</button><button disabled={readOnly} onClick={() => openEdit(connection)}><Pencil size={13} />{t("설정")}</button><button className="danger" disabled={readOnly} onClick={() => void remove(connection)} aria-label={t("{value1} 데이터 연결 삭제", { value1: messageValue(item.title) })}><Trash2 size={13} /></button></footer>
            </> : <div className="kr-data-unconnected"><p>{t("아직 연결된 데이터가 없습니다.")}</p><button disabled={readOnly} onClick={() => openCreate(item)}><Plus size={13} />{t("이 {kind}에 API 연결", { kind: targetLabels[item.kind] })}</button></div>}
          </article>;
        })}
        {!filtered.length && <DataState icon={Search} title={t("검색 결과가 없습니다")} />}
      </section>
    )}
    {editing && <OverlayDialog title={editing === "new" ? t("API 연결") : t("API 설정")} variant="drawer" dirty={draftDirty} onRequestClose={() => setEditing(null)}>
      {(requestClose) => <aside className="property-panel kr-data-panel"><header><div><h2>{editing === "new" ? t("API 연결") : t("API 설정")}</h2><p>{t("인증이 필요 없는 HTTPS JSON GET API를 연결할 수 있습니다.")}</p></div><button className="icon-button" onClick={() => requestClose("close-button")} aria-label={t("API 설정 닫기")}><X size={17} /></button></header><form className="property-form" onSubmit={(event) => void save(event)}>
        <div className="view-tabs data-target-type-tabs" role="tablist" aria-label={t("연결 대상 유형")}>{([["key_result", "KR"], ["project", t("Project")]] as const).map(([value, label]) => <button type="button" role="tab" aria-selected={draft.targetKind === value} disabled={editing !== "new" || (!availableForKind(value).length && draft.targetKind !== value)} className={draft.targetKind === value ? "active" : ""} onClick={() => changeTargetKind(value)} key={value}>{label}</button>)}</div>
        <label><span>{t("연결 대상")}</span><select value={draft.itemId} disabled={editing !== "new"} onChange={(event) => setDraft({ ...draft, itemId: event.target.value })} aria-label={t("연결할 항목")}><option value="">{t("선택")}</option>{targets.filter((item) => item.kind === draft.targetKind && (!byItem.has(item.id) || item.id === draft.itemId)).map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label>
        <label><span>{t("데이터 소스 이름")}</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={t("예: Stripe 월간 매출")} /></label>
        <label><span>API URL</span><input type="url" value={draft.endpointUrl} onChange={(event) => setDraft({ ...draft, endpointUrl: event.target.value })} placeholder="https://api.example.com/metrics/revenue" /></label>
        <label><span>{t("숫자 값 경로")}</span><input value={draft.valuePath} onChange={(event) => setDraft({ ...draft, valuePath: event.target.value })} placeholder={t("예: data.monthlyRevenue")} /><small>{t("응답 자체가 숫자면 비워두세요. 배열은 data.items[0].value처럼 입력합니다.")}</small></label>
        <div className="kr-data-number-grid"><label><span>{t("기준값")}</span><input type="number" step="any" value={draft.baselineValue} onChange={(event) => setDraft({ ...draft, baselineValue: event.target.value })} /></label><label><span>{t("목표값")}</span><input type="number" step="any" value={draft.targetValue} onChange={(event) => setDraft({ ...draft, targetValue: event.target.value })} /></label></div>
        <label><span>{t("단위")}</span><input value={draft.unit} onChange={(event) => setDraft({ ...draft, unit: event.target.value })} placeholder={t("예: 원, 명, %")} /></label>
        <label><span>{t("자동 갱신 주기")}</span><select value={draft.cadence} onChange={(event) => setDraft({ ...draft, cadence: event.target.value as DataCadence })}>{Object.entries(cadenceLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label className="kr-data-active"><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /><span>{t("자동 갱신 활성화")}</span></label>
        <button disabled={saving || !draft.itemId || !draft.name.trim() || !draft.endpointUrl.trim() || !draft.targetValue || draft.baselineValue === draft.targetValue}>{saving ? t("저장 중") : <><Check size={14} />{t("연결 저장")}</>}</button>
      </form></aside>}
    </OverlayDialog>}
  </>;
}

function emptyDraft(targetKind: DataTargetKind, itemId: string): Draft { return { targetKind, itemId, name: "", endpointUrl: "", valuePath: "", baselineValue: "0", targetValue: "", unit: "", cadence: "daily", active: true }; }
function cadenceOrder(value?: DataCadence) { return value ? { hourly: 0, daily: 1, weekly: 2, manual: 3 }[value] : 4; }
function statusOrder(connection?: DataConnection) { return !connection ? 3 : connection.lastSyncStatus === "error" ? 0 : connection.lastSyncStatus === "never" ? 1 : 2; }
export function formatDataMetric(value: number | null, unit: string) { return value === null ? t("아직 값 없음") : `${new Intl.NumberFormat(getClientLocale(), { maximumFractionDigits: 2 }).format(value)}${unit}`; }
export function dataSyncStatusLabel(connection: DataConnection) { if (connection.lastSyncStatus === "never") return t("업데이트 전"); if (connection.lastSyncStatus === "error") return t("오류"); return connection.lastSyncedAt ? new Date(connection.lastSyncedAt).toLocaleString(getClientLocale(), { dateStyle: "short", timeStyle: "short" }) : t("완료"); }

function DataState({ icon: Icon, title, detail, action, onAction, loading = false }: { icon: typeof Database; title: string; detail?: string; action?: string; onAction?: () => void; loading?: boolean }) {
  return <section className="kr-data-state"><Icon className={loading ? "spinning" : ""} size={20} /><div><b>{title}</b>{detail && <p>{detail}</p>}</div>{action && onAction && <button onClick={onAction}>{action}</button>}</section>;
}
