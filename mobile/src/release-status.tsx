import React, { useState } from "react";
import { Linking, Platform, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Download, RefreshCw } from "lucide-react-native";
import { updateOffer } from "../../lib/mobile/release-policy";
import { clientHeaders } from "./client-version";
import { useApp } from "./context";
import { Button, ErrorState, Txt } from "./ui";

export function ReleaseStatus() {
  const { api, t } = useApp(), [linkError, setLinkError] = useState(false);
  const version = clientHeaders()["X-OKRI-App-Version"];
  const policy = useQuery({
    queryKey: ["mobile-release-policy", Platform.OS],
    queryFn: ({ signal }) => api<unknown>("/api/mobile/v1/policy?platform=" + Platform.OS, { signal }),
    enabled: Platform.OS === "ios" || Platform.OS === "android", retry: false, staleTime: 600000,
  });
  const offer = updateOffer(policy.data, Platform.OS, version);
  return <View style={{ gap: 12 }}>
    <Txt role="section">{t("앱 업데이트")}</Txt>
    <Txt role="label" muted>OKRI {version}</Txt>
    {offer ? <>
      <Txt role="label">{t(offer.retired ? "이 버전의 지원 기간이 끝났습니다. 스토어에서 업데이트해 주세요." : "새 버전을 사용할 수 있습니다.")}</Txt>
      <Button secondary icon={Download} label={t("스토어에서 업데이트")} onPress={() => {
        setLinkError(false); void Linking.openURL(offer.url).catch(() => setLinkError(true));
      }} />
    </> : policy.isError ? <Button secondary icon={RefreshCw} label={t("업데이트 다시 확인")} busy={policy.isFetching} onPress={() => void policy.refetch()} />
      : <Txt role="label" muted>{t("업데이트가 있어도 작성 중인 화면은 다시 시작하지 않습니다.")}</Txt>}
    {linkError && <ErrorState message={t("스토어를 열지 못했습니다. 잠시 후 다시 시도해 주세요.")} />}
  </View>;
}
