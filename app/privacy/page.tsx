import type { Metadata } from "next";
import { BrandLogo } from "@/app/brand-logo";
import Link from "next/link";

export const metadata: Metadata = { title: "개인정보처리방침 | OKRI", description: "OKRI 개인정보처리방침" };

export default function PrivacyPage() {
  return <main className="legal-page"><article>
    <header><Link href="/"><BrandLogo /></Link><h1>개인정보처리방침</h1><p>시행일: 2026년 9월 1일</p></header>
    <section><h2>1. 수집하는 개인정보</h2><p>Google 계정 로그인 시 Google이 확인한 계정 식별자, 이메일 주소와 표시 이름을 수집합니다. 가입을 위해 휴대전화 번호나 PASS 본인인증 정보를 수집하지 않습니다. 사용자가 외부 서비스 연동을 선택하면 해당 기능 제공에 필요한 OAuth 권한과 토큰을 처리합니다. 유료 플랜을 선택하면 Payple 결제자 식별값의 단방향 해시, 암호화된 빌링키, 카드사와 마스킹 카드번호, 거래번호·금액·상태·영수증 URL을 저장합니다.</p></section>
    <section><h2>2. 필수 정보의 이용 목적</h2><p>계정 정보는 사용자 인증, 워크스페이스 접근 제어, 서비스 운영 안내와 오류 대응에 사용합니다. 결제 정보는 30일 체험의 중복 방지, 정기결제, 해지, 환불과 거래기록 제공에 사용합니다. Payple 응답에 포함될 수 있는 전화번호와 원본 응답 전체는 저장하지 않습니다.</p></section>
    <section><h2>3. 선택적 마케팅 이용과 광고성 이메일</h2><p>마케팅 목적 개인정보 이용 동의와 광고성 이메일 수신 동의는 각각 별도로 받으며 기본 선택하지 않습니다. 어느 하나에 동의하지 않아도 가입과 일반 기능 이용에는 영향이 없습니다. 광고성 이메일은 두 동의를 모두 유지하고 재확인 기간이 지나지 않은 사용자에게만 보냅니다. 사용자는 ‘내 설정’ 또는 이메일의 서명된 수신거부 링크에서 즉시 철회할 수 있으며, 동의 후 2년이 지나면 재확인 전까지 발송 대상에서 제외합니다. 초대, 결제 예정, 영수증과 결제 실패 같은 거래성 이메일은 선택 동의와 구분합니다.</p></section>
    <section><h2>4. 보유 기간</h2><p>계정 정보는 회원 탈퇴 시까지 보유한 뒤 법령상 보존 의무가 있는 경우를 제외하고 지체 없이 삭제합니다. 동의와 철회 이력은 동의 증명 및 분쟁 대응에 필요한 기간 동안 보관할 수 있습니다. 계약·결제·해지·환불 기록은 전자상거래 관련 법령에 따라 5년간 보관합니다.</p></section>
    <section><h2>5. 처리위탁 및 국외 이전</h2><p>국내 카드 등록·정기결제·해지·환불 처리를 위해 Payple을 이용하고, 이메일 발송을 위해 Resend를 이용할 수 있습니다. 각 처리자는 결제 또는 이메일 발송에 필요한 범위에서만 정보를 처리합니다. Google, Slack 등 사용자가 선택한 외부 연동은 해당 서비스의 정책과 사용자의 승인 범위에 따라 처리됩니다.</p></section>
    <section><h2>5-1. PayPal 결제</h2><p>PayPal 결제를 선택하면 PayPal의 결제 화면에서 결제 정보를 직접 입력합니다. OKRI는 구독·거래 식별번호, 금액, 통화, 결제·환불 상태와 처리 시각을 계정 및 워크스페이스와 연결해 보관합니다. PayPal 계정 비밀번호, 카드 전체 번호, CVC와 PayPal 원본 응답 전체는 저장하지 않습니다. PayPal이 직접 수집하는 정보의 처리는 <a href="https://www.paypal.com/webapps/mpp/ua/privacy-full" target="_blank" rel="noreferrer">PayPal 개인정보처리방침</a>을 따릅니다.</p></section>
    <section><h2>6. 보호 조치</h2><p>OAuth 토큰과 Payple 빌링키는 서로 분리된 전용 키로 암호화하고, 접근 권한을 서비스 제공에 필요한 범위로 제한합니다. 결제자 중복 확인에는 원문 대신 단방향 해시를 사용합니다. 카드 전체 번호, CVC, Payple 원본 응답과 전화번호는 OKRI 데이터베이스에 저장하지 않습니다.</p></section>
    <section><h2>7. 이용자의 권리</h2><p>사용자는 개인정보 열람, 정정, 삭제와 처리정지를 요청할 수 있습니다. 선택적 마케팅 동의는 내 설정에서 직접 변경할 수 있습니다. 계정 삭제 및 개인정보 관련 요청은 아래 연락처로 접수할 수 있습니다.</p></section>
    <section><h2>8. 문의</h2><p>개인정보 관련 문의: <a href="mailto:taehong0613@gmail.com">taehong0613@gmail.com</a></p></section>
    <footer><Link href="/terms">이용약관</Link><Link href="/">서비스로 돌아가기</Link></footer>
  </article></main>;
}
