import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState, LoadingState } from "@/components/PageState";
import { PRODUCT_CONTENT_DRAFT_STATUS_LABELS } from "@shared/productContentAiLabels";
import type { ProductContentDraftEditor } from "./useProductContentDraft";
export function ContentDraftHistory({
  editor,
  can,
}: {
  editor: ProductContentDraftEditor;
  can: (path: string) => boolean;
}) {
  if (!editor.canReadHistory) return null;
  const query = editor.history;
  return (
    <section
      className="min-w-0 rounded-md border bg-background/80 p-3"
      aria-label="تاريخ المسودات"
    >
      <p className="mb-2 text-sm font-semibold">تاريخ المسودات المحفوظة</p>
      <p className="mb-2 text-xs text-muted-foreground">
        القرارات تخص النسخ المحفوظة؛ التعديلات الحالية تظهر في النموذج.
      </p>
      {query.isLoading ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState
          message="تعذر تحميل تاريخ المسودات."
          onRetry={() => query.refetch()}
        />
      ) : (query.data ?? []).length === 0 ? (
        <p className="text-xs text-muted-foreground">لا مسودات محفوظة.</p>
      ) : (
        <div className="space-y-2">
          {query.data?.map((saved) => (
            <div
              key={saved.id}
              className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded border px-2 py-2 text-xs"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Badge
                  variant={saved.status === "APPROVED" ? "default" : "outline"}
                >
                  {PRODUCT_CONTENT_DRAFT_STATUS_LABELS[
                    saved.status as keyof typeof PRODUCT_CONTENT_DRAFT_STATUS_LABELS
                  ] ?? saved.status}
                </Badge>
                <span>#{saved.id}</span>
                <span className="text-muted-foreground">
                  {saved.validation.ok ? "اجتازت التحقق" : "تحتاج مراجعة"}
                </span>
              </div>
              {saved.status === "DRAFT" &&
                can("catalog.decideContentDraft") && (
                  <div className="flex flex-wrap gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={editor.pending.decide}
                      onClick={() =>
                        void editor.decideDraft(Number(saved.id), "REJECTED")
                      }
                    >
                      رفض
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={editor.pending.decide || !saved.validation.ok}
                      onClick={() =>
                        void editor.decideDraft(Number(saved.id), "APPROVED")
                      }
                    >
                      اعتماد
                    </Button>
                  </div>
                )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
