"use client";

import {
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  Mail,
  Package,
  Phone,
  Plus,
  Search,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { ClientProductRecord, ClientRecord, TicketClientLink } from "@/lib/client-directory";
import { apiError, messageValue, t } from "@/lib/client-language";
import { OverlayDialog, useAppConfirm } from "./overlay-dialog";

type NoticeTone = "success" | "error" | "info";
type Notice = (message: string, tone?: NoticeTone) => void;

export function useTicketClients(enabled: boolean, workspaceId: string) {
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [links, setLinks] = useState<TicketClientLink[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loadedWorkspaceId, setLoadedWorkspaceId] = useState("");
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled || !workspaceId) return;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError("");
    try {
      const [clientsResponse, linksResponse] = await Promise.all([
        fetch("/api/clients", { cache: "no-store" }),
        fetch("/api/ticket-client-links", { cache: "no-store" }),
      ]);
      const clientsData = await clientsResponse.json().catch(() => ({})) as { clients?: ClientRecord[]; error?: string };
      const linksData = await linksResponse.json().catch(() => ({})) as { links?: TicketClientLink[]; error?: string };
      if (!clientsResponse.ok) throw new Error(apiError(clientsData, t("클라이언트를 불러오지 못했습니다.")));
      if (!linksResponse.ok) throw new Error(apiError(linksData, t("Ticket 연결을 불러오지 못했습니다.")));
      if (requestIdRef.current !== requestId) return;
      setClients(clientsData.clients ?? []);
      setLinks(linksData.links ?? []);
      setLoadedWorkspaceId(workspaceId);
    } catch (reason) {
      if (requestIdRef.current !== requestId) return;
      setError(reason instanceof Error ? reason.message : t("클라이언트를 불러오지 못했습니다."));
      setLoadedWorkspaceId(workspaceId);
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [enabled, workspaceId]);

  useEffect(() => {
    if (!enabled || !workspaceId) return;
    const timeout = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timeout);
  }, [enabled, refresh, workspaceId]);

  return {
    clients: loadedWorkspaceId === workspaceId ? clients : [],
    links: loadedWorkspaceId === workspaceId ? links : [],
    loading: loading || loadedWorkspaceId !== workspaceId,
    error: loadedWorkspaceId === workspaceId ? error : "",
    refresh,
  };
}

export function ClientManagementView({ clients, loading, error, readOnly, onRefresh, onNotice }: {
  clients: ClientRecord[];
  loading: boolean;
  error: string;
  readOnly: boolean;
  onRefresh: () => Promise<void>;
  onNotice: Notice;
}) {
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | "api" | "manual">("all");
  const [editorId, setEditorId] = useState<string | "new" | null>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleClients = useMemo(() => clients.filter((client) => {
    if (sourceFilter !== "all" && client.sourceType !== sourceFilter) return false;
    return !normalizedQuery || [
      client.name,
      client.phone,
      client.email,
      client.sourceName ?? "",
      ...client.products.map((product) => product.name),
    ].join(" ").toLocaleLowerCase().includes(normalizedQuery);
  }), [clients, normalizedQuery, sourceFilter]);
  const selected = editorId === "new" ? null : clients.find((client) => client.id === editorId) ?? null;

  return (
    <section className="client-directory" aria-label={t("클라이언트 관리")}>
      <div className="client-directory-toolbar">
        <label><Search size={14} /><span className="sr-only">{t("클라이언트 검색")}</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("이름, 연락처, 제품 검색")} /></label>
        <div className="client-source-filter" role="group" aria-label={t("등록 출처 필터")}>
          {(["all", "api", "manual"] as const).map((value) => <button key={value} type="button" aria-pressed={sourceFilter === value} onClick={() => setSourceFilter(value)}>{value === "all" ? t("전체") : value === "api" ? t("API 연동") : t("수동 등록")}</button>)}
        </div>
        <span>{t("{count}개", { count: visibleClients.length })}</span>
        {!readOnly && <button type="button" className="client-create-button" onClick={() => setEditorId("new")}><Plus size={14} />{t("클라이언트 추가")}</button>}
      </div>
      {loading && !clients.length ? <p className="client-directory-state">{t("클라이언트를 불러오는 중입니다.")}</p> : error && !clients.length ? (
        <div className="client-directory-state" role="alert"><span>{error}</span><button type="button" onClick={() => void onRefresh()}>{t("다시 시도")}</button></div>
      ) : (
        <div className="client-directory-list">
          {visibleClients.map((client) => <ClientDirectoryRow key={client.id} client={client} onOpen={() => setEditorId(client.id)} onNotice={onNotice} />)}
          {!visibleClients.length && <p className="client-directory-state">{normalizedQuery ? t("검색 결과가 없습니다.") : t("등록된 클라이언트가 없습니다.")}</p>}
        </div>
      )}
      {editorId && (editorId === "new" || selected) && (
        <ClientEditor
          key={editorId}
          client={selected}
          readOnly={readOnly}
          onClose={() => setEditorId(null)}
          onSaved={async (message) => { await onRefresh(); setEditorId(null); onNotice(message); }}
          onNotice={onNotice}
        />
      )}
    </section>
  );
}

