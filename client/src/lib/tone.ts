// خريطة النبرة الدلالية الموحّدة: نبرة → صنف لون النصّ (توكنز tokens.css، لا ألوان خام).
// مصدرٌ واحد يستعمله StatCard و ReportShell بدل تعريفَين متباعدَين كانا يفترقان في نبرة info
// (كانت StatCard تستعمل --status-pending و ReportShell --sem-info — وُحِّدت على --sem-info الدلاليّ).
export type Tone = "default" | "positive" | "negative" | "warning" | "info";

export const TONE_TEXT_CLASS: Record<Tone, string> = {
  default: "text-foreground",
  positive: "text-money-positive",
  negative: "text-money-negative",
  warning: "text-stock-low",
  info: "text-[var(--sem-info)]",
};
