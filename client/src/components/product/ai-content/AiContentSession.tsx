import { AlertTriangle, Loader2, Sparkles } from "lucide-react";
import { useCatalogPeopleOperationAccess } from "@/lib/catalogPeopleOperationAccess";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { describeAiError } from "@/lib/aiProductError";
import { AiDraftFields } from "./AiDraftFields";
import { AiDraftReview } from "./AiDraftReview";
import { ContentDraftHistory } from "./ContentDraftHistory";
import {
  useProductContentDraft,
  type ProductContentAssistantProps,
} from "./useProductContentDraft";
export function AiContentSession(props: ProductContentAssistantProps) {
  const { can } = useCatalogPeopleOperationAccess();
  const editor = useProductContentDraft({ ...props, can });
  const {
    draft,
    visibleDraft,
    cacheHit,
    imagesUsed,
    savedDraftId,
    draftIsStale,
    pending,
    generateDraft,
  } = editor;
  const generateError = editor.generateError
    ? describeAiError(editor.generateError)
    : null;
  return (
    <Card
      dir="rtl"
      className="border-violet-200/70 bg-violet-50/30 dark:border-violet-900/60 dark:bg-violet-950/10"
    >
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles aria-hidden className="size-4 text-violet-600" />
            مساعد محتوى المنتج
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            يولّد مسودة من الحقائق الحالية ويحفظ سجلها للمراجعة عند توفر صلاحية
            الحفظ. التطبيق يملأ النموذج؛ حفظ المنتج خطوة مستقلة.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => generateDraft(Boolean(draft))}
          disabled={!can("catalog.generateContentDraft") || pending.generate}
        >
          {pending.generate ? (
            <Loader2 aria-hidden className="size-4 animate-spin" />
          ) : (
            <Sparkles aria-hidden className="size-4" />
          )}
          {pending.generate
            ? pending.save
              ? "جارٍ حفظ المسودة…"
              : "جارٍ التوليد…"
            : draft
              ? "توليد نسخة جديدة"
              : "اقتراح المحتوى"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {generateError && (
          <div
            role="alert"
            aria-live="assertive"
            className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="font-semibold">{generateError.title}</p>
              <p>{generateError.message}</p>
              {generateError.action && (
                <p className="text-[11px] opacity-90">{generateError.action}</p>
              )}
              {generateError.retryable && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-1"
                  onClick={() => generateDraft(Boolean(draft))}
                  disabled={
                    !can("catalog.generateContentDraft") || pending.generate
                  }
                >
                  إعادة المحاولة
                </Button>
              )}
            </div>
          </div>
        )}

        {!visibleDraft ? (
          <div className="rounded-md border border-dashed bg-background/70 px-3 py-4 text-center text-xs text-muted-foreground">
            املأ النوع والماركة والخصائص الأساسية، ثم اضغط «اقتراح المحتوى».
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">مسودة غير منشورة</Badge>
              {cacheHit && <Badge variant="secondary">من Cache</Badge>}
              {imagesUsed > 0 && (
                <Badge
                  variant="secondary"
                  className="border-violet-400/40 bg-violet-100/60 text-violet-800 dark:bg-violet-900/30 dark:text-violet-200"
                >
                  تحليل بصريّ: {imagesUsed} صورة معتمَدة
                </Badge>
              )}
              {savedDraftId && (
                <Badge variant="secondary">مسودة محفوظة #{savedDraftId}</Badge>
              )}
              <span>المحتوى يحتاج مراجعة قبل التطبيق.</span>
            </div>

            {draftIsStale && (
              <div
                role="alert"
                className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]/70 px-3 py-2 text-xs text-[var(--sem-warn)]"
              >
                تغيّرت حقائق المنتج بعد توليد هذه المسودة؛ أعد التوليد قبل
                تطبيقها.
              </div>
            )}

            <AiDraftFields editor={editor} />
            <AiDraftReview editor={editor} can={can} />
          </>
        )}
        <ContentDraftHistory editor={editor} can={can} />
      </CardContent>
    </Card>
  );
}
