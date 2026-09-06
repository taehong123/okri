"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUpRight, Clock3, Search, X } from "lucide-react";
import { OverlayDialog } from "./overlay-dialog";
import { t, displayDate, useLanguage } from "@/lib/client-language";
import { EMPTY_SEARCH_FILTERS, SEARCH_KINDS, searchRef, type SearchFilters, type SearchResult } from "@/lib/workspace-search";
import "./workspace-search.css";

export type SearchDestination = { view?: string; tab?: string; bot?: string; personal?: boolean; ai?: boolean };
type Menu = { label: string; keywords: string; destination: SearchDestination; team?: boolean };
const menuEntries: Menu[] = [
  { label: "내 업무", keywords: "my work assigned tasks", destination: { view: "my_work" } },
  { label: "OKR", keywords: "목표 objective key result initiative 파일", destination: { view: "okr" } },
  { label: "Project", keywords: "프로젝트 project", destination: { view: "work" } },
  { label: "Task", keywords: "태스크 할일 task", destination: { view: "inbox" } },
  { label: "Routine", keywords: "루틴 반복 routine", destination: { view: "routines" } },
  { label: "데일리 스크럼", keywords: "daily scrum 데일리", destination: { view: "scrum" } },
  { label: "데이터", keywords: "data kr", destination: { view: "data" } },
  { label: "추천", keywords: "recommendations", destination: { view: "recommendations" } },
  { label: "리뷰", keywords: "reviews", destination: { view: "reviews" } },
  { label: "휴지통", keywords: "trash restore 복구", destination: { view: "trash" } },
  { label: "워크스페이스 설정", keywords: "workspace 이름 프로필 사진 avatar", destination: { tab: "general" } },
  { label: "팀 멤버", keywords: "members invite 초대", destination: { tab: "members" }, team: true },
  { label: "그룹 관리", keywords: "groups lead", destination: { tab: "groups" }, team: true },
  { label: "Project 설정", keywords: "속성 템플릿 properties templates", destination: { tab: "projects" } },
  { label: "관리 요약", keywords: "management summary 기한 담당자", destination: { tab: "summary" }, team: true },
  { label: "데일리 봇", keywords: "daily bot slack 데일리봇", destination: { tab: "integrations", bot: "daily" }, team: true },
  { label: "관리 봇", keywords: "management bot slack", destination: { tab: "integrations", bot: "management" }, team: true },
  { label: "업무 자동화 봇", keywords: "automation bot slack", destination: { tab: "integrations", bot: "automation" }, team: true },
  { label: "언어", keywords: "language 언어 설정 日本語 English 中文 Español 한국어", destination: { personal: true } },
  { label: "테마", keywords: "theme dark light appearance 화면 모드", destination: { personal: true } },
  { label: "개인 앱 연동", keywords: "google calendar slack 구글 캘린더", destination: { view: "integrations" } },
  { label: "AI 연결", keywords: "mcp chatgpt claude codex", destination: { ai: true } },
  { label: "요금제 및 결제", keywords: "billing plan 결제 요금", destination: { view: "billing" } },
];
const kindLabels: Record<SearchResult["kind"], string> = { okr_file: "OKR 파일", objective: "Objective", key_result: "Key Result", initiative: "Initiative", project: "Project", task: "Task", routine: "Routine", member: "멤버" };
type History = { refs: string[]; queries: string[] };
function readHistory(key: string): History {
  try {
    const data = JSON.parse(sessionStorage.getItem(key) ?? "{}");
    return { refs: Array.isArray(data.refs) ? data.refs.filter((v: unknown) => typeof v === "string").slice(0, 8) : [], queries: Array.isArray(data.queries) ? data.queries.filter((v: unknown) => typeof v === "string").slice(0, 5) : [] };
  } catch { return { refs: [], queries: [] }; }
}

