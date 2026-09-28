import { themeCss, isThemeMode } from "./themes";
import { PAYPLE_BRIDGE_PATH } from "./payple-bridge";

const copy = {
  ko: ["카드 등록", "OKRI 월 구독", "카드 등록하기", "OKRI로 돌아가기", "카드 등록을 확인하지 못했습니다. OKRI로 돌아가 다시 시도해 주세요.", "카드 인증 후 OKRI에서 등록을 완료합니다.", "등록 확인 중", "월 예상 요금"],
  en: ["Register a card", "OKRI monthly subscription", "Register card", "Return to OKRI", "Card registration could not be confirmed. Return to OKRI and try again.", "After card verification, complete registration in OKRI.", "Confirming registration", "Estimated monthly price"],
  ja: ["カード登録", "OKRI月額サブスクリプション", "カードを登録", "OKRIに戻る", "カード登録を確認できませんでした。OKRIに戻って再度お試しください。", "カード認証後、OKRIで登録を完了します。", "登録を確認中", "月額料金の見積もり"],
  zh: ["注册银行卡", "OKRI月度订阅", "注册银行卡", "返回OKRI", "无法确认银行卡注册。请返回OKRI后重试。", "银行卡验证后，请在OKRI完成注册。", "正在确认注册", "预计月费"],
  es: ["Registrar tarjeta", "Suscripción mensual de OKRI", "Registrar tarjeta", "Volver a OKRI", "No se pudo confirmar el registro. Vuelve a OKRI e inténtalo de nuevo.", "Tras verificar la tarjeta, completa el registro en OKRI.", "Confirmando registro", "Precio mensual estimado"],
};

const consentCopy = {
  ko: ["오늘 결제", "표시된 오늘 결제 금액과 월 요금, 편집 인원에 따른 자동 갱신에 동의합니다. 무료 체험은 최초 1회만 제공됩니다."],
  en: ["Due today", "I agree to the displayed payment today and monthly renewal based on the number of editors. The free trial is available once."],
  ja: ["本日の支払額", "表示された本日の支払額と編集者数に応じた月額自動更新に同意します。無料体験は初回のみです。"],
  zh: ["今日应付", "我同意显示的今日付款金额及按编辑人数计算的每月自动续费。免费试用仅限首次。"],
  es: ["Pago de hoy", "Acepto el pago indicado para hoy y la renovación mensual según el número de editores. La prueba gratuita se ofrece una sola vez."],
};

