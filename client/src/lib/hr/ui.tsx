/** عناصر عرض مشتركة لوحدة الموارد البشرية: شارة حالة التوظيف، أفاتار الموظف، تنسيق المبالغ. */
import { cn } from "@/lib/utils";
import { employmentStatusLabel } from "@shared/hr";
import { fmtInt } from "@/lib/money";

const STATUS_CLS: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  leave: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  terminated: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

export function EmploymentStatusBadge({ status }: { status: string }) {
  return (
    <span className={cn("inline-block rounded-full px-2 py-0.5 text-xs whitespace-nowrap", STATUS_CLS[status] ?? "bg-muted text-muted-foreground")}>
      {employmentStatusLabel(status)}
    </span>
  );
}

export function empInitials(name?: string | null): string {
  if (!name) return "؟";
  const p = name.trim().split(/\s+/);
  return (p[0]?.[0] ?? "") + (p[1]?.[0] ?? "");
}

/** أفاتار دائري بالأحرف الأولى ولون الموظف (colorTag) أو صورته إن وُجدت. */
export function EmpAvatar({ name, color, photoUrl, sizePx = 36, className }: { name?: string | null; color?: string | null; photoUrl?: string | null; sizePx?: number; className?: string }) {
  const s = `${sizePx}px`;
  if (photoUrl) {
    return <img src={photoUrl} alt={name ?? ""} className={cn("rounded-full object-cover shrink-0", className)} style={{ width: s, height: s }} />;
  }
  return (
    <span
      className={cn("inline-flex items-center justify-center rounded-full text-white font-semibold shrink-0", className)}
      style={{ width: s, height: s, background: color || "var(--primary)", fontSize: Math.round(sizePx * 0.36) }}
    >
      {empInitials(name)}
    </span>
  );
}

export const iqd = (v: string | number | null | undefined) => fmtInt(v);