function ClientDirectoryRow({ client, onOpen, onNotice }: { client: ClientRecord; onOpen: () => void; onNotice: Notice }) {
  return (
    <article className="client-directory-row">
      <button type="button" className="client-directory-open" onClick={onOpen}>
        <span className="client-avatar"><UserRound size={15} /></span>
        <span><b>{client.name}</b><small>{client.products.length ? client.products.map((product) => product.name).join(" · ") : t("제품 없음")}</small></span>
      </button>
      <CopyValue icon={Phone} label={t("전화번호")} value={client.phone} emptyLabel={t("전화번호 없음")} onNotice={onNotice} />
      <CopyValue icon={Mail} label={t("이메일")} value={client.email} emptyLabel={t("이메일 없음")} onNotice={onNotice} />
      <ClientSource client={client} />
      <button type="button" className="icon-button client-row-open-icon" onClick={onOpen} aria-label={t("{value1} 상세 열기", { value1: messageValue(client.name) })}><ChevronRight size={15} /></button>
    </article>
  );
}

function ClientEditor({ client, readOnly, onClose, onSaved, onNotice }: {
  client: ClientRecord | null;
  readOnly: boolean;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
  onNotice: Notice;
}) {
  const confirmAction = useAppConfirm();
  const [name, setName] = useState(client?.name ?? "");
  const [phone, setPhone] = useState(client?.phone ?? "");
  const [email, setEmail] = useState(client?.email ?? "");
  const [products, setProducts] = useState<Array<{ rowId: string; id?: string; name: string }>>(() => (client?.products ?? []).map((product) => ({ rowId: product.id, id: product.id, name: product.name })));
  const [saving, setSaving] = useState(false);
  const initial = JSON.stringify({ name: client?.name ?? "", phone: client?.phone ?? "", email: client?.email ?? "", products: (client?.products ?? []).map(({ id, name: productName }) => ({ id, name: productName })) });
  const current = JSON.stringify({ name, phone, email, products: products.map(({ id, name: productName }) => ({ id, name: productName })) });
  const dirty = !readOnly && initial !== current;

  function addProduct() {
    setProducts((rows) => [...rows, { rowId: crypto.randomUUID(), name: "" }]);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (readOnly || saving || !name.trim()) return;
    const cleanProducts = products.map((product) => ({ id: product.id, name: product.name.trim() })).filter((product) => product.name);
    setSaving(true);
    try {
      const response = await fetch("/api/clients", {
        method: client ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(client ? { id: client.id } : {}), name: name.trim(), phone: phone.trim(), email: email.trim(), products: cleanProducts }),
      });
      const data = await response.json().catch(() => ({})) as { client?: ClientRecord; error?: string };
      if (!response.ok || !data.client) throw new Error(apiError(data, "클라이언트를 저장하지 못했습니다."));
      await onSaved(client ? t("클라이언트 정보를 수정했습니다.") : t("클라이언트를 추가했습니다."));
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : t("클라이언트를 저장하지 못했습니다."), "error");
    } finally {
      setSaving(false);
    }
  }

  async function removeClient() {
    if (!client || readOnly || saving) return;
    const confirmed = await confirmAction({
      title: t("클라이언트 영구 삭제"),
      message: t("'{value1}' 클라이언트와 Ticket 연결을 영구 삭제합니다. Ticket과 제품 원본 데이터는 유지되지 않으며 되돌릴 수 없습니다.", { value1: messageValue(client.name) }),
      confirmationText: client.name,
      confirmLabel: t("영구 삭제"),
      danger: true,
    });
    if (!confirmed) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/clients?id=${encodeURIComponent(client.id)}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(apiError(data, "클라이언트를 삭제하지 못했습니다."));
      await onSaved(t("클라이언트를 삭제했습니다."));
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : t("클라이언트를 삭제하지 못했습니다."), "error");
      setSaving(false);
    }
  }

  return (
    <OverlayDialog title={client ? t("클라이언트 수정") : t("클라이언트 추가")} variant="drawer" history={false} dirty={dirty} onRequestClose={onClose}>
      {(requestClose) => <aside className="property-panel client-editor-panel">
        <header><div><p>{t("클라이언트 관리")}</p><h2>{client ? client.name : t("새 클라이언트")}</h2></div><button type="button" className="icon-button" onClick={() => requestClose("close-button")} aria-label={t("닫기")}><X size={17} /></button></header>
        <form className="client-editor-form" onSubmit={(event) => void save(event)}>
          <section className="client-fields">
            {client && <ClientSource client={client} expanded />}
            <label><span>{t("고객명")}</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} disabled={readOnly} required /></label>
            <label><span>{t("전화번호")}</span><input type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} maxLength={80} disabled={readOnly} /></label>
            <label><span>{t("이메일")}</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} disabled={readOnly} /></label>
          </section>
          <section className="client-products-editor">
            <header><div><b>{t("제품")}</b><span>{t("{count}개", { count: products.length })}</span></div>{!readOnly && <button type="button" onClick={addProduct}><Plus size={14} />{t("제품 추가")}</button>}</header>
            <div>
              {products.map((product, index) => <div className="client-product-row" key={product.rowId}>
                <Package size={15} aria-hidden="true" />
                <input aria-label={t("제품명 {value1}", { value1: messageValue(index + 1) })} value={product.name} onChange={(event) => setProducts((rows) => rows.map((row) => row.rowId === product.rowId ? { ...row, name: event.target.value } : row))} maxLength={200} disabled={readOnly} placeholder={t("제품명")} />
                <button type="button" className="icon-button" disabled={!product.name.trim()} onClick={() => void copyText(product.name, t("제품명을 복사했습니다."), onNotice)} aria-label={t("제품명 복사")} title={t("제품명 복사")}><Copy size={14} /></button>
                {!readOnly && <button type="button" className="icon-button danger-icon" onClick={() => setProducts((rows) => rows.filter((row) => row.rowId !== product.rowId))} aria-label={t("제품 제거")} title={t("제품 제거")}><Trash2 size={14} /></button>}
              </div>)}
              {!products.length && <p>{t("등록된 제품이 없습니다.")}</p>}
            </div>
          </section>
          <footer>
            {client && !readOnly && <button type="button" className="client-delete-button" onClick={() => void removeClient()} disabled={saving}><Trash2 size={14} />{t("삭제")}</button>}
            <span />
            <button type="button" onClick={() => requestClose("close-button")}>{t("취소")}</button>
            {!readOnly && <button type="submit" className="primary-action" disabled={saving || !name.trim()}><Check size={14} />{saving ? t("저장 중") : t("저장")}</button>}
          </footer>
        </form>
      </aside>}
    </OverlayDialog>
  );
}

