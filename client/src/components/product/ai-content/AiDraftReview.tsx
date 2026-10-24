import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { describeAiError } from "@/lib/aiProductError";
import type { ProductContentDraftEditor } from "./useProductContentDraft";
export function AiDraftReview({
  editor,
  can,
}: {
  editor: ProductContentDraftEditor;
  can: (path: string) => boolean;
}) {
  const {
    visibleDraft,
    needsValidation,
    pending,
    validateDraft,
    applyDraft,
    canApply,
    validation,
  } = editor;
  const validateError = editor.validateError
    ? describeAiError(editor.validateError)
    : null;
  const saveDraftError = editor.saveDraftError
    ? describeAiError(editor.saveDraftError)
    : null;
  if (!visibleDraft) return null;
  return (
    <>
      {needsValidation && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--sem-info)]/40 bg-[var(--sem-info-bg)] px-3 py-2 text-xs text-[var(--sem-info)]">
          <span>تم تعديل المسودة؛ أعد التحقق قبل اعتمادها.</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={validateDraft}
            disabled={!can("catalog.validateContentDraft") || pending.validate}
          >
            {pending.validate ? "جارٍ التحقق…" : "إعادة التحقق"}
          </Button>
        </div>
      )}

      {validateError && (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          <p className="font-semibold">{validateError.title}</p>
          <p>{validateError.message}</p>
          {validateError.action && (
            <p className="mt-1 text-[11px] opacity-90">
              {validateError.action}
            </p>
          )}
        </div>
      )}

      {saveDraftError && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]/70 px-3 py-2 text-xs text-[var(--sem-warn)]"
        >
          <p className="font-semibold">تم توليد المسودة لكن تعذر حفظ سجلها</p>
          <p>{saveDraftError.message}</p>
        </div>
      )}

      {(validation?.blockers?.length ?? 0) > 0 && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          لا يمكن اعتماد المسودة قبل إصلاح: {validation?.blockers.join("؛ ")}
        </div>
      )}

      {(validation?.warnings.length ?? 0) > 0 && (
        <div className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]/70 px-3 py-2 text-xs text-[var(--sem-warn)]">
          <p className="font-semibold">ملاحظات المراجعة</p>
          <ul className="mt-1 list-disc space-y-1 pe-5">
            {(validation?.warnings ?? []).map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <CheckCircle2 aria-hidden className="size-4 text-[var(--sem-pos)]" />
          الثقة:{" "}
          {visibleDraft.confidence === "high"
            ? "مرتفعة"
            : visibleDraft.confidence === "medium"
              ? "متوسطة"
              : "منخفضة"}
        </div>
        <Button type="button" onClick={applyDraft} disabled={!canApply}>
          تطبيق المسودة على النموذج
        </Button>
      </div>
    </>
  );
}
