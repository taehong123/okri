"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { AlertTriangle, CreditCard, ExternalLink, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppConfirm } from "./overlay-dialog";
import { AiUsageMeter } from "./ai-usage-meter";
import type { AiUsage } from "@/lib/ai-usage";
import { invalidateAiUsage } from "@/lib/ai-usage-client";
import { t , apiError , getClientLocale , messageValue } from "@/lib/client-language";
import "./billing-checkout.css";

type NoticeTone = "success" | "error" | "info";
type BillingPlanId = "free" | "team" | "business";
type BillingStatusData = {
  plan: BillingPlanId;
  planLabel: string;
  seatPriceWon: number;
  monthlyPriceWon: number;
  billableEditors: number;
  status: "free" | "trialing" | "active" | "past_due" | "cancel_at_period_end" | "canceled";
  nextPlan: BillingPlanId | null;
  trialEndsAt: string | null;
  currentPeriodEndsAt: string | null;
  nextBillingAt: string | null;
  cancelAtPeriodEnd: boolean;
  graceEndsAt: string | null;
  usage: {
    projects: { used: number; limit: number | null; remaining: number | null; resetsAt: string };
    editors: { used: number; limit: number | null; remaining: number | null; enforced: boolean; graceEndsAt: string | null };
    ai: AiUsage;
    storage: { usedBytes: number; limitBytes: number; remainingBytes: number };
  };
  editorMembers: Array<{ id: string; displayName: string; email: string; role: string; selected: boolean; writeAllowed: boolean }>;
  paymentMethod: { id: string; cardCompany: string; maskedCard: string; createdAt: string } | null;
  transactions: Array<{ id: string; kind: string; plan: string; priceWon: number; status: string; receiptUrl: string | null; createdAt: string }>;
  canManage: boolean;
  enforcementEnabled: boolean;
  checkoutAvailable: boolean;
  providers?: { payple: boolean; paypal: Array<{ plan: "team" | "business"; currency: string; value: string }> };
  paypal?: { plan: "team" | "business"; status: string; currency: string; value: string; seatCount: number; pendingSeatCount: number | null; paidThrough: string | null } | null;
  paypalTransactions?: Array<{ id: string; plan: string; status: string; currency: string; value: string; createdAt: string }>;
};

const plans: Array<{ id: BillingPlanId; label: string; seatPrice: number; recommended?: boolean; features: string[] }> = [
  { id: "free", label: "Free", seatPrice: 0, features: ["월 Project 30개", "최근 3개월 활동·변경 기록", "이미지 저장 공간 1GB", "매월 OKRI 기본 AI 체험 크레딧", "ChatGPT·Claude와 제한 없이 사용", "편집 멤버 5명"] },
  { id: "team", label: "Team", seatPrice: 2_900, recommended: true, features: ["Project 무제한", "전체 활동·변경 기록", "편집 멤버당 이미지 5GB · 팀이 함께 사용", "편집 멤버마다 OKRI 기본 AI 제공", "ChatGPT·Claude와 제한 없이 사용", "30일 무료 체험"] },
  { id: "business", label: "Business", seatPrice: 4_900, features: ["Project 무제한", "전체 활동·변경 기록", "편집 멤버당 이미지 20GB · 팀이 함께 사용", "Team보다 2.5배 많은 OKRI 기본 AI", "ChatGPT·Claude와 제한 없이 사용", "30일 무료 체험"] },
];

