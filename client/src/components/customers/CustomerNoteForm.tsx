// نموذج إضافة/تعديل ملاحظة متابعة عميل — يُستدعى من CustomerNotes.tsx (تبويب «متابعة العملاء»).
// نص الملاحظة + تاريخ متابعة اختياري (input[type=date] بسيط — لا مكوّن منتقي تاريخ مخصّص
// في المستودع بعد، ونمط expenseDate في ExpenseNew.tsx يستعمل نفس الأسلوب).
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface CustomerNoteFormValue {
  note: string;
  followUpDate: string | null; // YYYY-MM-DD أو null
}

export interface CustomerNoteFormProps {
  /** قيمة أولية عند التعديل — undefined ⇒ نموذج إضافة فارغ. */
  initial?: CustomerNoteFormValue;
  onSubmit: (v: CustomerNoteFormValue) => void;
  onCancel?: () => void;
  submitting?: boolean;
  submitLabel?: string;
}

const EMPTY: CustomerNoteFormValue = { note: "", followUpDate: null };

export function CustomerNoteForm({ initial, onSubmit, onCancel, submitting, submitLabel }: CustomerNoteFormProps) {
  const [note, setNote] = useState(initial?.note ?? EMPTY.note);
  const [followUpDate, setFollowUpDate] = useState<string>(initial?.followUpDate ?? "");

  // إعادة تعيين الحقول عند تبديل القيمة الأولية (فتح نموذج تعديل لملاحظة مختلفة).
  useEffect(() => {
    setNote(initial?.note ?? EMPTY.note);
    setFollowUpDate(initial?.followUpDate ?? "");
  }, [initial?.note, initial?.followUpDate]);

  const trimmed = note.trim();
  const valid = trimmed.length > 0 && trimmed.length <= 2000;

  function submit() {
    if (!valid) return;
    onSubmit({ note: trimmed, followUpDate: followUpDate || null });
    if (!initial) {
      // نموذج إضافة: امسح الحقول بعد الإرسال (النجاح يُدار عبر onSuccess في الصفحة الأم).
      setNote("");
      setFollowUpDate("");
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="customer-note-text">الملاحظة *</Label>
        <Textarea
          id="customer-note-text"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="مثال: اتصل العميل ووعد بالدفع نهاية الأسبوع…"
          maxLength={2000}
        />
        <p className="text-[11px] text-muted-foreground text-left" dir="ltr">{trimmed.length}/2000</p>
      </div>
      <div className="space-y-1 max-w-xs">
        <Label htmlFor="customer-note-followup">تاريخ متابعة (اختياري)</Label>
        <Input
          id="customer-note-followup"
          type="date"
          dir="ltr"
          value={followUpDate}
          onChange={(e) => setFollowUpDate(e.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={submit} disabled={!valid || submitting}>
          {submitting ? "جارٍ الحفظ…" : submitLabel ?? "حفظ الملاحظة"}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={submitting}>
            إلغاء
          </Button>
        )}
      </div>
    </div>
  );
}