export default function WorkspaceSearch({ open, identity, workspaceId, workspaceName, personal, members, cycles, refreshKey, onClose, onNavigate }: {
  open: boolean; identity: string; workspaceId: string; workspaceName: string; personal: boolean;
  members: { id: string; displayName: string; status: string }[];
  cycles: { id: string; name: string }[];
  refreshKey: unknown;
  onClose: () => void;
  onNavigate: (target: SearchResult | SearchDestination, signal: AbortSignal) => Promise<boolean>;
}) {
  useLanguage();
  const storageKey = `okri.search:${identity}:${workspaceId}`;
  const [history, setHistory] = useState<History>(() => typeof window === "undefined" ? { refs: [], queries: [] } : readHistory(storageKey));
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<SearchFilters>(EMPTY_SEARCH_FILTERS);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const openController = useRef<AbortController | null>(null);
  const recentMode = !query.trim() && !Object.values(filters).some(Boolean);
  const searchParams = new URLSearchParams({ q: query.trim(), ...filters });
  if (recentMode) history.refs.forEach((ref) => searchParams.append("ref", ref));
  const paramsKey = searchParams.toString();
  const menus = Object.values(filters).some(Boolean) ? [] : menuEntries.filter((entry) => (!entry.team || !personal) &&
    (!query.trim() || `${t(entry.label)} ${entry.label} ${entry.keywords}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));

  function persist(next: History) {
    setHistory(next);
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Search still works with storage disabled. */ }
  }
  async function load(params: string, offset = 0) {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort("timeout"), 12_000);
    setLoading(true);
    setError("");
    const now = new Date();
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
    try {
      const response = await fetch(`/api/search?${params}&offset=${offset}&date=${date}`, { signal: controller.signal, cache: "no-store", headers: { "x-okri-workspace-id": workspaceId } });
      if (!response.ok) throw new Error();
      const data = await response.json() as { results: SearchResult[]; nextOffset: number | null };
      if (controller.signal.aborted) return;
      setResults((previous) => offset ? [...previous, ...data.results.filter((row) => !previous.some((old) => searchRef(row) === searchRef(old)))] : data.results);
      setNextOffset(data.nextOffset);
    } catch {
      if (!controller.signal.aborted || controller.signal.reason === "timeout") setError("검색하지 못했습니다. 입력을 유지했으니 다시 시도해 주세요.");
    } finally {
      window.clearTimeout(timeout);
      if (controllerRef.current === controller) setLoading(false);
    }
  }
  useEffect(() => {
    if (!open) { controllerRef.current?.abort(); openController.current?.abort(); return; }
    const timer = window.setTimeout(() => {
      if (recentMode && !history.refs.length) { setResults([]); setNextOffset(null); setLoading(false); return; }
      void load(paramsKey);
    }, query ? 220 : 0);
    return () => { window.clearTimeout(timer); controllerRef.current?.abort(); };
    // The normalized request string owns query/filter changes, not translated labels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, paramsKey, attempt, refreshKey, workspaceId]);
  useEffect(() => {
    if (!open) return;
    const restore = window.requestAnimationFrame(() => { if (listRef.current) listRef.current.scrollTop = scrollRef.current; });
    const refresh = () => { if (document.visibilityState === "visible") setAttempt((value) => value + 1); };
    window.addEventListener("focus", refresh);
    return () => { window.cancelAnimationFrame(restore); window.removeEventListener("focus", refresh); };
  }, [open]);
  useEffect(() => () => { controllerRef.current?.abort(); openController.current?.abort(); }, []);

  function changeFilter(key: keyof SearchFilters, value: string) { scrollRef.current = 0; setFilters((current) => ({ ...current, [key]: value })); }
  async function choose(target: SearchResult | SearchDestination) {
    if (opening) return;
    if ("kind" in target && target.kind === "member") { setQuery(""); setFilters({ ...EMPTY_SEARCH_FILTERS, assignee: target.id }); return; }
    const controller = new AbortController();
    openController.current = controller;
    const timeout = window.setTimeout(() => controller.abort("timeout"), 12_000);
    setOpening(true); setError("");
    try {
      if (!await onNavigate(target, controller.signal)) return;
      const refs = "kind" in target ? [searchRef(target), ...history.refs.filter((ref) => ref !== searchRef(target))].slice(0, 8) : history.refs;
      persist({ refs, queries: query.trim() ? [query.trim(), ...history.queries.filter((term) => term !== query.trim())].slice(0, 5) : history.queries });
    } catch { if (!controller.signal.aborted || controller.signal.reason === "timeout") setError("항목을 열지 못했습니다. 삭제되었거나 접근 권한이 변경되었을 수 있습니다."); }
    finally { window.clearTimeout(timeout); setOpening(false); }
  }
  function moveResult(event: KeyboardEvent<HTMLElement>) {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-search-result]") ?? [])];
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length].focus();
  }
  if (!open) return null;
  const orderedResults = recentMode ? [...results].sort((a, b) => history.refs.indexOf(searchRef(a)) - history.refs.indexOf(searchRef(b))) : results;
  return <OverlayDialog title={t("업무 또는 메뉴 검색")} className="workspace-search-overlay" initialFocus="input[type=search]" onRequestClose={onClose}>
    <section className="workspace-search-panel" aria-busy={opening}>
      <header className="workspace-search-input-row"><Search size={20} aria-hidden="true" />
        <input type="search" value={query} maxLength={160} placeholder={t("업무 또는 메뉴 검색…")} aria-label={t("업무 또는 메뉴 검색")} onChange={(event) => { scrollRef.current = 0; setQuery(event.target.value); }} onKeyDown={(event) => { moveResult(event); if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); listRef.current?.querySelector<HTMLButtonElement>("button[data-search-result]")?.click(); } }} />
        <button type="button" className="icon-button" onClick={onClose} aria-label={t("검색 닫기")}><X size={18} /></button>
      </header>
      <p className="workspace-search-scope">{t("현재 워크스페이스")} · {workspaceName}</p>
      <div className="workspace-search-filters" aria-label={t("검색 필터")}>
        <select aria-label={t("유형")} value={filters.kind} onChange={(event) => changeFilter("kind", event.target.value)}><option value="">{t("모든 유형")}</option>{SEARCH_KINDS.filter((kind) => kind !== "member").map((kind) => <option key={kind} value={kind}>{t(kindLabels[kind])}</option>)}</select>
        <select aria-label={t("담당자")} value={filters.assignee} onChange={(event) => changeFilter("assignee", event.target.value)}><option value="">{t("모든 담당자")}</option>{members.filter((member) => member.status === "active").map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select>
        <select aria-label={t("상태")} value={filters.status} onChange={(event) => changeFilter("status", event.target.value)}><option value="">{t("모든 상태")}</option><option value="active">{t("미완료")}</option><option value="completed">{t("완료")}</option><option value="blocked">{t("막힘")}</option></select>
        <select aria-label={t("기한")} value={filters.due} onChange={(event) => changeFilter("due", event.target.value)}><option value="">{t("모든 기한")}</option><option value="today">{t("오늘 마감")}</option><option value="overdue">{t("기한 초과")}</option><option value="none">{t("기한 없음")}</option></select>
        <select aria-label={t("OKR 파일")} value={filters.cycle} onChange={(event) => changeFilter("cycle", event.target.value)}><option value="">{t("모든 OKR 파일")}</option>{cycles.map((cycle) => <option key={cycle.id} value={cycle.id}>{cycle.name}</option>)}</select>
        {Object.values(filters).some(Boolean) && <button type="button" onClick={() => setFilters(EMPTY_SEARCH_FILTERS)}>{t("필터 초기화")}</button>}
      </div>
      <div className="workspace-search-feedback" role="status">{opening ? t("항목을 여는 중…") : loading ? t("검색 결과 갱신 중…") : ""}</div>
      {error && <div className="workspace-search-error" role="alert">{t(error)}<button type="button" onClick={() => setAttempt((value) => value + 1)}>{t("다시 시도")}</button></div>}
      <div className="workspace-search-results" ref={listRef} onScroll={(event) => { scrollRef.current = event.currentTarget.scrollTop; }}>
        {recentMode && history.queries.length > 0 && <section aria-label={t("최근 검색")}><header><h2>{t("최근 검색")}</h2><button type="button" onClick={() => persist({ refs: [], queries: [] })}>{t("기록 지우기")}</button></header><ul>{history.queries.map((term) => <li key={term}><button type="button" data-search-result onKeyDown={moveResult} onClick={() => setQuery(term)}><Clock3 size={16} aria-hidden="true" /><span>{term}</span></button></li>)}</ul></section>}
        {orderedResults.length > 0 && <section aria-label={recentMode ? t("최근 열어본 업무") : t("업무 검색 결과")}><h2>{recentMode ? t("최근 열어본 업무") : t("업무 검색 결과")}</h2><ul>{orderedResults.map((result) => <li key={searchRef(result)}><button type="button" data-search-result onKeyDown={moveResult} disabled={opening} onClick={() => void choose(result)}>
          <span className="workspace-search-kind">{t(kindLabels[result.kind])}</span><span className="workspace-search-result-copy"><span>{result.title}</span><small>{[result.parentTitle ?? result.cycleName, result.assignee, result.dueDate ? displayDate(result.dueDate) : null, ["done", "development_done", "closed"].includes(result.status) ? t("완료") : result.status === "inactive" ? t("중지") : null, result.kind === "member" ? t("담당 업무 보기") : null].filter(Boolean).join(" · ")}</small></span><ArrowUpRight size={16} aria-hidden="true" />
        </button></li>)}</ul></section>}
        {!loading && !recentMode && !results.length && !menus.length && !error && <p className="workspace-search-empty">{t("검색 결과가 없습니다. 검색어나 필터를 바꿔보세요.")}</p>}
        {nextOffset !== null && <button type="button" className="workspace-search-more" disabled={loading} onClick={() => void load(paramsKey, nextOffset)}>{t("결과 더 보기")}</button>}
        {menus.length > 0 && <section aria-label={t("메뉴 바로가기")}><h2>{t("메뉴 바로가기")}</h2><ul>{menus.map((entry) => <li key={entry.label}><button type="button" data-search-result onKeyDown={moveResult} disabled={opening} onClick={() => void choose(entry.destination)}><span>{t(entry.label)}</span><small>{entry.destination.tab ? t("워크스페이스 설정") : entry.destination.personal ? t("내 설정") : ""}</small><ArrowUpRight size={16} aria-hidden="true" /></button></li>)}</ul></section>}
      </div>
      <footer>{t("↑ ↓ 이동 · Enter 열기 · Esc 닫기")}</footer>
    </section>
  </OverlayDialog>;
}
