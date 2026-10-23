import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { D, fmt, fmtInt } from "@/lib/money";
import { fmtDateTime } from "@/lib/date";
const STATUS_META: Record<string, { label: string; cls: string }> = {
  COUNTING: {
    label: "قيد العدّ",
    cls: "bg-[var(--sem-info-bg)] text-[var(--sem-info)] border-[var(--sem-info)]/30",
  },
  REVIEW: {
    label: "قيد المراجعة",
    cls: "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)] border-[var(--sem-warn)]/40",
  },
  APPROVED: {
    label: "معتمدة ومُسوّاة",
    cls: "bg-money-positive/10 text-money-positive border-money-positive/40",
  },
  CANCELLED: {
    label: "ملغاة",
    cls: "bg-money-negative/10 text-money-negative border-money-negative/40",
  },
};
/* ───────── أدوات تنسيق (أرقام لاتينية، أموال decimal.js حصراً) ───────── */
export const nf = (n: number | null | undefined) => fmtInt(n ?? 0);
export const signed = (n: number) =>
  (n > 0 ? "+" : n < 0 ? "−" : "") + fmtInt(Math.abs(n));
export const money = (v: string | number | null | undefined) => {
  const d = D(v ?? 0);
  return (d.isNegative() ? "−" : "") + fmt(d.abs().toFixed(2)) + " د.ع";
};
export const pctStr = (v: string | number | null | undefined) =>
  D(v ?? 0)
    .toNumber()
    .toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: 2 });
export const dt = (v: string | number | Date | null | undefined) =>
  fmtDateTime(v);

export function StatusBadge({ status }: { status: string }) {
  const m = STATUS_META[status] ?? {
    label: status,
    cls: "bg-muted text-muted-foreground border-border",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${m.cls}`}
    >
      {m.label}
    </span>
  );
}
export function Pill({
  tone,
  children,
  title,
}: {
  tone: "muted" | "blue" | "amber" | "green" | "emerald" | "rose" | "violet";
  children: ReactNode;
  title?: string;
}) {
  const tones: Record<string, string> = {
    muted: "bg-muted text-muted-foreground border-border",
    blue: "bg-[var(--sem-info-bg)] text-[var(--sem-info)] border-[var(--sem-info)]/30",
    amber:
      "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)] border-[var(--sem-warn)]/40",
    green: "bg-money-positive/10 text-money-positive border-money-positive/40",
    emerald:
      "bg-money-positive/10 text-money-positive border-money-positive/40",
    rose: "bg-money-negative/10 text-money-negative border-money-negative/40",
    violet: "bg-violet-50 text-violet-700 border-violet-200",
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "blue" | "amber" | "emerald" | "rose";
}) {
  const tones: Record<string, string> = {
    blue: "text-[var(--sem-info)]",
    amber: "text-[var(--sem-warn)]",
    emerald: "text-money-positive",
    rose: "text-money-negative",
  };
  return (
    <Card className="p-4 gap-1">
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p
        className={`text-xl font-bold tabular-nums ${tone ? tones[tone] : ""}`}
        dir="ltr"
      >
        {value}
      </p>
      {sub && (
        <p className="text-xs tabular-nums text-muted-foreground" dir="ltr">
          {sub}
        </p>
      )}
    </Card>
  );
}