function ClientSource({ client, expanded = false }: { client: ClientRecord; expanded?: boolean }) {
  const api = client.sourceType === "api";
  const safeUrl = safeExternalUrl(client.sourceUrl);
  const parsedTime = new Date(client.sourceUpdatedAt);
  const time = Number.isNaN(parsedTime.getTime()) ? t("알 수 없음") : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsedTime);
  return (
    <div className={`client-source-summary ${api ? "api" : "manual"} ${expanded ? "expanded" : ""}`}>
      <span>{api ? t("API · {value1}", { value1: messageValue(client.sourceName || t("외부 시스템")) }) : t("수동")}</span>
      <small>{t("마지막 갱신 {value1}", { value1: messageValue(time) })}</small>
      {safeUrl && <a href={safeUrl} target="_blank" rel="noopener noreferrer" aria-label={t("출처 열기")} title={t("출처 열기")}><ExternalLink size={13} /></a>}
    </div>
  );
}

function safeExternalUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "");
    const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
    const privateIpv4 = ipv4 && (ipv4.some((part) => part > 255)
      || ipv4[0] === 0 || ipv4[0] === 10 || ipv4[0] === 127 || ipv4[0] >= 224
      || (ipv4[0] === 169 && ipv4[1] === 254)
      || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)
      || (ipv4[0] === 192 && ipv4[1] === 168));
    return url.protocol === "https:" && !url.username && !url.password && hostname.includes(".") && !hostname.includes(":")
      && hostname !== "localhost" && !hostname.endsWith(".localhost") && !hostname.endsWith(".local") && !hostname.endsWith(".internal") && !privateIpv4
      ? url.toString() : null;
  } catch { return null; }
}

export function TicketClientSummary({ link, onNotice, compact = false }: { link?: TicketClientLink; onNotice: Notice; compact?: boolean }) {
  if (!link) return compact ? <span className="ticket-client-empty">{t("클라이언트 미연결")}</span> : null;
  const products = link.client.products.filter((product) => link.productIds.includes(product.id));
  return (
    <div className={`ticket-client-summary ${compact ? "compact" : ""}`}>
      <CopyValue icon={UserRound} label={t("고객명")} value={link.client.name} onNotice={onNotice} />
      <CopyValue icon={Phone} label={t("전화번호")} value={link.client.phone} emptyLabel={t("전화번호 없음")} onNotice={onNotice} />
      <CopyValue icon={Mail} label={t("이메일")} value={link.client.email} emptyLabel={t("이메일 없음")} onNotice={onNotice} />
      <div className="ticket-client-products"><Package size={14} /><span>{products.length ? products.map((product) => product.name).join(" · ") : t("제품 미선택")}</span>{products.length > 0 && <button type="button" className="icon-button" onClick={() => void copyText(products.map((product) => product.name).join(", "), t("제품명을 복사했습니다."), onNotice)} aria-label={t("연결 제품 복사")}><Copy size={13} /></button>}</div>
    </div>
  );
}