export default function BillingView({ onNotice }: { onNotice: (message: string, tone?: NoticeTone) => void }) {
  const confirmAction = useAppConfirm();
  const [billing, setBilling] = useState<BillingStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedPlan, setSelectedPlan] = useState<BillingPlanId>("team");
  const [contractAccepted, setContractAccepted] = useState(false);
  const [selectedEditorIds, setSelectedEditorIds] = useState<string[]>([]);
  const [working, setWorking] = useState<"checkout" | "change" | "cancel" | "refund" | null>(null);
  const [paypalAccepted, setPaypalAccepted] = useState(false);
  const [paypalNotice, setPaypalNotice] = useState("");
  const returnHandled = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/billing/status", { cache: "no-store" });
      const data = await response.json() as BillingStatusData & { error?: string };
      if (!response.ok) throw new Error(apiError(data, "결제 정보를 불러오지 못했습니다."));
      setBilling(data);
      invalidateAiUsage();
      setSelectedPlan(data.paypal?.plan ?? (data.plan === "free" ? "team" : data.plan));
      setSelectedEditorIds(data.editorMembers.filter((member) => member.selected).map((member) => member.id));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("결제 정보를 불러오지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const syncPayPal = useCallback(async () => {
    if (working) return;
    setWorking("change");
    try {
      const response = await fetch("/api/billing/paypal/sync", { method: "POST" });
      const data = await response.json() as { entitled?: boolean; code?: string };
      if (!response.ok) throw new Error(paymentError(data));
      setPaypalNotice(data.entitled ? t("결제를 확인했습니다. 요금제가 적용되었습니다.") : t("결제 승인 결과를 확인 중입니다. 잠시 후 다시 확인해 주세요."));
      await refresh();
    } catch (error) { setPaypalNotice(error instanceof Error ? error.message : t("결제 정보를 불러오지 못했습니다.")); }
    finally { setWorking(null); }
  }, [refresh, working]);

  async function revisePayPalEditors() {
    if (!billing?.canManage || !billing.paypal || working) return;
    setWorking("change");
    try {
      const response = await fetch("/api/billing/paypal/seats", { method: "POST" });
      const data = await response.json() as { changed?: boolean; approvalUrl?: string; code?: string };
      if (!response.ok) throw new Error(paymentError(data));
      if (!data.changed) {
        setPaypalNotice(t("현재 편집 멤버 수가 PayPal 결제에 반영되어 있습니다."));
        await refresh();
        return;
      }
      if (!data.approvalUrl) throw new Error(t("결제를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요."));
      const approval = new URL(data.approvalUrl);
      if (approval.protocol !== "https:" || !["www.paypal.com", "www.sandbox.paypal.com"].includes(approval.hostname)) throw new Error(t("결제를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요."));
      window.location.assign(approval.href);
    } catch (error) {
      setPaypalNotice(error instanceof Error ? error.message : t("결제 정보를 불러오지 못했습니다."));
      setWorking(null);
    }
  }

  useEffect(() => {
    if (!billing?.canManage || returnHandled.current) return;
    const url = new URL(window.location.href);
    const result = url.searchParams.get("paypal");
    if (!result) return;
    returnHandled.current = true;
    for (const key of ["paypal", "subscription_id", "ba_token", "token"]) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, "", url);
    if (result === "return") void syncPayPal();
    else setPaypalNotice(t("결제를 취소했습니다. 요금제는 변경되지 않았습니다."));
  }, [billing?.canManage, syncPayPal]);

  async function startPayPal() {
    const price = billing?.providers?.paypal.find((entry) => entry.plan === selectedPlan);
    if (!billing?.canManage || !paypalAccepted || !price || working) return;
    setWorking("checkout");
    try {
      const response = await fetch("/api/billing/paypal/checkout", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: selectedPlan, contractAccepted: true, currency: price.currency, value: price.value, seats: billing.billableEditors }) });
      const data = await response.json() as { approvalUrl?: string; code?: string };
      if (!response.ok || !data.approvalUrl) throw new Error(paymentError(data));
      const approval = new URL(data.approvalUrl);
      if (approval.protocol !== "https:" || !["www.paypal.com", "www.sandbox.paypal.com"].includes(approval.hostname)) throw new Error(t("결제를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요."));
      window.location.assign(approval.href);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : t("결제 정보를 불러오지 못했습니다."), "error");
      setWorking(null);
    }
  }

  async function startCheckout() {
    if (!billing?.canManage || !contractAccepted || working) return;
    setWorking("checkout");
    try {
      const response = await fetch("/api/billing/payple/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: selectedPlan, contractAccepted: true }),
      });
      const session = await response.json() as { error?: string; messageCode?: string; sessionToken?: string; authUrl?: string; merchantId?: string; returnUrl?: string };
      if (!response.ok || !session.sessionToken || !session.authUrl) throw new Error(apiError(session, "카드 등록을 시작하지 못했습니다."));
      await loadExternalScript(session.authUrl);
      if (!window.PaypleCpayAuthCheck) throw new Error(t("Payple 카드 등록 모듈을 불러오지 못했습니다."));
      window.PaypleCpayAuthCheck({
        clientKey: session.merchantId,
        PCD_PAY_TYPE: "card",
        PCD_PAY_WORK: "AUTH",
        PCD_CARD_VER: "01",
        PCD_RST_URL: session.returnUrl,
        callbackFunction: async (result: Record<string, unknown>) => {
          try {
            const billingKey = String(result.PCD_PAYER_ID || "");
            const complete = await fetch("/api/billing/payple/result", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                sessionToken: session.sessionToken,
                payerId: String(result.PCD_PAYER_NO || billingKey),
                billingKey,
                maskedCard: String(result.PCD_PAY_CARDNUM || ""),
                cardCompany: String(result.PCD_PAY_CARDNAME || ""),
                paypleTransactionId: String(result.PCD_PAY_AUTHNO || ""),
              }),
            });
            const completed = await complete.json() as { error?: string; messageCode?: string };
            if (!complete.ok) throw new Error(apiError(completed, "카드 등록을 완료하지 못했습니다."));
            onNotice(t("결제를 확인했습니다. 요금제가 적용되었습니다."), "success");
            await refresh();
          } catch (completeError) {
            onNotice(completeError instanceof Error ? completeError.message : t("카드 등록을 완료하지 못했습니다."), "error");
          } finally { setWorking(null); }
        },
      }, "prod");
    } catch (checkoutError) {
      onNotice(checkoutError instanceof Error ? checkoutError.message : t("카드 등록을 시작하지 못했습니다."), "error");
      setWorking(null);
    }
  }

  async function requestPlanChange(plan: BillingPlanId) {
    if (!billing?.canManage || working) return;
    const approved = await confirmAction({
      title: plan === "free" ? t("Free 플랜으로 변경할까요?") : t("{value1} 플랜으로 변경할까요?", { value1: messageValue(plans.find((entry) => entry.id === plan)?.label) }),
      message: plan === "free" ? t("현재 결제기간이 끝나면 Free 한도가 적용됩니다. 데이터와 기존 역할은 유지됩니다.") : t("상향은 결제 승인 후, 하향은 다음 갱신일부터 적용됩니다."),
      confirmLabel: t("변경"),
    });
    if (!approved) return;
    await billingAction("change", "/api/billing/change-plan", { plan }, "플랜 변경을 반영했습니다.");
  }

  async function cancel() {
    if (!billing?.canManage || working) return;
    const approved = await confirmAction({ title: t("구독을 해지할까요?"), message: t("자동 갱신은 즉시 중단되고 현재 결제기간 끝까지 이용한 뒤 Free로 전환됩니다. 데이터는 삭제되지 않습니다."), confirmLabel: t("구독 해지"), danger: true });
    if (!approved) return;
    await billingAction("cancel", "/api/billing/cancel", undefined, "자동 갱신을 중단했습니다.");
  }

  async function refund() {
    if (!billing?.canManage || working) return;
    const approved = await confirmAction({ title: t("첫 결제를 전액 환불할까요?"), message: t("첫 결제 후 7일 이내이고 결제 후 Project 생성·AI 사용이 없을 때만 가능합니다. 성공하면 즉시 Free로 전환됩니다."), confirmLabel: t("환불 요청"), danger: true });
    if (!approved) return;
    await billingAction("refund", "/api/billing/refund", undefined, "전액 환불하고 Free로 전환했습니다.");
  }

  async function billingAction(kind: "change" | "cancel" | "refund", url: string, body: Record<string, unknown> | undefined, successMessage: string) {
    setWorking(kind);
    try {
      const response = await fetch(url, { method: "POST", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
      const data = await response.json() as { error?: string; code?: string };
      if (!response.ok) throw new Error(data.code ? paymentError(data) : apiError(data, "요청을 처리하지 못했습니다."));
      onNotice(t(successMessage), "success");
      await refresh();
    } catch (actionError) {
      onNotice(actionError instanceof Error ? actionError.message : t("요청을 처리하지 못했습니다."), "error");
    } finally { setWorking(null); }
  }

  async function saveEditors() {
    if (!billing?.canManage || working) return;
    setWorking("change");
    try {
      const response = await fetch("/api/billing/editors", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memberIds: selectedEditorIds }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(apiError(data, "활성 편집자를 저장하지 못했습니다."));
      onNotice(t("활성 편집자 선택을 저장했습니다."), "success");
      await refresh();
    } catch (saveError) {
      onNotice(saveError instanceof Error ? saveError.message : t("활성 편집자를 저장하지 못했습니다."), "error");
    } finally { setWorking(null); }
  }

  if (loading) return <section className="billing-page"><div className="billing-loading" role="status"><LoaderCircle className="spin" size={20} />{t("요금제와 사용량을 불러오는 중입니다.")}</div></section>;
  if (!billing) return <section className="billing-page"><div className="billing-load-error" role="alert"><CreditCard size={20} /><b>{t("결제 정보를 불러오지 못했습니다")}</b><p>{error}</p><button onClick={() => void refresh()}>{t("다시 시도")}</button></div></section>;

  return <section className="billing-page" aria-label={t("요금제 및 결제")}>
    <header className="billing-hero"><div><h2>{billing.planLabel} {t("플랜")}</h2><p>{t("Project·Task·Routine 본문은 플랜을 바꾸어도 그대로 유지됩니다.")}</p></div><div className={`billing-status billing-status-${billing.status}`}><b>{statusLabel(billing.status)}</b><small>{billing.trialEndsAt ? t("체험 종료 {value1}", { value1: messageValue(formatDate(billing.trialEndsAt)) }) : billing.nextBillingAt ? t("다음 결제 {value1}", { value1: messageValue(formatDate(billing.nextBillingAt)) }) : t("VAT 포함")}</small></div></header>
    {billing.plan === "free" && <p className="billing-free-intro">{t("5명까지 무료로 함께 일하세요. 카드 등록 없이 시작할 수 있습니다.")}</p>}
    {paypalNotice && <p className="billing-payment-notice" role="status">{paypalNotice}</p>}
    {billing.status === "past_due" && <div className="billing-alert" role="alert"><AlertTriangle size={18} /><div><b>{t("결제를 다시 확인해 주세요")}</b><p>{billing.graceEndsAt ? t("{value1}까지 현재 플랜을 유지하며 자동으로 재시도합니다.", { value1: messageValue(formatDate(billing.graceEndsAt)) }) : t("결제수단을 확인해 주세요.")}</p></div></div>}

    <section className="billing-usage-section"><header><div><span>{t("현재")}</span><h3>{t("플랜 사용량")}</h3></div><small>{t("Project와 AI 사용량은 한국시간 매월 1일 초기화")}</small></header><div className="billing-usage-grid"><ProjectUsage billing={billing} /><StorageUsage storage={billing.usage.storage} /><BillingSeats billing={billing} /><AiUsageMeter usage={billing.usage.ai} /></div></section>

    {billing.usage.editors.graceEndsAt && !billing.usage.editors.enforced && <div className="billing-editor-grace" role="status"><AlertTriangle size={18} /><div><b>{t("기존 워크스페이스 편집자 정리 유예")}</b><p>{formatDate(billing.usage.editors.graceEndsAt)}{t("까지 편집 권한을 정리할 수 있습니다. 그전에는 초과 멤버를 읽기 전용으로 전환하지 않습니다.")}</p></div></div>}

    {billing.canManage && billing.usage.editors.enforced && billing.usage.editors.limit !== null && <section className="billing-editors-section"><header><div><h3>{t("활성 편집자 선택")}</h3></div><p>{t("한도를 넘는 멤버의 역할과 데이터는 유지되고 읽기 전용으로 전환됩니다.")}</p></header><div className="billing-editor-list">{billing.editorMembers.map((member) => { const checked = selectedEditorIds.includes(member.id); const owner = member.role === "owner"; const atLimit = !checked && selectedEditorIds.length >= billing.usage.editors.limit!; return <label aria-label={t("{value1} 활성 편집자", { value1: messageValue(member.displayName) })} className={checked ? "selected" : ""} key={member.id}><input type="checkbox" checked={checked} disabled={owner || atLimit} onChange={(event) => setSelectedEditorIds((current) => event.target.checked ? [...current, member.id] : current.filter((id) => id !== member.id))} /><span><b>{member.displayName}</b><small>{member.email || member.role} · {owner ? t("Owner는 필수") : checked ? t("편집 가능") : t("읽기 전용")}</small></span></label>; })}</div><footer><small>{selectedEditorIds.length} / {billing.usage.editors.limit}{t("명 선택")}</small><button type="button" onClick={() => void saveEditors()} disabled={Boolean(working)}>{t("선택 저장")}</button></footer></section>}

    <section className="billing-plans-section" aria-labelledby="billing-plans-heading">
      <header><div><h3 id="billing-plans-heading">{t("플랜 비교")}</h3></div><p>{t("월간 결제 · VAT 포함")}</p></header>
      <div className="billing-plan-grid">{plans.map((plan) => {
        const current = billing.plan === plan.id;
        const selected = !billing.paymentMethod && !billing.paypal && selectedPlan === plan.id && plan.id !== "free";
        const canSelect = billing.canManage && billing.checkoutAvailable && !billing.paymentMethod && !billing.paypal && plan.id !== "free";
        const canChange = billing.canManage && Boolean(billing.paymentMethod) && !billing.paypal && !current;
        return <article className={`billing-plan-card ${current ? "current" : ""} ${selected ? "selected" : ""}`} key={plan.id}>
          <header><div className="billing-plan-heading"><h4>{plan.label}</h4><div className="billing-plan-badges">{current && <span>{t("현재 플랜")}</span>}{plan.recommended && <span>{t("추천 플랜")}</span>}</div></div></header>
          <p className="billing-plan-price"><strong>{plan.seatPrice.toLocaleString(getClientLocale())}{t("원")}</strong><span>{plan.id === "free" ? t("/ 월") : t("/ 편집 멤버 · 월")}</span></p>
          <p className="billing-plan-total">{plan.id === "free" ? t("{count}명까지 무료", { count: 5 }) : t("{value1} × {count}명 = {value2}/월", { value1: messageValue(formatWon(plan.seatPrice)), count: billing.billableEditors, value2: messageValue(formatWon(plan.seatPrice * billing.billableEditors)) })}</p>
          <div className="billing-plan-action">{current
            ? <span>{t("현재 플랜")}</span>
            : canChange
              ? <button className="primary-action" type="button" onClick={() => void requestPlanChange(plan.id)} disabled={Boolean(working)}>{working === "change" ? t("변경 중") : t("{value1}로 변경", { value1: messageValue(plan.label) })}</button>
              : canSelect
                ? <button className={selected ? "primary-action" : "secondary"} type="button" aria-pressed={selected} onClick={() => { setSelectedPlan(plan.id); setContractAccepted(false); setPaypalAccepted(false); }} disabled={Boolean(working)}>{selected ? t("선택됨") : t(plan.id === "team" ? "Team 플랜 선택" : "Business 플랜 선택")}</button>
                : null}</div>
          <ul>{plan.features.map((feature) => <li key={feature}>{t(feature)}</li>)}</ul>
        </article>;
      })}</div>
      <p className="billing-plan-footnote">{t("Task·Routine·Viewer와 ChatGPT·Claude 연결은 모든 플랜에서 제한 없이 제공합니다.")}</p>
    </section>

    {(billing.providers?.payple || billing.paymentMethod || !billing.canManage) && !billing.paypal && <section className="billing-payment-section"><header><div><h3>{t("결제수단과 자동 갱신")}</h3></div>{billing.paymentMethod && <div className="billing-card-chip"><CreditCard size={17} /><span><b>{billing.paymentMethod.cardCompany || t("등록 카드")}</b><small>{billing.paymentMethod.maskedCard}</small></span></div>}</header>
      {!billing.canManage ? <p className="billing-member-note">{t("현재 플랜과 사용량은 모든 멤버가 볼 수 있습니다. 카드·플랜·환불 관리는 워크스페이스 Owner에게 요청해 주세요.")}</p>
        : !billing.paymentMethod ? <div className="billing-checkout"><div className="billing-checkout-summary" aria-live="polite"><span>{t("선택됨")}</span><b>{plans.find((plan) => plan.id === selectedPlan)?.label}</b><p>{t("{value1} × {count}명 = {value2}/월", { value1: messageValue(formatWon(plans.find((plan) => plan.id === selectedPlan)?.seatPrice ?? 2_900)), count: billing.billableEditors, value2: messageValue(formatWon((plans.find((plan) => plan.id === selectedPlan)?.seatPrice ?? 2_900) * billing.billableEditors)) })}</p></div><label aria-label={t("체험 및 자동 갱신 조건 동의")} className="billing-contract"><input type="checkbox" checked={contractAccepted} onChange={(event) => setContractAccepted(event.target.checked)} /><span><b>{t("30일 체험 및 자동 갱신 조건에 동의합니다.")}</b><small>{t("오늘은 결제되지 않습니다. 체험 종료일과 이후 매 결제일에 Owner·Admin·Member 수 × 1인당 요금으로 결제합니다. Viewer와 초대 대기자는 무료이며 VAT가 포함됩니다.")}</small></span></label><button type="button" onClick={() => void startCheckout()} disabled={!contractAccepted || Boolean(working)}>{working === "checkout" ? t("카드 등록 중") : t("국내 카드 등록하고 30일 체험")}</button></div>
        : <div className="billing-owner-actions">{billing.plan !== "free" && <button type="button" onClick={() => void cancel()} disabled={Boolean(working) || billing.cancelAtPeriodEnd}>{billing.cancelAtPeriodEnd ? t("해지 예약됨") : working === "cancel" ? t("해지 중") : t("구독 해지")}</button>}<button type="button" onClick={() => void refund()} disabled={Boolean(working)}>{working === "refund" ? t("환불 처리 중") : t("첫 결제 환불 확인")}</button></div>}
    </section>}

    {billing.canManage && !billing.paymentMethod && (billing.providers?.paypal.length || billing.paypal) ? <section className="billing-paypal-section">
      <header><div><h3>{t("PayPal 결제")}</h3></div><a href="https://www.paypal.com/myaccount/autopay/" target="_blank" rel="noreferrer">{t("PayPal에서 관리")}<ExternalLink size={15} aria-hidden="true" /></a></header>
      <p>{t("한국 외 지역의 PayPal 계정으로 결제할 수 있습니다. 결제 통화와 금액을 확인해 주세요.")}</p>
      {billing.paypal ? <div className="billing-paypal-current"><b>{billing.paypal.plan === "team" ? "Team" : "Business"} · {formatMoney(String(Number(billing.paypal.value) * billing.paypal.seatCount), billing.paypal.currency)}{t("/ 월")} · {t("{count}명", { count: billing.paypal.seatCount })}</b>
        {billing.paypal.seatCount !== billing.billableEditors && <p className="billing-payment-notice">{t("PayPal 결제 인원은 {value1}명입니다. 현재 편집 멤버 {value2}명에 맞춰 다음 결제 금액을 승인해 주세요.", { value1: messageValue(billing.paypal.seatCount), value2: messageValue(billing.billableEditors) })}</p>}
        <div className="billing-owner-actions"><button className="secondary" type="button" onClick={() => void syncPayPal()} disabled={Boolean(working)}><RefreshCw size={16} aria-hidden="true" />{t("결제 상태 확인")}</button>
          {billing.paypal.seatCount !== billing.billableEditors && <button className="secondary" type="button" onClick={() => void revisePayPalEditors()} disabled={Boolean(working)}>{t("PayPal 결제 인원 변경")}</button>}
          <button className="secondary" type="button" onClick={() => void cancel()} disabled={Boolean(working) || billing.cancelAtPeriodEnd}>{billing.cancelAtPeriodEnd ? t("해지 예약됨") : t("구독 해지")}</button>
          {billing.paypal.paidThrough && <button className="secondary" type="button" onClick={() => void refund()} disabled={Boolean(working)}>{t("첫 결제 환불 확인")}</button>}
        </div>
      </div> : null}
      {(!billing.paypal || ["CREATING", "APPROVAL_PENDING"].includes(billing.paypal.status)) && <div className="billing-checkout billing-paypal-checkout">
        <div>{billing.providers?.paypal.map((price) => <label key={price.plan}><input type="radio" name="paypal-plan" value={price.plan} checked={selectedPlan === price.plan}
          disabled={Boolean(billing.paypal && billing.paypal.plan !== price.plan) || Boolean(working)} onChange={() => { setSelectedPlan(price.plan); setPaypalAccepted(false); }} />
          {price.plan === "team" ? "Team" : "Business"} · {formatMoney(price.value, price.currency)} × {t("{count}명", { count: billing.billableEditors })} = {formatMoney(String(Number(price.value) * billing.billableEditors), price.currency)}{t("/ 월")}</label>)}</div>
        <label className="billing-contract" aria-label={t("표시된 월 요금과 자동 갱신에 동의합니다.")}><input type="checkbox" checked={paypalAccepted} disabled={Boolean(working)} onChange={(event) => setPaypalAccepted(event.target.checked)} />
          <span><b>{t("표시된 월 요금과 자동 갱신에 동의합니다.")}</b><small>{t("PayPal에서 승인한 편집 멤버 수와 1인당 요금으로 첫 결제가 진행되고 매월 자동 갱신됩니다.")}</small></span></label>
        <button className="primary-action" type="button" onClick={() => void startPayPal()} disabled={!paypalAccepted || Boolean(working)} aria-busy={working === "checkout"}>
          <CreditCard size={17} aria-hidden="true" />{working === "checkout" ? t("결제 연결 중") : t("PayPal로 결제")}</button>
      </div>}
    </section> : null}

    <section className="billing-history"><header><div><h3>{t("결제 기록")}</h3></div><p>{t("계약·결제·해지 기록은 관련 법령에 따라 5년간 보관합니다.")}</p></header>{billing.transactions.length || billing.paypalTransactions?.length ? <div>{billing.transactions.map((transaction) => <article key={transaction.id}><div><b>{plans.find((plan) => plan.id === transaction.plan)?.label || transaction.plan} · {transactionLabel(transaction.kind)}</b><small>{formatDateTime(transaction.createdAt)}</small></div><strong>{transaction.priceWon.toLocaleString(getClientLocale())}{t("원")}</strong><span>{transactionStatusLabel(transaction.status)}</span>{transaction.receiptUrl ? <a href={transaction.receiptUrl} target="_blank" rel="noreferrer">{t("영수증")}</a> : <em>{t("영수증 없음")}</em>}</article>)}
      {billing.paypalTransactions?.map((transaction) => <article key={transaction.id}><div><b>{transaction.plan === "team" ? "Team" : "Business"} · PayPal</b><small>{formatDateTime(transaction.createdAt)}</small></div><strong>{formatMoney(transaction.value, transaction.currency)}</strong><span>{transactionStatusLabel(transaction.status === "COMPLETED" ? "paid" : transaction.status === "REFUNDED" ? "refunded" : "unknown")}</span><a href="https://www.paypal.com/myaccount/activity/" target="_blank" rel="noreferrer">{t("영수증")}</a></article>)}
    </div> : <p className="billing-empty-history">{t("아직 결제 기록이 없습니다.")}</p>}</section>
  </section>;
}

function ProjectUsage({ billing }: { billing: BillingStatusData }) {
  const usage = billing.usage.projects;
  const percentage = usage.limit === null ? 0 : Math.min(100, Math.round((usage.used / usage.limit) * 100));
  return <article className={percentage >= 100 ? "limit" : percentage >= 80 ? "warning" : ""}><header><span>{t("이번 달 Project")}</span><b>{usage.limit === null ? t("무제한") : <>{usage.used}<small> / {usage.limit}</small></>}</b></header>{usage.limit !== null && <div role="progressbar" aria-label={t("Project 생성 사용량")} aria-valuemin={0} aria-valuemax={usage.limit} aria-valuenow={Math.min(usage.used, usage.limit)}><i style={{ width: `${percentage}%` }} /></div>}<p>{usage.limit === null ? t("Project를 제한 없이 만들 수 있습니다.") : t("다음 달에 다시 30개를 만들 수 있습니다.")}</p></article>;
}

function StorageUsage({ storage }: { storage: BillingStatusData["usage"]["storage"] }) {
  const percentage = storage.limitBytes > 0 ? Math.min(100, Math.round((storage.usedBytes / storage.limitBytes) * 100)) : 0;
  return <article className={percentage >= 100 ? "limit" : percentage >= 80 ? "warning" : ""}><header><span>{t("이미지 저장 공간")}</span><b>{formatBytes(storage.usedBytes)}<small> / {formatBytes(storage.limitBytes)}</small></b></header><div role="progressbar" aria-label={t("이미지 저장 공간 사용량")} aria-valuemin={0} aria-valuemax={storage.limitBytes} aria-valuenow={Math.min(storage.usedBytes, storage.limitBytes)} aria-valuetext={t("{value1} 중 {value2} 사용", { value1: messageValue(formatBytes(storage.limitBytes)), value2: messageValue(formatBytes(storage.usedBytes)) })}><i style={{ width: `${percentage}%` }} /></div><p>{t("워크스페이스에 저장된 작업 이미지 기준")}</p></article>;
}

function BillingSeats({ billing }: { billing: BillingStatusData }) {
  const limit = billing.usage.editors.limit;
  const percentage = limit === null ? 0 : Math.min(100, Math.round((billing.billableEditors / limit) * 100));
  const detail = billing.plan === "free"
    ? t("{count}명까지 무료", { count: limit ?? 5 })
    : t("{value1} × {count}명 = {value2}/월", { value1: messageValue(formatWon(billing.seatPriceWon)), count: billing.billableEditors, value2: messageValue(formatWon(billing.monthlyPriceWon)) });
  return <article className={percentage >= 100 ? "limit" : percentage >= 80 ? "warning" : ""}><header><span>{t("편집 멤버")}</span><b>{t("{count}명", { count: billing.billableEditors })}{limit !== null && <small> / {t("{count}명", { count: limit })}</small>}</b></header>{limit !== null && <div role="progressbar" aria-label={t("편집 멤버 사용량")} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={billing.billableEditors}><i style={{ width: `${percentage}%` }} /></div>}<p>{detail}</p></article>;
}

function formatWon(value: number) {
  return `${value.toLocaleString(getClientLocale())}${t("원")}`;
}

function formatBytes(value: number) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1024 ** 3) return `${new Intl.NumberFormat(getClientLocale(), { maximumFractionDigits: 1 }).format(bytes / 1024 ** 3)}GB`;
  return `${new Intl.NumberFormat(getClientLocale(), { maximumFractionDigits: 1 }).format(bytes / 1024 ** 2)}MB`;
}

