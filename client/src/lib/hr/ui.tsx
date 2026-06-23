/** عناصر عرض مشتركة لوحدة الموارد البشرية: شارة حالة التوظيف، أفاتار الموظف، تنسيق المبالغ. */
import { cn } from "@/lib/utils";
import { employmentStatusLabel } from "@shared/hr";
import { fmtInt } from "@/lib/money";

const STATUS_CLS: Record<string, string> = {
  active: "badge-status-active",
  leave: "badge-status-pending",
  terminated: "bg-muted text-muted-foreground",
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
