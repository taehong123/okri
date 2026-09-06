import type { Metadata } from "next";
import GuidePage from "./guide-page";
import { PUBLIC_APP_URL } from "@/lib/brand";

export const metadata: Metadata = {
  title: "OKRI Guide - 목표에서 오늘 할 일까지",
  description: "Objective, Key Result, Initiative, Project, Task가 연결되는 구조와 책임자·담당자의 역할을 하나의 예시로 알아보세요.",
  alternates: { canonical: new URL("/guide", PUBLIC_APP_URL).toString() },
};

export default function Page() { return <GuidePage />; }
