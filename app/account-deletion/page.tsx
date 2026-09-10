import type { Metadata } from "next";
import Link from "next/link";
import { BrandLogo } from "@/app/brand-logo";

export const metadata: Metadata = {
  title: "Delete your OKRI account",
  description: "Delete an OKRI account and its personal data.",
};

const languageNames = { ko: "한국어", en: "English", ja: "日本語", zh: "中文", es: "Español" } as const;
type Language = keyof typeof languageNames;
type Copy = {
  title: string; updated: string; intro: string; appTitle: string; appSteps: string[];
  webTitle: string; webBody: string; authenticate: string; warning: string; understood: string;
  delete: string; deleted: string; retainedTitle: string; retained: string; support: string;
  errors: Record<string, string>;
};
const copies: Record<Language, Copy> = {
  ko: {
    title: "OKRI 계정 삭제", updated: "마지막 업데이트: 2026년 9월 10일", intro: "앱에서 직접 삭제하거나 이 페이지에서 Google 계정을 다시 확인한 뒤 삭제할 수 있습니다.",
    appTitle: "앱에서 삭제", appSteps: ["OKRI 앱에서 로그인합니다.", "더보기 > 설정 > 계정 삭제를 선택합니다.", "안내를 확인하고 영구 삭제를 선택합니다."],
    webTitle: "웹에서 삭제", webBody: "삭제할 OKRI 계정과 같은 Google 계정으로 다시 인증합니다. 인증 후 마지막 확인 화면이 열립니다.", authenticate: "Google로 본인 확인",
    warning: "개인 워크스페이스, Task, Routine, 인증 세션과 연동 토큰이 영구 삭제됩니다. 이 작업은 되돌릴 수 없습니다.", understood: "영구 삭제와 복구 불가를 이해했습니다.", delete: "계정 영구 삭제", deleted: "계정 삭제가 완료되었습니다.",
    retainedTitle: "삭제 후 보관되는 정보", retained: "다른 팀원이 있는 공유 워크스페이스의 팀 자료는 유지되며 회원 정보는 비활성 처리됩니다. 법령상 보존 의무가 있는 결제·환불 기록은 정해진 기간 동안 분리 보관됩니다.", support: "삭제에 문제가 있으면 문의해 주세요.",
    errors: { reauth: "보호를 위해 Google로 다시 인증해 주세요.", confirmation: "삭제 동의를 확인해 주세요.", ownership: "공유 워크스페이스 소유권을 다른 팀원에게 먼저 이전해 주세요.", unavailable: "삭제를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.", invalid_request: "안전하지 않은 요청을 차단했습니다. 이 페이지에서 다시 시도해 주세요." },
  },
  en: {
    title: "Delete your OKRI account", updated: "Last updated: September 10, 2026", intro: "Delete your account directly in the app, or verify your Google account and delete it here.",
    appTitle: "Delete in the app", appSteps: ["Sign in to the OKRI app.", "Choose More > Settings > Delete account.", "Review the notice and choose Delete permanently."],
    webTitle: "Delete on the web", webBody: "Verify with the same Google account you use for OKRI. You will return here for one final confirmation.", authenticate: "Verify with Google",
    warning: "Your personal workspace, tasks, routines, authentication sessions and integration tokens will be permanently deleted. This cannot be undone.", understood: "I understand that deletion is permanent and cannot be undone.", delete: "Delete account permanently", deleted: "Your account has been deleted.",
    retainedTitle: "Data retained after deletion", retained: "Team content in shared workspaces with other members remains available, while your membership is deactivated. Payment and refund records required by law are retained separately for the required period.", support: "Contact us if you cannot complete deletion.",
    errors: { reauth: "For your protection, verify with Google again.", confirmation: "Confirm that you understand permanent deletion.", ownership: "Transfer ownership of shared workspaces to another member first.", unavailable: "We could not complete deletion. Please try again shortly.", invalid_request: "We blocked an unsafe request. Please try again from this page." },
  },
  ja: {
    title: "OKRIアカウントの削除", updated: "最終更新日: 2026年9月10日", intro: "アプリから直接削除するか、このページでGoogleアカウントを再確認して削除できます。",
    appTitle: "アプリで削除", appSteps: ["OKRIアプリにログインします。", "その他 > 設定 > アカウントを削除を選択します。", "案内を確認し、完全に削除を選択します。"],
    webTitle: "ウェブで削除", webBody: "OKRIで使用しているGoogleアカウントで再認証します。認証後、最後の確認画面に戻ります。", authenticate: "Googleで本人確認",
    warning: "個人ワークスペース、タスク、ルーティン、認証セッション、連携トークンは完全に削除され、元に戻せません。", understood: "完全な削除は元に戻せないことを理解しました。", delete: "アカウントを完全に削除", deleted: "アカウントを削除しました。",
    retainedTitle: "削除後に保持される情報", retained: "他のメンバーがいる共有ワークスペースのチーム資料は保持され、メンバー情報は無効化されます。法令で保存が必要な決済・返金記録は所定の期間、分離して保管されます。", support: "削除できない場合はお問い合わせください。",
    errors: { reauth: "保護のためGoogleで再認証してください。", confirmation: "完全な削除への同意を確認してください。", ownership: "共有ワークスペースの所有権を先に他のメンバーへ移譲してください。", unavailable: "削除を完了できませんでした。しばらくしてから再度お試しください。", invalid_request: "安全でないリクエストを遮断しました。このページから再度お試しください。" },
  },
  zh: {
    title: "删除 OKRI 账户", updated: "最后更新：2026年9月10日", intro: "你可以直接在应用中删除，也可以在此重新验证 Google 账户后删除。",
    appTitle: "在应用中删除", appSteps: ["登录 OKRI 应用。", "选择更多 > 设置 > 删除账户。", "阅读提示并选择永久删除。"],
    webTitle: "在网页上删除", webBody: "请使用与 OKRI 相同的 Google 账户重新验证。验证后将返回此页面进行最后确认。", authenticate: "使用 Google 验证",
    warning: "你的个人工作区、任务、例行工作、认证会话和集成令牌将被永久删除，且无法恢复。", understood: "我了解删除是永久的且无法恢复。", delete: "永久删除账户", deleted: "你的账户已删除。",
    retainedTitle: "删除后保留的数据", retained: "仍有其他成员的共享工作区团队内容将被保留，你的成员身份会停用。法律要求保存的付款与退款记录将在规定期限内单独保存。", support: "如果无法完成删除，请联系我们。",
    errors: { reauth: "为保护账户，请再次使用 Google 验证。", confirmation: "请确认你了解永久删除。", ownership: "请先将共享工作区所有权转移给其他成员。", unavailable: "无法完成删除，请稍后重试。", invalid_request: "已阻止不安全的请求，请从此页面重试。" },
  },
  es: {
    title: "Eliminar tu cuenta de OKRI", updated: "Última actualización: 10 de septiembre de 2026", intro: "Elimina tu cuenta directamente en la app o verifica tu cuenta de Google y elimínala aquí.",
    appTitle: "Eliminar en la app", appSteps: ["Inicia sesión en la app de OKRI.", "Elige Más > Ajustes > Eliminar cuenta.", "Revisa el aviso y elige Eliminar permanentemente."],
    webTitle: "Eliminar en la web", webBody: "Verifica la misma cuenta de Google que utilizas en OKRI. Volverás aquí para una última confirmación.", authenticate: "Verificar con Google",
    warning: "Tu espacio personal, tareas, rutinas, sesiones de autenticación y tokens de integración se eliminarán de forma permanente. Esta acción no se puede deshacer.", understood: "Entiendo que la eliminación es permanente y no se puede deshacer.", delete: "Eliminar cuenta permanentemente", deleted: "Tu cuenta se ha eliminado.",
    retainedTitle: "Datos conservados tras la eliminación", retained: "El contenido del equipo en espacios compartidos con otros miembros se conserva y tu membresía se desactiva. Los registros de pagos y reembolsos exigidos por ley se conservan por separado durante el periodo obligatorio.", support: "Contacta con nosotros si no puedes completar la eliminación.",
    errors: { reauth: "Por tu seguridad, vuelve a verificarte con Google.", confirmation: "Confirma que entiendes la eliminación permanente.", ownership: "Primero transfiere la propiedad de los espacios compartidos a otro miembro.", unavailable: "No pudimos completar la eliminación. Inténtalo de nuevo en breve.", invalid_request: "Bloqueamos una solicitud no segura. Vuelve a intentarlo desde esta página." },
  },
};

