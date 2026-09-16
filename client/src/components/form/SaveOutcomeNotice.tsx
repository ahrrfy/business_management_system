/**
 * SaveOutcomeNotice — سطرُ نتيجة الحفظ المُهيكَلة بجوار أزرار الحفظ (م٦ ق٤، Codex FP-04).
 *
 * أربعُ حالات بأربعة ألوانٍ دلاليّة من التوكنز (لا لون خامّ — حارس `check:colors`):
 *   SAVED ⇒ إيجابيّ · REQUESTED ⇒ تحذير (معلّق، لم يُطبَّق) · CONFLICT ⇒ تحذير · FAILED ⇒ سلبيّ.
 * `role="status"` + `aria-live="polite"` كي يُعلنها قارئ الشاشة بلا مقاطعة الكتابة.
 * يُعاد استعماله في شريط الحفظ وفي لوحة الاستعادة — نتيجةٌ واحدة بشكلٍ واحد.
 */
import { AlertTriangle, CheckCircle2, Hourglass, XCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import type { SaveOutcome } from "./saveOutcome";

const STYLE: Record<SaveOutcome["status"], { icon: typeof CheckCircle2; className: string }> = {
  SAVED: { icon: CheckCircle2, className: "border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" },
  REQUESTED: { icon: Hourglass, className: "border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]" },
  CONFLICT: { icon: AlertTriangle, className: "border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]" },
  FAILED: { icon: XCircle, className: "border-[var(--sem-neg)]/40 bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]" },
};

export function SaveOutcomeNotice({ outcome, className }: { outcome: SaveOutcome | null | undefined; className?: string }) {
  if (!outcome) return null;
  const { icon: Icon, className: tone } = STYLE[outcome.status];
  return (
    <div
      data-slot="save-outcome"
      data-status={outcome.status}
      role="status"
      aria-live="polite"
      className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-sm", tone, className)}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="whitespace-pre-wrap break-words">{outcome.message}</span>
    </div>
  );
}
