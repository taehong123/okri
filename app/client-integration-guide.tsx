"use client";

import {
  Check,
  Copy,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { PUBLIC_MCP_URL } from "@/lib/integration-providers";
import { apiError, messageValue, t } from "@/lib/client-language";
import { OverlayDialog, useAppConfirm } from "./overlay-dialog";
import "./client-integration-guide.css";

const CLIENT_ENDPOINT = "https://okri.ai/api/integrations/clients/upsert";
const CLIENT_EXAMPLE = JSON.stringify({
  source_name: "Example CRM",
  source_url: "https://crm.example.com/customers/cus_1024",
  external_customer_id: "cus_1024",
  name: "홍길동",
  phone: "010-1234-5678",
  email: "hong@example.com",
  products: [{ external_product_id: "prd_a", name: "Enterprise" }],
}, null, 2);

type GuideTab = "api" | "mcp";
type KeySummary = {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  access?: "read" | "read_write";
};
type CreatedKey = { token: string; connection: KeySummary; access?: "read" | "read_write" };

export function ClientIntegrationGuide({ workspaceName, canManageClientKeys, canCreateMcpWriteKey, onClose, onNotice }: {
  workspaceName: string;
  canManageClientKeys: boolean;
  canCreateMcpWriteKey: boolean;
  onClose: () => void;
  onNotice: (message: string, tone?: "success" | "error" | "info") => void;
}) {
  const [tab, setTab] = useState<GuideTab>("api");
  const [clientKeys, setClientKeys] = useState<KeySummary[]>([]);
  const [mcpKeys, setMcpKeys] = useState<KeySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [clientName, setClientName] = useState(t("고객 동기화"));
  const [mcpName, setMcpName] = useState(t("개인 MCP"));
  const [mcpAccess, setMcpAccess] = useState<"read" | "read_write">(canCreateMcpWriteKey ? "read_write" : "read");
  const [createdClientKey, setCreatedClientKey] = useState<CreatedKey | null>(null);
  const [createdMcpKey, setCreatedMcpKey] = useState<CreatedKey | null>(null);
  const [mcpKeyOpen, setMcpKeyOpen] = useState(false);
  const [busy, setBusy] = useState<"client" | "mcp" | "oauth" | "" | `revoke:${string}`>("");
  const [inlineError, setInlineError] = useState("");
  const tabs: GuideTab[] = ["api", "mcp"];
  const id = useId();
  const confirmAction = useAppConfirm();

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const requests = [fetch("/api/integration-tokens/personal-mcp", { cache: "no-store" })];
      if (canManageClientKeys) requests.push(fetch("/api/integration-tokens/clients", { cache: "no-store" }));
      const [mcpResponse, clientResponse] = await Promise.all(requests);
      const mcpData = await mcpResponse.json().catch(() => ({})) as { keys?: KeySummary[]; error?: string };
      if (!mcpResponse.ok) throw new Error(apiError(mcpData, "개인 MCP 키를 불러오지 못했습니다."));
      let nextClientKeys: KeySummary[] = [];
      if (clientResponse) {
        const clientData = await clientResponse.json().catch(() => ({})) as { keys?: KeySummary[]; error?: string };
        if (!clientResponse.ok) throw new Error(apiError(clientData, "고객 API 키를 불러오지 못했습니다."));
        nextClientKeys = clientData.keys ?? [];
      }
      setMcpKeys(mcpData.keys ?? []);
      setClientKeys(nextClientKeys);
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : t("연동 키를 불러오지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }, [canManageClientKeys]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(initial);
  }, [refresh]);

  function selectTab(next: GuideTab) {
    setTab(next);
    setInlineError("");
  }

  function tabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    selectTab(tabs[next]);
    document.getElementById(`${id}-${tabs[next]}`)?.focus();
  }

  async function copy(value: string, message: string) {
    try {
      await navigator.clipboard.writeText(value);
      onNotice(message);
    } catch {
      onNotice(t("복사하지 못했습니다. 클립보드 권한을 허용하고 다시 시도해 주세요."), "error");
    }
  }

  async function createClientKey() {
    if (busy || !clientName.trim()) return;
    setCreatedClientKey(null);
    setInlineError("");
    setBusy("client");
    try {
      const response = await fetch("/api/integration-tokens/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: clientName.trim() }),
      });
      const data = await response.json().catch(() => ({})) as CreatedKey & { error?: string };
      if (!response.ok || !data.token || !data.connection) throw new Error(apiError(data, "고객 API 키를 만들지 못했습니다."));
      setCreatedClientKey(data);
      setClientKeys((current) => [data.connection, ...current.filter((key) => key.id !== data.connection.id)]);
    } catch (reason) {
      setInlineError(reason instanceof Error ? reason.message : t("고객 API 키를 만들지 못했습니다."));
    } finally {
      setBusy("");
    }
  }

  async function createMcpKey() {
    if (busy || !mcpName.trim()) return;
    setCreatedMcpKey(null);
    setInlineError("");
    setBusy("mcp");
    try {
      const response = await fetch("/api/integration-tokens/personal-mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: mcpName.trim(), access: mcpAccess }),
      });
      const data = await response.json().catch(() => ({})) as CreatedKey & { error?: string };
      if (!response.ok || !data.token || !data.connection) throw new Error(apiError(data, "개인 MCP 키를 만들지 못했습니다."));
      const created = { ...data.connection, access: data.access };
      setCreatedMcpKey({ ...data, connection: created });
      setMcpKeyOpen(true);
      setMcpKeys((current) => [created, ...current.filter((key) => key.id !== created.id)]);
    } catch (reason) {
      setInlineError(reason instanceof Error ? reason.message : t("개인 MCP 키를 만들지 못했습니다."));
    } finally {
      setBusy("");
    }
  }

  async function copyOauthPrompt() {
    if (busy) return;
    setInlineError("");
    setBusy("oauth");
    try {
      const response = await fetch("/api/integration-tokens", { method: "POST" });
      const data = await response.json().catch(() => ({})) as { prompt?: string; error?: string };
      if (!response.ok || !data.prompt) throw new Error(apiError(data, "OAuth 연결 문구를 만들지 못했습니다."));
      await copy(data.prompt, t("OAuth 연결 문구를 복사했습니다."));
    } catch (reason) {
      setInlineError(reason instanceof Error ? reason.message : t("OAuth 연결 문구를 만들지 못했습니다."));
    } finally {
      setBusy("");
    }
  }

  async function revoke(kind: "client" | "mcp", key: KeySummary) {
    if (busy) return;
    const confirmed = await confirmAction({
      title: t("연동 키 폐기"),
      message: t("'{value1}' 키만 즉시 폐기합니다. 다른 AI 연결과 키는 유지됩니다.", { value1: messageValue(key.name) }),
      confirmLabel: t("키 폐기"),
      danger: true,
    });
    if (!confirmed) return;
    setBusy(`revoke:${key.id}`);
    setInlineError("");
    try {
      const path = kind === "client" ? "clients" : "personal-mcp";
      const response = await fetch(`/api/integration-tokens/${path}?id=${encodeURIComponent(key.id)}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(apiError(data, "연동 키를 폐기하지 못했습니다."));
      if (kind === "client") {
        setClientKeys((current) => current.filter((entry) => entry.id !== key.id));
        if (createdClientKey?.connection.id === key.id) setCreatedClientKey(null);
      } else {
        setMcpKeys((current) => current.filter((entry) => entry.id !== key.id));
        if (createdMcpKey?.connection.id === key.id) setCreatedMcpKey(null);
      }
      onNotice(t("연동 키를 폐기했습니다."));
    } catch (reason) {
      setInlineError(reason instanceof Error ? reason.message : t("연동 키를 폐기하지 못했습니다."));
    } finally {
      setBusy("");
    }
  }

  function clearAndClose() {
    setCreatedClientKey(null);
    setCreatedMcpKey(null);
    onClose();
  }

  const clientCurl = createdClientKey ? buildClientCurl(createdClientKey.token) : "";
  const mcpPrompt = createdMcpKey ? buildMcpPrompt(createdMcpKey.token, workspaceName, createdMcpKey.access === "read" ? "read" : "read_write") : "";

  return <OverlayDialog title={t("외부 연동")} className="client-integration-dialog" history={false} onRequestClose={clearAndClose}>
    {(requestClose) => <section className="client-integration-guide">
      <header><div><h2>{t("외부 연동")}</h2><p>{workspaceName}</p></div><button type="button" className="icon-button" onClick={() => { setCreatedClientKey(null); setCreatedMcpKey(null); requestClose("close-button"); }} aria-label={t("외부 연동 닫기")}><X size={18} /></button></header>
      <div className="client-integration-tabs" role="tablist" aria-label={t("외부 연동 방식")}>
        {tabs.map((value, index) => <button key={value} id={`${id}-${value}`} type="button" role="tab" aria-selected={tab === value} aria-controls={`${id}-panel-${value}`} tabIndex={tab === value ? 0 : -1} onClick={() => selectTab(value)} onKeyDown={(event) => tabKey(event, index)}>{value === "api" ? t("고객 API") : "MCP"}</button>)}
      </div>
      <div className="client-integration-scroll">
        {tab === "api" ? <section id={`${id}-panel-api`} role="tabpanel" aria-labelledby={`${id}-api`} className="client-integration-panel" tabIndex={0}>
          <header><div><h3>{t("고객 API")}</h3><p>{t("외부 고객 시스템이 변경될 때 OKRI로 고객과 제품을 전송합니다.")}</p></div><code>okri:clients:write</code></header>
          <IntegrationFacts rows={[
            [t("Endpoint"), "/api/integrations/clients/upsert"],
            [t("필수 헤더"), "Authorization: Bearer <API_KEY> · Idempotency-Key · Content-Type: application/json"],
            [t("단건 필드"), "source_name, source_url, external_customer_id, name, phone, email, products"],
            [t("Bulk 필드"), "source_name, source_url, clients[], replace_products"],
            [t("재시도 규칙"), t("동일 요청 재시도에만 같은 Idempotency-Key를 사용합니다.")],
          ]} />
          {canManageClientKeys ? <>
            <div className="integration-key-create">
              <label><span>{t("API 키 이름")}</span><input value={clientName} onChange={(event) => setClientName(event.target.value)} maxLength={50} /></label>
              <button type="button" className="primary-action" onClick={() => void createClientKey()} disabled={Boolean(busy) || !clientName.trim()}>{busy === "client" ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />}{busy === "client" ? t("생성 중") : t("고객 API 키 생성")}</button>
            </div>
            {createdClientKey && <OneTimeSecret title={t("새 고객 API 키")} secret={createdClientKey.token}>
              <button type="button" onClick={() => void copy(createdClientKey.token, t("API 키를 복사했습니다."))}><Copy size={14} />{t("API 키 복사")}</button>
              <button type="button" onClick={() => void copy(clientCurl, t("curl 전체 예시를 복사했습니다."))}><Copy size={14} />{t("curl 전체 복사")}</button>
              <button type="button" onClick={() => void copy(CLIENT_EXAMPLE, t("JSON 예시를 복사했습니다."))}><Copy size={14} />{t("JSON 예시 복사")}</button>
            </OneTimeSecret>}
            <KeyList title={t("고객 API 키")} keys={clientKeys} loading={loading} onRefresh={refresh} busy={busy} onRevoke={(key) => void revoke("client", key)} />
          </> : <PermissionNote text={t("고객 동기화 키는 Owner 또는 Admin만 관리할 수 있습니다.")} />}
          {!createdClientKey && <button type="button" className="integration-copy-secondary" onClick={() => void copy(CLIENT_EXAMPLE, t("JSON 예시를 복사했습니다."))}><Copy size={14} />{t("JSON 예시 복사")}</button>}
        </section> : <section id={`${id}-panel-mcp`} role="tabpanel" aria-labelledby={`${id}-mcp`} className="client-integration-panel" tabIndex={0}>
          <header><div><h3>MCP</h3><p>{t("ChatGPT와 Claude는 OAuth 연결을 권장합니다.")}</p></div><code>{PUBLIC_MCP_URL}</code></header>
          <div className="integration-oauth-callout"><ShieldCheck size={19} /><div><b>{t("OAuth 연결 권장")}</b><p>{t("키를 직접 보관하지 않고 현재 사용자와 워크스페이스 권한으로 연결합니다.")}</p></div><button type="button" className="primary-action" onClick={() => void copyOauthPrompt()} disabled={Boolean(busy)}>{busy === "oauth" ? <LoaderCircle className="spin" size={15} /> : <Copy size={15} />}{busy === "oauth" ? t("준비 중") : t("연결 문구 복사")}</button></div>
          <details className="personal-mcp-key" open={mcpKeyOpen} onToggle={(event) => setMcpKeyOpen(event.currentTarget.open)}>
            <summary>{t("OAuth 미지원 도구용 개인 MCP 키")}</summary>
            <div>
              <p>{t("사용자마다 자신의 키를 만드세요. 팀 공유 키는 권장하지 않습니다.")}</p>
              <div className="integration-key-create mcp">
                <label><span>{t("키 이름")}</span><input value={mcpName} onChange={(event) => setMcpName(event.target.value)} maxLength={50} /></label>
                <label><span>{t("권한")}</span><select value={mcpAccess} onChange={(event) => setMcpAccess(event.target.value as "read" | "read_write")}><option value="read">{t("조회 전용")}</option>{canCreateMcpWriteKey && <option value="read_write">{t("조회 및 수정")}</option>}</select></label>
                <button type="button" className="primary-action" onClick={() => void createMcpKey()} disabled={Boolean(busy) || !mcpName.trim()}>{busy === "mcp" ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />}{busy === "mcp" ? t("생성 중") : t("개인 MCP 키 생성")}</button>
              </div>
              {!canCreateMcpWriteKey && <p className="integration-permission-hint">{t("Viewer는 조회 전용 키만 만들 수 있습니다.")}</p>}
              {createdMcpKey && <OneTimeSecret title={t("새 개인 MCP 키")} secret={createdMcpKey.token}>
                <button type="button" onClick={() => void copy(createdMcpKey.token, t("MCP 키를 복사했습니다."))}><Copy size={14} />{t("MCP 키 복사")}</button>
                <button type="button" onClick={() => void copy(mcpPrompt, t("MCP 연결 설정을 복사했습니다."))}><Copy size={14} />{t("연결 설정 복사")}</button>
              </OneTimeSecret>}
              <KeyList title={t("개인 MCP 키")} keys={mcpKeys} loading={loading} onRefresh={refresh} busy={busy} onRevoke={(key) => void revoke("mcp", key)} showAccess />
            </div>
          </details>
        </section>}
        {loadError && <p className="integration-inline-error" role="alert">{loadError}</p>}
        {inlineError && <p className="integration-inline-error" role="alert">{inlineError}</p>}
        <SecurityRules />
      </div>
      <footer><button type="button" onClick={() => { setCreatedClientKey(null); setCreatedMcpKey(null); requestClose("close-button"); }}>{t("닫기")}</button></footer>
    </section>}
  </OverlayDialog>;
}

function IntegrationFacts({ rows }: { rows: Array<[string, string]> }) {
  return <dl className="integration-facts">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>)}</dl>;
}

function OneTimeSecret({ title, secret, children }: { title: string; secret: string; children: ReactNode }) {
  return <section className="one-time-secret" aria-label={title}><div><Check size={16} /><span><b>{title}</b><small>{t("이 값은 지금만 표시됩니다. 닫기 전에 필요한 곳에 입력하세요.")}</small></span></div><code>{secret}</code><div>{children}</div></section>;
}

function KeyList({ title, keys, loading, busy, onRefresh, onRevoke, showAccess = false }: {
  title: string;
  keys: KeySummary[];
  loading: boolean;
  busy: string;
  onRefresh: () => Promise<void>;
  onRevoke: (key: KeySummary) => void;
  showAccess?: boolean;
}) {
  return <section className="integration-key-list"><header><div><b>{title}</b><span>{t("{count}개", { count: keys.length })}</span></div><button type="button" className="icon-button" onClick={() => void onRefresh()} disabled={loading} aria-label={t("키 목록 새로고침")} title={t("키 목록 새로고침")}><RefreshCw size={14} /></button></header>
    {loading ? <p>{t("키 목록을 불러오는 중입니다.")}</p> : keys.length ? <div>{keys.map((key) => <article key={key.id}><span><b>{key.name}</b><code>{key.tokenPrefix}</code></span><small>{showAccess ? `${key.access === "read_write" ? t("조회 및 수정") : t("조회 전용")} · ` : ""}{t("생성 {value1}", { value1: messageValue(formatTime(key.createdAt)) })} · {key.lastUsedAt ? t("최근 사용 {value1}", { value1: messageValue(formatTime(key.lastUsedAt)) }) : t("사용 전")}</small><button type="button" className="icon-button danger-icon" onClick={() => onRevoke(key)} disabled={Boolean(busy)} aria-label={t("{value1} 키 폐기", { value1: messageValue(key.name) })} title={t("키 폐기")}>{busy === `revoke:${key.id}` ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}</button></article>)}</div> : <p>{t("발급된 키가 없습니다.")}</p>}
  </section>;
}

function PermissionNote({ text }: { text: string }) {
  return <div className="integration-permission-note"><ShieldCheck size={18} /><p>{text}</p></div>;
}

function SecurityRules() {
  return <section className="integration-security-rules"><ShieldCheck size={18} /><div><b>{t("키 보안 원칙")}</b><ul><li>{t("신뢰하는 서버 또는 개인 AI에만 입력합니다.")}</li><li>{t("소스 코드, 채팅, 스크린샷에 저장하지 않습니다.")}</li><li>{t("유출이 의심되면 해당 키를 즉시 폐기합니다.")}</li></ul></div></section>;
}

function buildClientCurl(token: string) {
  return [
    `curl -X POST ${CLIENT_ENDPOINT}`,
    `  -H "Authorization: Bearer ${token}"`,
    "  -H \"Idempotency-Key: customer-cus_1024-v1\"",
    "  -H \"Content-Type: application/json\"",
    `  -d '${JSON.stringify(JSON.parse(CLIENT_EXAMPLE))}'`,
  ].join(" \\" + "\n");
}

function buildMcpPrompt(token: string, workspaceName: string, access: "read" | "read_write") {
  return [
    t("OKRI MCP를 현재 AI 도구에 연결해 주세요."),
    t("서버 주소: {value1}", { value1: messageValue(PUBLIC_MCP_URL) }),
    `Authorization: Bearer ${token}`,
    t("워크스페이스: {value1}", { value1: messageValue(workspaceName) }),
    t("권한: {value1}", { value1: access === "read_write" ? t("조회 및 수정") : t("조회 전용") }),
    t("이 키는 현재 사용자와 워크스페이스에만 사용합니다."),
    t("소스 코드, 채팅, 스크린샷에 저장하지 않습니다."),
    t("유출이 의심되면 해당 키를 즉시 폐기합니다."),
  ].join("\n");
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? t("정보 없음") : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
