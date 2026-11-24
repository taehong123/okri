"use client";

import { useState, type FormEvent } from "react";
import { t } from "@/lib/client-language";
import type { MetricDisplayMode, MetricDisplaySettings } from "@/lib/kr-metric-display-format";

const defaults: MetricDisplaySettings = { mode: "default", increment: null, revision: 0, updatedAt: null };

export default function KrMetricDisplayForm({ keyResultId, settings = defaults, onDirty, onSaved }: {
  keyResultId: string;
  settings?: MetricDisplaySettings;
  onDirty: (dirty: boolean) => void;
  onSaved: (settings: MetricDisplaySettings) => void;
}) {
  const [mode, setMode] = useState<MetricDisplayMode>(settings.mode);
  const [increment, setIncrement] = useState(String(settings.increment ?? "0.5"));
  const [latest, setLatest] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const changed = (nextMode: MetricDisplayMode, nextIncrement: string) =>
    nextMode !== latest.mode || nextMode === "increment" && Number(nextIncrement) !== latest.increment;

  function change(nextMode: MetricDisplayMode, nextIncrement: string) {
    setMode(nextMode); setIncrement(nextIncrement); setSaved(false);
    onDirty(changed(nextMode, nextIncrement));
  }

  async function reload() {
    try {
      const response = await fetch("/api/kr-metric-display?keyResultId=" + encodeURIComponent(keyResultId), { cache: "no-store" });
      if (!response.ok) throw new Error();
      const { settings } = await response.json() as { settings: MetricDisplaySettings };
      setLatest(settings); setConflict(false); setError("");
      onDirty(mode !== settings.mode || mode === "increment" && Number(increment) !== settings.increment);
    } catch { setError(t("KR 설정을 불러오지 못했습니다.")); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || conflict || !changed(mode, increment)) return;
    setSaving(true); setError(""); setSaved(false);
    try {
      const response = await fetch("/api/kr-metric-display", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyResultId, mode, increment: mode === "increment" ? Number(increment) : null, expectedRevision: latest.revision }) });
      if (!response.ok) {
        setConflict(response.status === 409);
        throw new Error();
      }
      const { settings } = await response.json() as { settings: MetricDisplaySettings };
      setLatest(settings); setSaved(true); onDirty(false); onSaved(settings);
    } catch { setError(t("표시 설정을 저장하지 못했습니다.")); }
    finally { setSaving(false); }
  }

  return <details className="kr-history-records kr-display-settings">
    <summary>{t("숫자 표시 설정")}</summary>
    <form className="property-form" onSubmit={event => void submit(event)}>
      <fieldset className="kr-source-fields" disabled={saving}>
        <label><span>{t("표시 방식")}</span>
          <select value={mode} onChange={event => change(event.target.value as MetricDisplayMode, increment)}>
            <option value="default">{t("기본 표시")}</option>
            <option value="increment">{t("반올림 단위 지정")}</option>
            <option value="exact">{t("원본값 표시")}</option>
          </select>
        </label>
        {mode === "increment" && <label><span>{t("반올림 단위")}</span>
          <input type="number" min="0.000001" max="1000000000000" step="0.000001" required value={increment}
            onChange={event => change(mode, event.target.value)}/>
        </label>}
        {mode === "default" && <small>{t("시간은 기본으로 0.5시간 단위로 표시합니다.")}</small>}
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {conflict && <button type="button" className="secondary" onClick={() => void reload()}>{t("최신 설정 불러오기")}</button>}
      {saved && <p role="status">{t("저장했습니다.")}</p>}
      <button type="submit" className="secondary" disabled={saving || conflict || !changed(mode, increment)}>
        {saving ? t("저장 중") : t("표시 설정 저장")}
      </button>
    </form>
  </details>;
}