export default async function AccountDeletionPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const rawLanguage = typeof params?.lang === "string" ? params.lang : "en";
  const language: Language = rawLanguage in copies ? rawLanguage as Language : "en";
  const copy = copies[language];
  const reauthenticated = params?.reauth === "1";
  const deleted = params?.deleted === "1";
  const error = typeof params?.error === "string" ? copy.errors[params.error] : "";
  const returnTo = `/account-deletion?lang=${language}&reauth=1`;
  return <main className="legal-page"><article lang={language}>
    <header><Link href="/" aria-label="OKRI home"><BrandLogo /></Link><h1>{copy.title}</h1><p>{copy.updated}</p></header>
    <nav className="legal-language-nav" aria-label="Language">{Object.entries(languageNames).map(([id, name]) => <Link key={id} href={`/account-deletion?lang=${id}`} aria-current={id === language ? "page" : undefined}>{name}</Link>)}</nav>
    {deleted ? <section className="deletion-complete" role="status"><h2>{copy.deleted}</h2><p><Link href="/">OKRI</Link></p></section> : <>
      <section><p>{copy.intro}</p></section>
      <section><h2>{copy.appTitle}</h2><ol>{copy.appSteps.map((step) => <li key={step}>{step}</li>)}</ol></section>
      <section><h2>{copy.webTitle}</h2><p>{copy.webBody}</p>{error && <p className="deletion-error" role="alert">{error}</p>}
        {reauthenticated ? <form className="deletion-form" action="/api/account/deletion" method="post">
          <p>{copy.warning}</p><label><input type="checkbox" name="understood" value="yes" required /><span>{copy.understood}</span></label>
          <input type="hidden" name="confirmation" value="DELETE" /><input type="hidden" name="language" value={language} />
          <button type="submit">{copy.delete}</button>
        </form> : <a className="legal-primary-action" href={`/api/auth/google?returnTo=${encodeURIComponent(returnTo)}`}>{copy.authenticate}</a>}
      </section>
      <section><h2>{copy.retainedTitle}</h2><p>{copy.retained}</p></section>
      <section><h2>{copy.support}</h2><p><a href="mailto:taehong0613@gmail.com">taehong0613@gmail.com</a></p></section>
    </>}
    <footer><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><Link href="/">OKRI</Link></footer>
  </article></main>;
}
