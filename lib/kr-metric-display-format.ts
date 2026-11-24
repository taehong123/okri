export const METRIC_DISPLAY_MODES = ["default", "exact", "increment"] as const;
export type MetricDisplayMode = typeof METRIC_DISPLAY_MODES[number];
export type MetricDisplayPreference = { mode: MetricDisplayMode; increment: number | null };
export type MetricDisplaySettings = MetricDisplayPreference & { revision: number; updatedAt: string | null };

const hours = /^(?:h|hr|hrs|hour|hours|시간|時間|小时|小時|hora|horas)$/iu;

export function metricDisplayIncrement(unit: string, preference?: MetricDisplayPreference | null) {
  if (preference?.mode === "exact") return null;
  if (preference?.mode === "increment") return preference.increment;
  return hours.test(unit.trim()) ? 0.5 : null;
}

export function formatMetricValue(value: number | null, unit: string, preference?: MetricDisplayPreference | null, locale = "ko-KR") {
  if (value === null) return null;
  const lang = new Intl.Locale(locale).language;
  const increment = metricDisplayIncrement(unit, preference);
  const localized = (number: number, digits: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(number === 0 ? 0 : number);
  const withUnit = (number: string) => !unit ? number : lang === "ko" && unit === "시간" ? number + unit : number + " " + unit;
  if (increment === null) {
    const number = preference?.mode === "exact"
      ? new Intl.NumberFormat(locale, { maximumSignificantDigits: 21 }).format(value === 0 ? 0 : value)
      : localized(value, 6);
    return withUnit(number);
  }
  // Work on the magnitude for symmetric ties and cancel floating-point noise at the last displayed digit.
  const ratio = Math.abs(value) / increment;
  if (ratio >= Number.MAX_SAFE_INTEGER) return withUnit(localized(value, 6));
  const tolerance = Math.min(1e-8, Number.EPSILON * ratio);
  const rounded = Math.sign(value) * Number((Math.round(ratio + tolerance) * increment).toFixed(6));
  const display = withUnit(localized(rounded, 6));
  if (value > 0 && rounded === 0) {
    const threshold = withUnit(localized(increment, 6));
    switch (lang) {
      case "ko": return threshold + " 미만";
      case "ja": return threshold + "未満";
      case "zh": return "小于 " + threshold;
      case "es": return "Menos de " + threshold;
      default: return "Less than " + threshold;
    }
  }
  if (value === rounded || Math.abs(value - rounded) <= Number.EPSILON * 2 * Math.abs(value)) return display;
  switch (lang) {
    case "ko": return "약 " + display;
    case "ja": return "約 " + display;
    case "zh": return "约 " + display;
    case "es": return "Aprox. " + display;
    default: return "About " + display;
  }
}
