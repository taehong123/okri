import type { Metadata } from "next";
import { BrandLogo } from "@/app/brand-logo";
import Link from "next/link";

export const metadata: Metadata = { title: "이용약관 | OKRI", description: "OKRI 이용약관" };

export default function TermsPage() {
  return <main className="legal-page"><article>
    <header><Link href="/"><BrandLogo /></Link><h1>이용약관</h1><p>시행일: 2026년 9월 1일</p></header>
    <section><h2>1. 서비스</h2><p>OKRI는 워크스페이스의 목표, Project, Task, Routine과 선택한 외부 서비스 연동을 관리하는 업무 도구입니다.</p></section>
    <section><h2>2. 가입과 계정</h2><p>사용자는 본인의 Google 계정으로 로그인하며 Google이 확인한 이메일을 계정 식별과 거래성 안내에 사용합니다. 가입을 위해 휴대전화 번호나 PASS 본인인증을 요구하지 않습니다. 사용자는 계정과 워크스페이스 접근 권한을 안전하게 관리해야 합니다.</p></section>
    <section><h2>3. 연령</h2><p>현재 가입 대상은 만 14세 이상입니다. 만 14세 미만 사용자를 위한 법정대리인 동의 절차는 별도로 제공하지 않습니다.</p></section>
    <section><h2>4. 마케팅 동의</h2><p>마케팅 목적 개인정보 이용 및 광고성 이메일 수신 동의는 선택 사항이며 서비스 이용 대가나 가입 조건이 아닙니다. 동의하지 않거나 나중에 철회해도 서비스의 일반 기능을 계속 이용할 수 있습니다.</p></section>
    <section><h2>5. 요금제와 한도</h2><p>워크스페이스별 월 정액 요금은 VAT 포함 Free 0원, Team 11,000원, Business 55,000원입니다. 한국시간 달력월 기준 Project 생성 한도는 Free 10개, Team 100개, Business 무제한이고 활성 편집자는 Free 5명, Team 10명, Business 무제한입니다. Task, Routine, Viewer와 Slack을 포함한 외부 연동은 모든 플랜에서 제한하지 않습니다. 삭제·보관한 Project도 생성 사용량에서 차감되지 않으며 하향 시 데이터와 역할은 보존됩니다.</p></section>
    <section><h2>6. 체험, 자동 갱신과 결제</h2><p>국내 카드 정기결제는 Payple을 통해 처리합니다. 카드 등록은 즉시 결제하지 않는 AUTH 방식이며, 결제 Owner와 결제자 기준 최초 한 번 30일 체험을 제공합니다. 체험 종료일 또는 매 결제기간 만료일에 선택한 플랜이 자동 갱신됩니다. Team에서 Business로의 상향은 남은 기간 차액 승인 후 적용하고 하향은 다음 갱신일부터 적용합니다. 결제 실패 시 1·3·5·7일에 재시도하며 7일간 기존 플랜을 유지한 뒤 비파괴적으로 Free 한도를 적용할 수 있습니다.</p></section>
    <section><h2>6-1. PayPal 해외 결제</h2><p>PayPal 결제를 선택하면 결제 화면에 표시된 통화와 월 요금이 적용되며 승인 시 첫 결제가 진행됩니다. 별도 무료 체험 없이 매월 자동 갱신됩니다. 환전이 필요한 경우 PayPal 또는 카드사의 환율과 수수료가 적용될 수 있습니다. PayPal 한국 계정 간 국내 결제는 지원되지 않습니다. 플랜을 변경하려면 기존 구독을 해지하고 결제한 이용 기간이 끝난 뒤 새 플랜을 선택합니다.</p></section>
    <section><h2>7. 해지와 환불</h2><p>해지는 요청 즉시 자동 갱신을 중단하고 현재 결제기간 끝까지 이용한 뒤 Free로 전환됩니다. 첫 실제 결제 후 7일 이내이고 그 이후 Project 생성과 AI 사용이 없다면 서비스 화면에서 전액 환불을 요청할 수 있습니다. 그 밖의 환불은 관련 법령과 고지된 정책에 따릅니다.</p></section>
    <section><h2>8. 외부 서비스</h2><p>Google Calendar, Slack 등 외부 서비스 연동은 사용자의 선택과 해당 서비스의 정책에 따라 제공됩니다. 사용자는 언제든 연동을 해제할 수 있습니다.</p></section>
    <section><h2>9. 책임과 서비스 변경</h2><p>서비스는 안정적인 제공을 위해 노력하지만 점검, 장애 또는 외부 서비스 변경으로 일시 중단될 수 있습니다. 중요한 업무 정보는 사용자가 별도로 확인하고 필요한 경우 백업해야 합니다.</p></section>
    <section><h2>10. 문의</h2><p>서비스 관련 문의: <a href="mailto:taehong0613@gmail.com">taehong0613@gmail.com</a></p></section>
    <footer><Link href="/privacy">개인정보처리방침</Link><Link href="/">서비스로 돌아가기</Link></footer>
  </article></main>;
}
