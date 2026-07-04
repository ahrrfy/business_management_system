// عرض قائمة ملاحظات متابعة عميل واحد — أحدث أولاً، مع شارة حالة (مفتوحة/مغلقة) وتاريخ متابعة
// (مع تمييز بصري للمتأخرة/اليوم)، وزرّ تبديل الإنجاز. يُستدعى من CustomerNotes.tsx، وقابل لإعادة
// الاستخدام لاحقاً داخل شاشة تفاصيل عميل مستقلة إن وُجدت.
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { cn } from "@/lib/utils";
import { CheckCircle2, Circle, Pencil, Trash2 } from "lucide-react";

export interface CustomerNoteRow {
  id: number;
  customerId: number;
  note: string;
  followUpDate: string | null;
  isResolved: boolean;
  createdBy: number;
  createdByName: string | null;
  branchId: number;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface CustomerNotesListProps {
  notes: CustomerNoteRow[];
  onToggleResolved: (note: CustomerNoteRow) => void;
  onEdit?: (note: CustomerNoteRow) => void;
  onDelete?: (note: CustomerNoteRow) => void;
  /** يُعطَّل أثناء طلب قيد التنفيذ (تبديل/حذف) — يمنع نقرات مزدوجة. */
  busyId?: number | null;
  /** المستخدم مدير فأعلى — يتحكّم بظهور أزرار التعديل/الحذف (صلاحية managerProcedure). */
  canManage?: boolean;
}

function followUpTone(followUpDate: string | null, isResolved: boolean): "neutral" | "warning" | "danger" {
  if (!followUpDate || isResolved) return "neutral";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(`${followUpDate}T00:00:00`);
  if (d.getTime() < today.getTime()) return "danger"; // متأخرة
  if (d.getTime() === today.getTime()) return "warning"; // اليوم
  return "neutral";
}

export function CustomerNotesList({ notes, onToggleResolved, onEdit, onDelete, busyId, canManage }: CustomerNotesListProps) {
  if (notes.length === 0) {
    return <p className="text-sm text-muted-foreground py-6 text-center">لا توجد ملاحظات متابعة لهذا العميل بعد.</p>;
  }

  return (
    <ul className="space-y-2">
      {notes.map((n) => {
        const tone = followUpTone(n.followUpDate, n.isResolved);
        const busy = busyId === n.id;
        return (
          <li
            key={n.id}
            className={cn(
              "rounded-md border p-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between",
              n.isResolved && "opacity-70"
            )}
          >
            <div className="min-w-0 space-y-1 flex-1">
              <p className={cn("text-sm whitespace-pre-wrap break-words", n.isResolved && "line-through decoration-muted-foreground/60")}>
                {n.note}
              </p>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span dir="ltr">{fmtDateTime(n.createdAt)}</span>
                {n.createdByName && <span>— {n.createdByName}</span>}
                {n.followUpDate && (
                  <Badge variant={tone === "danger" ? "danger" : tone === "warning" ? "warning" : "neutral"} className="text-[10px]">
                    متابعة: {fmtDate(n.followUpDate)}
                    {tone === "danger" && " (متأخرة)"}
                    {tone === "warning" && " (اليوم)"}
                  </Badge>
                )}
                <Badge variant={n.isResolved ? "success" : "info"} className="text-[10px]">
                  {n.isResolved ? "مغلقة" : "مفتوحة"}
                </Badge>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1 self-end sm:self-start">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onToggleResolved(n)}
                disabled={busy}
                title={n.isResolved ? "إعادة فتح المتابعة" : "وضع علامة إنجاز"}
              >
                {n.isResolved ? <Circle className="size-3.5" aria-hidden /> : <CheckCircle2 className="size-3.5" aria-hidden />}
                <span className="sr-only">{n.isResolved ? "إعادة فتح" : "إنجاز"}</span>
              </Button>
              {canManage && onEdit && (
                <Button type="button" size="sm" variant="ghost" onClick={() => onEdit(n)} disabled={busy} title="تعديل الملاحظة">
                  <Pencil className="size-3.5" aria-hidden />
                  <span className="sr-only">تعديل</span>
                </Button>
              )}
              {canManage && onDelete && (
                <Button type="button" size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => onDelete(n)} disabled={busy} title="حذف الملاحظة">
                  <Trash2 className="size-3.5" aria-hidden />
                  <span className="sr-only">حذف</span>
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