function statusLabel(status: BillingStatusData["status"]) {
  return t({ free: "무료 사용 중", trialing: "30일 체험 중", active: "정기결제 이용 중", past_due: "결제 재시도 중", cancel_at_period_end: "해지 예약", canceled: "종료됨" }[status]);
}

function formatMoney(value: string, currency: string) {
  return new Intl.NumberFormat(getClientLocale(), { style: "currency", currency, currencyDisplay: "code" }).format(Number(value));
}

function paymentError(data: { code?: string }) {
  if (data.code === "billing_price_changed") return t("요금이 변경되었습니다. 화면을 새로고침한 뒤 확인해 주세요.");
  if (data.code === "billing_busy") return t("이전 결제를 처리 중입니다. 잠시 후 다시 확인해 주세요.");
  if (data.code === "billing_existing_subscription") return t("진행 중인 구독을 먼저 확인해 주세요. 중복 결제는 진행하지 않습니다.");
  if (data.code === "billing_refund_ineligible") return t("첫 결제 후 7일 이내이며 Project 생성과 AI 사용이 없는 경우에 환불할 수 있습니다.");
  if (data.code === "billing_refund_pending") return t("환불 결과를 확인 중입니다. 결제 기록을 다시 확인해 주세요.");
  return t("결제를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
}

function transactionLabel(kind: string) {
  const label = ({ charge: "정기결제", prorated_upgrade: "플랜 상향", refund: "환불" } as Record<string, string>)[kind];
  return label ? t(label) : kind;
}

function transactionStatusLabel(status: string) {
  return status === "paid" ? t("결제 완료") : status === "refunded" ? t("환불 완료") : t("확인 필요");
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(getClientLocale(), { timeZone: "Asia/Seoul", year: "numeric", month: "short", day: "numeric" }).format(new Date(value));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(getClientLocale(), { timeZone: "Asia/Seoul", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function loadExternalScript(url: string) {
  return new Promise<void>((resolve, reject) => {
    const existing = Array.from(document.scripts).find((script) => script.src === new URL(url, window.location.href).toString()) as HTMLScriptElement | undefined;
    if (existing?.dataset.loaded === "true") return resolve();
    const script = existing ?? document.createElement("script");
    script.src = url;
    script.async = true;
    script.onload = () => { script.dataset.loaded = "true"; resolve(); };
    script.onerror = () => reject(new Error(t("Payple 모듈을 불러오지 못했습니다.")));
    if (!existing) document.head.appendChild(script);
  });
}