export function renderPaypleBridge(url: URL) {
  const langKey = (url.searchParams.get("lang") || "en").split("-")[0];
  const lang = Object.hasOwn(copy, langKey) ? langKey as keyof typeof copy : "en";
  const c = copy[lang];
  const theme = isThemeMode(url.searchParams.get("theme")) ? url.searchParams.get("theme")! : "white";
  const nonce = crypto.randomUUID();
  return new Response(`<!doctype html><html lang="${lang}" data-theme="${theme}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>OKRI | ${c[0]}</title>
<link rel="stylesheet" href="${PAYPLE_BRIDGE_PATH}/fonts/pretendardvariable-dynamic-subset.css">
<style nonce="${nonce}">${themeCss}
*{box-sizing:border-box;letter-spacing:0}html{font-size:100%}body{margin:0;background:var(--bg-page);color:var(--text-primary);font:1rem/1.6 'Pretendard Variable',sans-serif}
main{max-width:32rem;margin:2rem auto;padding:1rem;overflow-wrap:anywhere}h1{font-size:1.25rem;line-height:1.3}p{color:var(--text-secondary)}
label{display:flex;align-items:flex-start;gap:.75rem;min-height:2.75rem}input[type=checkbox]{width:1.125rem;height:1.125rem;margin:.25rem 0;flex-shrink:0;accent-color:var(--button-primary-bg)}
button,a{min-height:2.75rem;display:inline-flex;align-items:center;padding:.5rem 1rem;font:inherit;border-radius:.25rem}
button{border:0;background:var(--button-primary-bg);color:var(--button-primary-fg);cursor:pointer}button:disabled{background:var(--button-disabled-bg);color:var(--button-disabled-fg);cursor:default}
a{color:var(--text-link)}:focus-visible{outline:2px solid var(--focus-ring);outline-offset:3px}#status{min-height:3.2em}section{border-block:1px solid var(--border-default);padding:1rem 0;margin-block:1.5rem}
</style></head><body><main><a href="https://okri.ai/" aria-label="OKRI">OKRI</a><h1>${c[0]}</h1>
<section><strong>${c[1]}</strong><p id="price">${c[7]}</p><p id="today"></p></section><p>${c[5]}</p>
<p><label><input id="consent" type="checkbox"> ${consentCopy[lang][1]}</label></p>
<button id="register" disabled>${c[2]}</button><a href="https://okri.ai/?view=billing">${c[3]}</a>
<p id="status" role="status" aria-live="polite"></p></main>
<script nonce="${nonce}">
(async () => {
const token=decodeURIComponent(location.hash.slice(1));history.replaceState(null,'',location.pathname+location.search);
const button=document.getElementById('register'),status=document.getElementById('status');
const error=${JSON.stringify(c[4])};
async function post(path,body){const response=await fetch('${PAYPLE_BRIDGE_PATH}/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw Error(error);return response.json();}
function load(src){return new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=reject;document.head.append(script);});}
try{
const session=await post('session',{sessionToken:token});
if(!['https://cpay.payple.kr/js/v1/payment.js','https://democpay.payple.kr/js/v1/payment.js'].includes(session.authUrl))throw Error(error);
document.getElementById('price').textContent=${JSON.stringify(c[7])}+' · '+new Intl.NumberFormat('${lang}',{style:'currency',currency:'KRW'}).format(session.priceWon);
document.getElementById('today').textContent=${JSON.stringify(consentCopy[lang][0])}+' · '+new Intl.NumberFormat('${lang}',{style:'currency',currency:'KRW'}).format(session.firstPaymentWon);
await load('https://ajax.googleapis.com/ajax/libs/jquery/3.7.1/jquery.min.js');await load(session.authUrl);
const consent=document.getElementById('consent');consent.onchange=()=>{button.disabled=!consent.checked;};button.disabled=!consent.checked;
button.onclick=()=>{if(!consent.checked)return;button.disabled=true;status.textContent='';try{window.PaypleCpayAuthCheck({clientKey:session.clientKey,PCD_PAY_TYPE:'card',PCD_PAY_WORK:'AUTH',PCD_CARD_VER:'01',PCD_PAY_GOODS:'OKRI '+session.plan+' monthly subscription',PCD_RST_URL:'${PAYPLE_BRIDGE_PATH}/result',callbackFunction:async result=>{
if(result.PCD_PAY_RST==='close'){button.disabled=!consent.checked;return;}status.textContent=${JSON.stringify(c[6])};
try{const data=await post('result',{sessionToken:token,result,accepted:consent.checked,firstPaymentWon:session.firstPaymentWon,priceWon:session.priceWon});const target=new URL(data.returnUrl);if(target.origin!=='https://okri.ai'||target.pathname!=='/')throw Error(error);location.replace(target.href);}
catch{status.textContent=error;button.disabled=!consent.checked;}
}});}catch{status.textContent=error;button.disabled=!consent.checked;}};
}catch{status.textContent=error;}
})();</script></body></html>`, { headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "strict-origin",
    "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": `default-src 'self'; script-src 'self' 'nonce-${nonce}' https://cpay.payple.kr https://democpay.payple.kr https://ajax.googleapis.com; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-src https://cpay.payple.kr https://democpay.payple.kr https://hub.payple.kr; connect-src 'self' https://cpay.payple.kr https://democpay.payple.kr; img-src 'self' data: https://cpay.payple.kr https://democpay.payple.kr; base-uri 'none'; frame-ancestors 'none'`,
  } });
}