export function TicketClientEditor({ ticketId, clients, link, readOnly, loading, error, onRefresh, onNotice }: {
  ticketId: string;
  clients: ClientRecord[];
  link?: TicketClientLink;
  readOnly: boolean;
  loading: boolean;
  error: string;
  onRefresh: () => Promise<void>;
  onNotice: Notice;
}) {
  const [clientId, setClientId] = useState(link?.clientId ?? "");
  const [productIds, setProductIds] = useState<string[]>(link?.productIds ?? []);
  const [saving, setSaving] = useState(false);
  const selectedClient = clients.find((client) => client.id === clientId);

  async function save() {
    if (readOnly || saving) return;
    setSaving(true);
    try {
      const response = await fetch("/api/ticket-client-links", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId, clientId: clientId || null, productIds: clientId ? productIds : [] }),
      });
      const data = await response.json().catch(() => ({})) as { link?: TicketClientLink | null; error?: string };
      if (!response.ok) throw new Error(apiError(data, "Ticket 클라이언트를 저장하지 못했습니다."));
      await onRefresh();
      onNotice(clientId ? t("Ticket 클라이언트를 연결했습니다.") : t("Ticket 클라이언트 연결을 해제했습니다."));
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : t("Ticket 클라이언트를 저장하지 못했습니다."), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="ticket-client-editor">
      <header><div><b>{t("클라이언트")}</b><span>{link ? link.client.name : t("선택 사항")}</span></div>{!readOnly && <button type="button" onClick={() => void save()} disabled={saving || loading}>{saving ? t("저장 중") : t("저장")}</button>}</header>
      {error && !clients.length ? <div className="client-directory-state" role="alert"><span>{error}</span><button type="button" onClick={() => void onRefresh()}>{t("다시 시도")}</button></div> : (
        <>
          <label><span>{t("고객")}</span><select value={clientId} disabled={readOnly || loading} onChange={(event) => { setClientId(event.target.value); setProductIds([]); }}><option value="">{t("연결 안 함")}</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
          {selectedClient && <div className="ticket-client-contact"><CopyValue icon={Phone} label={t("전화번호")} value={selectedClient.phone} emptyLabel={t("전화번호 없음")} onNotice={onNotice} /><CopyValue icon={Mail} label={t("이메일")} value={selectedClient.email} emptyLabel={t("이메일 없음")} onNotice={onNotice} /></div>}
          {selectedClient && <fieldset disabled={readOnly}><legend>{t("제품")}</legend>{selectedClient.products.map((product) => <label key={product.id}><input type="checkbox" checked={productIds.includes(product.id)} onChange={(event) => setProductIds((current) => event.target.checked ? [...current, product.id] : current.filter((id) => id !== product.id))} /><span>{product.name}</span><button type="button" className="icon-button" onClick={() => void copyText(product.name, t("제품명을 복사했습니다."), onNotice)} aria-label={t("{value1} 복사", { value1: messageValue(product.name) })}><Copy size={13} /></button></label>)}{!selectedClient.products.length && <p>{t("등록된 제품이 없습니다.")}</p>}</fieldset>}
          {readOnly && link && <TicketClientSummary link={link} onNotice={onNotice} />}
        </>
      )}
    </section>
  );
}

function CopyValue({ icon: Icon, label, value, emptyLabel, onNotice }: {
  icon: typeof Phone;
  label: string;
  value: string;
  emptyLabel?: string;
  onNotice: Notice;
}) {
  return <div className={`copy-value ${value ? "" : "empty"}`}><Icon size={14} aria-hidden="true" /><span><small>{label}</small><b>{value || emptyLabel || t("미입력")}</b></span>{value && <button type="button" className="icon-button" onClick={() => void copyText(value, t("{value1}을 복사했습니다.", { value1: messageValue(label) }), onNotice)} aria-label={t("{value1} 복사", { value1: messageValue(label) })} title={t("{value1} 복사", { value1: messageValue(label) })}><Copy size={13} /></button>}</div>;
}

async function copyText(value: string, message: string, onNotice: Notice) {
  try {
    await navigator.clipboard.writeText(value);
    onNotice(message);
  } catch {
    onNotice(t("복사하지 못했습니다."), "error");
  }
}

export type { ClientProductRecord, ClientRecord, TicketClientLink };
