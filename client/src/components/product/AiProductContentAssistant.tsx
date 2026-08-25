import { AlertTriangle, CheckCircle2, Loader2, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { describeAiError } from "@/lib/aiProductError";
import { trpc } from "@/lib/trpc";
import {
  canonicalJson,
  type AiProductDraft,
  type DraftValidation,
  type ProductFacts,
} from "@shared/productContentAi";

type DraftField = keyof Pick<
  AiProductDraft,
  | "seoTitle"
  | "shortTitle"
  | "posLabel"
  | "invoiceLabel"
  | "marketingCopy"
  | "description"
>;

type Props = {
  facts: ProductFacts;
  onApply: (draft: AiProductDraft) => void;
  productId?: number;
};

const FIELD_LABELS: Record<DraftField, string> = {
  seoTitle: "عنوان SEO",
  shortTitle: "العنوان المختصر",
  posLabel: "اسم الكاشير POS",
  invoiceLabel: "اسم الفاتورة",
  marketingCopy: "النص الترويجي",
  description: "الوصف الفني",
};

const FIELD_HINTS: Record<DraftField, string> = {
  seoTitle: "عنوان المتجر ومحركات البحث، بلا سعر أو وعود غير مثبتة.",
  shortTitle: "نسخة قصيرة لبطاقة المنتج والهاتف.",
  posLabel: "اسم سريع القراءة داخل نقطة البيع.",
  invoiceLabel: "اسم ثابت ومقروء في المستند.",
  marketingCopy: "فائدة قصيرة مبنية على الحقائق المعتمدة.",
  description: "مواصفات واستخدامات المنتج دون اختراع معلومات.",
};

const FIELD_ORDER: DraftField[] = [
  "seoTitle",
  "shortTitle",
  "posLabel",
  "invoiceLabel",
  "marketingCopy",
  "description",
];

export function AiProductContentAssistant({
  facts,
  onApply,
  productId,
}: Props) {
  const [draft, setDraft] = useState<AiProductDraft | null>(null);
  const [validation, setValidation] = useState<DraftValidation | null>(null);
  const [needsValidation, setNeedsValidation] = useState(false);
  const [cacheHit, setCacheHit] = useState(false);
  const [savedDraftId, setSavedDraftId] = useState<number | null>(null);
  const [sourceFingerprint, setSourceFingerprint] = useState<string | null>(
    null,
  );
  const [edited, setEdited] = useState<Partial<Record<DraftField, string>>>({});
  const factsFingerprint = useMemo(() => canonicalJson(facts), [facts]);
  const latestFactsFingerprint = useRef(factsFingerprint);

  useEffect(() => {
    latestFactsFingerprint.current = factsFingerprint;
    if (sourceFingerprint && sourceFingerprint !== factsFingerprint) {
      setValidation(null);
      setNeedsValidation(true);
    }
  }, [factsFingerprint, sourceFingerprint]);
  const draftsQuery = trpc.catalog.listContentDrafts.useQuery(
    { productId: productId ?? 0, limit: 10 },
    { enabled: !!productId },
  );
  const decideDraft = trpc.catalog.decideContentDraft.useMutation({
    onSuccess: () => draftsQuery.refetch(),
  });
  const saveDraft = trpc.catalog.saveContentDraft.useMutation({
    onSuccess: (result) => {
      setSavedDraftId(result.draftId);
      void draftsQuery.refetch();
    },
  });

  const generate = trpc.catalog.generateContentDraft.useMutation({
    onSuccess: (result) => {
      setDraft(result.draft);
      setValidation(result.validation);
      setNeedsValidation(false);
      setSourceFingerprint(factsFingerprint);
      setCacheHit(result.cacheHit);
      setSavedDraftId(null);
      setEdited({});
      if (productId && result.validation.ok) {
        saveDraft.mutate({
          productId,
          sourceFacts: facts,
          sourceFactsHash: result.cacheKey,
          content: {
            storeTitle: result.draft.seoTitle,
            seoTitle: result.draft.seoTitle,
            shortTitle: result.draft.shortTitle,
            posLabel: result.draft.posLabel,
            invoiceLabel: result.draft.invoiceLabel,
            marketingCopy: result.draft.marketingCopy,
            description: result.draft.description,
          },
          validation: result.validation,
          promptVersion: result.promptVersion,
          model: result.model,
        });
      }
    },
  });

  const visibleDraft = useMemo(() => {
    if (!draft) return null;
    return {
      ...draft,
      ...edited,
    } as AiProductDraft;
  }, [draft, edited]);

  function generateDraft(forceRefresh = false) {
    generate.mutate({ facts, forceRefresh });
  }

  const validate = trpc.catalog.validateContentDraft.useMutation();

  function updateField(field: DraftField, value: string) {
    setEdited((current) => ({ ...current, [field]: value }));
    setValidation(null);
    setNeedsValidation(true);
  }

  function validateDraft() {
    if (!visibleDraft) return;
    const requestFingerprint = factsFingerprint;
    validate.mutate(
      { facts, draft: visibleDraft },
      {
        onSuccess: (result) => {
          if (latestFactsFingerprint.current !== requestFingerprint) return;
          setValidation(result);
          setNeedsValidation(false);
        },
      },
    );
  }

  const draftIsStale = Boolean(draft && sourceFingerprint !== factsFingerprint);
  const generateError = generate.error ? describeAiError(generate.error) : null;
  const validateError = validate.error ? describeAiError(validate.error) : null;
  const saveDraftError = saveDraft.error
    ? describeAiError(saveDraft.error)
    : null;
  const decideDraftError = decideDraft.error
    ? describeAiError(decideDraft.error)
    : null;

  function applyDraft() {
    if (!visibleDraft || draftIsStale) return;
    onApply(visibleDraft);
  }

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
            يولّد مسودة من الحقول الحالية فقط. لن يُحفظ أي نص حتى تختاره
            وتطبّقه.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => generateDraft(Boolean(draft))}
          disabled={generate.isPending}
        >
          {generate.isPending ? (
            <Loader2 aria-hidden className="size-4 animate-spin" />
          ) : (
            <Sparkles aria-hidden className="size-4" />
          )}
          {generate.isPending
            ? "جارٍ التوليد…"
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
                  disabled={generate.isPending}
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

            <div className="grid gap-3 lg:grid-cols-2">
              {FIELD_ORDER.map((field) => {
                const value = visibleDraft[field];
                const manuallyEdited = edited[field] !== undefined;
                return (
                  <div
                    key={field}
                    className="space-y-1.5 rounded-md border bg-background/80 p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <label
                        htmlFor={`ai-content-${field}`}
                        className="text-sm font-semibold"
                      >
                        {FIELD_LABELS[field]}
                      </label>
                      {manuallyEdited && (
                        <Badge variant="outline" className="text-[10px]">
                          تعديل يدوي
                        </Badge>
                      )}
                    </div>
                    <Textarea
                      id={`ai-content-${field}`}
                      rows={
                        field === "description" || field === "marketingCopy"
                          ? 3
                          : 2
                      }
                      value={value}
                      onChange={(event) =>
                        updateField(field, event.target.value)
                      }
                      placeholder={FIELD_HINTS[field]}
                      maxLength={
                        field === "description"
                          ? 2_000
                          : field === "marketingCopy"
                            ? 300
                            : 160
                      }
                    />
                    <p className="text-[11px] text-muted-foreground">
                      {FIELD_HINTS[field]}
                    </p>
                  </div>
                );
              })}
            </div>

            {productId && (draftsQuery.data?.length ?? 0) > 0 && (
              <div className="rounded-md border bg-background/80 p-3">
                <p className="mb-2 text-sm font-semibold">تاريخ المسودات</p>
                <div className="space-y-2">
                  {draftsQuery.data?.map((saved) => (
                    <div
                      key={saved.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-2 text-xs"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant={
                            saved.status === "APPROVED" ? "default" : "outline"
                          }
                        >
                          {saved.status}
                        </Badge>
                        <span>#{saved.id}</span>
                        <span className="text-muted-foreground">
                          {saved.validation.ok
                            ? "اجتازت التحقق"
                            : "تحتاج مراجعة"}
                        </span>
                      </div>
                      {saved.status === "DRAFT" && (
                        <div className="flex gap-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={decideDraft.isPending}
                            onClick={() =>
                              decideDraft.mutate({
                                draftId: Number(saved.id),
                                decision: "REJECTED",
                                note: "رُفضت من شاشة مراجعة المنتج.",
                              })
                            }
                          >
                            رفض
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            disabled={
                              decideDraft.isPending || !saved.validation.ok
                            }
                            onClick={() =>
                              decideDraft.mutate({
                                draftId: Number(saved.id),
                                decision: "APPROVED",
                                note: "اعتماد مسودة من شاشة مراجعة المنتج.",
                              })
                            }
                          >
                            اعتماد
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {visibleDraft.keywords.length > 0 && (
              <div className="rounded-md border bg-background/80 p-3">
                <p className="mb-2 text-sm font-semibold">
                  كلمات البحث المقترحة
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {visibleDraft.keywords.map((keyword) => (
                    <Badge key={keyword} variant="secondary">
                      {keyword}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {visibleDraft.unsupportedClaims.length > 0 && (
              <div className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]/70 px-3 py-2 text-xs text-[var(--sem-warn)]">
                <p className="font-semibold">عبارات لم يعتمدها النظام</p>
                <ul className="mt-1 list-disc space-y-1 pe-5">
                  {visibleDraft.unsupportedClaims.map((item) => (
                    <li key={`${item.text}-${item.reason}`}>
                      {item.text}: {item.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {needsValidation && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-blue-300/70 bg-blue-50/70 px-3 py-2 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/20 dark:text-blue-300">
                <span>تم تعديل المسودة؛ أعد التحقق قبل اعتمادها.</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={validateDraft}
                  disabled={validate.isPending}
                >
                  {validate.isPending ? "جارٍ التحقق…" : "إعادة التحقق"}
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
                <p className="font-semibold">
                  تم توليد المسودة لكن تعذر حفظ سجلها
                </p>
                <p>{saveDraftError.message}</p>
              </div>
            )}

            {decideDraftError && (
              <div
                role="alert"
                aria-live="assertive"
                className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
              >
                <p className="font-semibold">تعذر تحديث قرار المسودة</p>
                <p>{decideDraftError.message}</p>
              </div>
            )}

            {(validation?.blockers?.length ?? 0) > 0 && (
              <div
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
              >
                لا يمكن اعتماد المسودة قبل إصلاح:{" "}
                {validation?.blockers.join("؛ ")}
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
              <Button
                type="button"
                onClick={applyDraft}
                disabled={
                  draftIsStale ||
                  needsValidation ||
                  (validation != null && !validation.ok)
                }
              >
                تطبيق المسودة على النموذج
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
