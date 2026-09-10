import en from "../../lib/locales/en";
import ja from "../../lib/locales/ja";
import zh from "../../lib/locales/zh";
import es from "../../lib/locales/es";
import { translateMessage, type LocalizedMessage } from "../../lib/language";

export type Language = "ko" | "en" | "ja" | "zh" | "es";
export const languages: { id: Language; name: string }[] = [
  { id: "ko", name: "한국어" }, { id: "en", name: "English" }, { id: "ja", name: "日本語" },
  { id: "zh", name: "中文" }, { id: "es", name: "Español" },
];
const extra: Record<string, [string, string, string, string]> = {
  "앱 업데이트": ["App updates", "アプリの更新", "应用更新", "Actualizaciones de la app"],
  "받은 업데이트는 앱을 다음에 실행할 때 적용됩니다.": ["Downloaded updates apply the next time you start the app.", "ダウンロードした更新は次回の起動時に適用されます。", "已下载的更新将在下次启动应用时生效。", "Las actualizaciones descargadas se aplican al volver a iniciar la app."],
  "이 버전의 지원 기간이 끝났습니다. 스토어에서 업데이트해 주세요.": ["Support for this version has ended. Update from the store.", "このバージョンのサポートは終了しました。ストアから更新してください。", "此版本已停止支持，请从应用商店更新。", "Esta versión ya no tiene soporte. Actualízala desde la tienda."],
  "새 버전을 사용할 수 있습니다.": ["A new version is available.", "新しいバージョンを利用できます。", "有新版本可用。", "Hay una nueva versión disponible."],
  "스토어에서 업데이트": ["Update in store", "ストアで更新", "在应用商店更新", "Actualizar en la tienda"],
  "업데이트 다시 확인": ["Check for updates again", "更新を再確認", "重新检查更新", "Volver a buscar actualizaciones"],
  "업데이트가 있어도 작성 중인 화면은 다시 시작하지 않습니다.": ["Updates will not restart a screen while you are working.", "更新があっても作業中の画面は再起動しません。", "更新不会重新启动正在编辑的页面。", "Las actualizaciones no reinician la pantalla mientras trabajas."],
  "스토어를 열지 못했습니다. 잠시 후 다시 시도해 주세요.": ["Could not open the store. Try again shortly.", "ストアを開けませんでした。しばらくして再度お試しください。", "无法打开应用商店，请稍后重试。", "No se pudo abrir la tienda. Inténtalo de nuevo más tarde."],
  "상위 항목을 선택해 주세요.": ["Select a parent item.", "親項目を選択してください。", "请选择上级项目。", "Selecciona un elemento superior."],
  "하위 항목 추가": ["Add child item", "子項目を追加", "添加子项", "Añadir elemento hijo"],
  "Objective 추가": ["Add objective", "目標を追加", "添加目标", "Añadir objetivo"],
  "이용약관": ["Terms of service", "利用規約", "服务条款", "Términos de servicio"],
  "개인정보 처리방침": ["Privacy policy", "プライバシーポリシー", "隐私政策", "Política de privacidad"],
  "업무 편집": ["Edit work", "業務を編集", "编辑工作", "Editar trabajo"],
  "제출했습니다.": ["Submitted.", "提出しました。", "已提交。", "Enviado."],
  "저장했습니다.": ["Saved.", "保存しました。", "已保存。", "Guardado."],
  "일반 업무": ["Unassigned work", "未分類の業務", "未分类工作", "Trabajo sin proyecto"],
  "Task 제목": ["Task title", "タスク名", "任务名称", "Título de la tarea"],
  "어제 한 일": ["Yesterday's work", "昨日の業務", "昨天的工作", "Trabajo de ayer"],
  "오늘 계획된 업무 없음": ["No work planned today", "今日の予定はありません", "今天没有计划工作", "Sin trabajo previsto para hoy"],
  "오늘 할 일 메모": ["Notes for today", "今日のメモ", "今日备注", "Notas para hoy"],
  "임시 저장": ["Save draft", "下書きを保存", "保存草稿", "Guardar borrador"],
  "항목을 찾을 수 없습니다.": ["Item not found.", "項目が見つかりません。", "未找到项目。", "No se encontró el elemento."],
  "상위 항목": ["Parent", "親項目", "上级项目", "Elemento superior"],
  "버리기": ["Discard", "破棄", "放弃", "Descartar"],
  "기한 제거": ["Clear due date", "期限を解除", "清除截止日期", "Quitar fecha límite"],
  "반복": ["Recurrence", "繰り返し", "重复周期", "Repetición"],
  "30일": ["30 days", "30日", "30天", "30 días"],
  "Project가 없습니다.": ["No projects yet.", "プロジェクトはまだありません。", "暂无项目。", "Aún no hay proyectos."],
  "등록된 Objective가 없습니다.": ["No objectives yet.", "目標はまだありません。", "暂无目标。", "Aún no hay objetivos."],
  "이용 안내": ["Guide", "ご利用ガイド", "使用指南", "Guía"],
  "로그아웃": ["Sign out", "ログアウト", "退出登录", "Cerrar sesión"],
  "Project 만들기": ["Create project", "プロジェクトを作成", "创建项目", "Crear proyecto"],
  "계정을 삭제할까요?": ["Delete your account?", "アカウントを削除しますか？", "删除账户？", "¿Eliminar tu cuenta?"],
  "계정 삭제": ["Delete account", "アカウントを削除", "删除账户", "Eliminar cuenta"],
  "개인 워크스페이스와 계정을 영구 삭제합니다. 공유 워크스페이스의 자료는 팀에 남습니다.": ["Your account and personal workspace will be permanently deleted. Shared workspace content remains with your team.", "アカウントと個人ワークスペースを完全に削除します。共有資料はチームに残ります。", "账户和个人工作区将被永久删除。共享工作区的内容将为团队保留。", "Tu cuenta y espacio personal se eliminarán permanentemente. El contenido compartido permanece en tu equipo."],
  "계정을 삭제하려면 로그아웃 후 다시 로그인해 주세요.": ["Sign out and sign in again before deleting your account.", "削除する前にログアウトして、再度ログインしてください。", "删除账户前，请退出并重新登录。", "Cierra sesión e inicia sesión de nuevo antes de eliminar tu cuenta."],
  "공유 워크스페이스의 소유권을 먼저 이전해 주세요.": ["Transfer ownership of shared workspaces first.", "先に共有ワークスペースの所有権を移譲してください。", "请先转移共享工作区的所有权。", "Primero transfiere la propiedad de tus espacios compartidos."],
  "삭제하지 못했습니다. 다시 시도해 주세요.": ["Could not delete. Please retry.", "削除できませんでした。再度お試しください。", "删除失败，请重试。", "No se pudo eliminar. Inténtalo de nuevo."],
  "목표와 실행, 한곳에서.": ["Goals and work, together.", "目標と実行を、ひとつに。", "目标与行动，尽在一处。", "Objetivos y trabajo, juntos."],
  "기존 OKRI 계정으로 로그인": ["Sign in to your OKRI account", "OKRIアカウントでログイン", "登录 OKRI 账户", "Inicia sesión en OKRI"],
  "연결을 확인하고 다시 시도해 주세요.": ["Check your connection and try again.", "接続を確認して、もう一度お試しください。", "请检查连接后重试。", "Comprueba la conexión e inténtalo de nuevo."],
  "저장한 내용은 유지됩니다.": ["Your changes are kept.", "入力内容は保持されます。", "输入的内容将保留。", "Se conservan tus cambios."],
  "변경사항을 버릴까요?": ["Discard changes?", "変更を破棄しますか？", "放弃更改？", "¿Descartar los cambios?"],
  "오늘과 마감일 기준": ["Today to due date", "今日と期限を基準に表示", "以今天和截止日期为准", "Desde hoy hasta el vencimiento"],
  "계정 삭제 요청": ["Request account deletion", "アカウント削除を申請", "申请删除账户", "Solicitar eliminación de cuenta"],
  "계정과 개인정보의 삭제를 요청합니다. 공유 워크스페이스의 팀 자료는 다른 멤버를 위해 유지됩니다.": ["Request deletion of your account and personal data. Shared workspace content is retained for other members.", "アカウントと個人データの削除を申請します。共有ワークスペースの資料は他のメンバーのために保持されます。", "申请删除账户和个人数据。共享工作区内容将为其他成员保留。", "Solicita eliminar tu cuenta y tus datos personales. El contenido compartido se conserva para otros miembros."],
  "삭제 요청이 접수되었습니다.": ["Your deletion request has been received.", "削除申請を受け付けました。", "已收到删除申请。", "Se ha recibido tu solicitud de eliminación."],
  "앱에서 작성한 내용은 제출 후 팀에 공유됩니다.": ["Your daily update is shared with the team after submission.", "提出するとデイリーがチームに共有されます。", "提交后，日报将与团队共享。", "Tu actualización se comparte con el equipo al enviarla."],
  "미완료 업무가 없습니다.": ["No open tasks.", "未完了のタスクはありません。", "没有未完成的任务。", "No hay tareas pendientes."],
  "저장되지 않은 변경사항이 있습니다.": ["You have unsaved changes.", "未保存の変更があります。", "有未保存的更改。", "Tienes cambios sin guardar."],
  "내 담당 업무": ["Assigned to me", "自分の担当業務", "分配给我的工作", "Asignado a mí"],
  "계정 연결이 만료되었습니다. 다시 로그인해 주세요.": ["Your session expired. Sign in again.", "セッションが期限切れです。再度ログインしてください。", "登录已过期，请重新登录。", "Tu sesión ha caducado. Vuelve a iniciar sesión."],
  "이름을 입력해 주세요.": ["Enter a title.", "タイトルを入力してください。", "请输入标题。", "Introduce un título."],
  "업무 보기": ["View work", "業務を見る", "查看工作", "Ver trabajo"],
  "앱 심사용 로그인": ["App review access", "アプリ審査用ログイン", "应用审核登录", "Acceso para revisión"],
  "심사 계정으로 로그인": ["Sign in with the review account", "審査用アカウントでログイン", "使用审核账号登录", "Iniciar sesión con la cuenta de revisión"],
  "심사 계정 아이디": ["Review account ID", "審査用アカウントID", "审核账号 ID", "ID de la cuenta de revisión"],
  "비밀번호": ["Password", "パスワード", "密码", "Contraseña"],
  "로그인": ["Sign in", "ログイン", "登录", "Iniciar sesión"],
  "취소": ["Cancel", "キャンセル", "取消", "Cancelar"],
};
const catalogs: Record<string, Record<string, LocalizedMessage>> = { en, ja, zh, es };
export function translator(lang: Language) {
  return (key: string, vars: Record<string, string | number> = {}) => {
    const index = ["en", "ja", "zh", "es"].indexOf(lang);
    const value = lang === "ko" ? key : extra[key]?.[index] ?? catalogs[lang]?.[key] ?? en[key as keyof typeof en] ?? key;
    return translateMessage(key, value, lang, vars);
  };
}
export function resolveLanguage(value?: string | null): Language {
  const base = value?.toLowerCase().split(/[-_]/)[0];
  return languages.some(l => l.id === base) ? base as Language : "en";
}
