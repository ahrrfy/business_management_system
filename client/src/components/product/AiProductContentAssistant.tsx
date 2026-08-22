import { AlertTriangle, CheckCircle2, Loader2, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import type { AiProductDraft, DraftValidation, ProductFacts } from "@shared/productContentAi";

type DraftField = keyof Pick<AiProductDraft, "seoTitle" | "shortTitle" | "posLabel" | "invoiceLabel" | "marketingCopy" | "description">;

type Props = {
  facts: ProductFacts;
  onApply: (draft: AiProductDraft) => void;
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

const FIELD_ORDER: DraftField[] = ["seoTitle", "shortTitle", "posLabel", "invoiceLabel", "marketingCopy", "description"];

export function AiProductContentAssistant({ facts, onApply }: Props) {
  const [draft, setDraft] = useState<AiProductDraft | null>(null);
  const [validation, setValidation] = useState<DraftValidation | null>(null);
  const [needsValidation, setNeedsValidation] = useState(false);
  const [cacheHit, setCacheHit] = useState(false);
  const [edited, setEdited] = useState<Partial<Record<DraftField, string>>>({});
  const generate = trpc.catalog.generateContentDraft.useMutation({
    onSuccess: (result) => {
      setDraft(result.draft);
      setValidation(result.validation);
      setNeedsValidation(false);
      setCacheHit(result.cacheHit);
      setEdited({});
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

  const validate = trpc.catalog.validateContentDraft.useMutation({
    onSuccess: (result) => {
      setValidation(result);
      setNeedsValidation(false);
    },
  });

  function updateField(field: DraftField, value: string) {
    setEdited((current) => ({ ...current, [field]: value }));
    setValidation(null);
    setNeedsValidation(true);
  }

  function validateDraft() {
    if (!visibleDraft) return;
    validate.mutate({ facts, draft: visibleDraft });
  }

  function applyDraft() {
    if (!visibleDraft) return;
    onApply(visibleDraft);
  }

  return (
    <Card dir="rtl" className="border-violet-200/70 bg-violet-50/30 dark:border-violet-900/60 dark:bg-violet-950/10">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles aria-hidden className="size-4 text-violet-600" />
            مساعد محتوى المنتج
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            يولّد مسودة من الحقول الحالية فقط. لن يُحفظ أي نص حتى تختاره وتطبّقه.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => generateDraft(Boolean(draft))} disabled={generate.isPending}>
          {generate.isPending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Sparkles aria-hidden className="size-4" />}
          {generate.isPending ? "جارٍ التوليد…" : draft ? "توليد نسخة جديدة" : "اقتراح المحتوى"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {generate.error && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>{generate.error.message}</span>
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
              <span>المحتوى يحتاج مراجعة قبل التطبيق.</span>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              {FIELD_ORDER.map((field) => {
                const value = visibleDraft[field];
                const manuallyEdited = edited[field] !== undefined;
                return (
                  <div key={field} className="space-y-1.5 rounded-md border bg-background/80 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <label htmlFor={`ai-content-${field}`} className="text-sm font-semibold">{FIELD_LABELS[field]}</label>
                      {manuallyEdited && <Badge variant="outline" className="text-[10px]">تعديل يدوي</Badge>}
                    </div>
                    <Textarea
                      id={`ai-content-${field}`}
                      rows={field === "description" || field === "marketingCopy" ? 3 : 2}
                      value={value}
                      onChange={(event) => updateField(field, event.target.value)}
                      placeholder={FIELD_HINTS[field]}
                      maxLength={field === "description" ? 2_000 : field === "marketingCopy" ? 300 : 160}
                    />
                    <p className="text-[11px] text-muted-foreground">{FIELD_HINTS[field]}</p>
                  </div>
                );
              })}
            </div>

            {visibleDraft.keywords.length > 0 && (
              <div className="rounded-md border bg-background/80 p-3">
                <p className="mb-2 text-sm font-semibold">كلمات البحث المقترحة</p>
                <div className="flex flex-wrap gap-1.5">
                  {visibleDraft.keywords.map((keyword) => <Badge key={keyword} variant="secondary">{keyword}</Badge>)}
                </div>
              </div>
            )}

            {visibleDraft.unsupportedClaims.length > 0 && (
              <div className="rounded-md border border-amber-300/70 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300">
                <p className="font-semibold">عبارات لم يعتمدها النظام</p>
                <ul className="mt-1 list-disc space-y-1 pe-5">
                  {visibleDraft.unsupportedClaims.map((item) => <li key={`${item.text}-${item.reason}`}>{item.text}: {item.reason}</li>)}
                </ul>
              </div>
            )}

            {needsValidation && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-blue-300/70 bg-blue-50/70 px-3 py-2 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/20 dark:text-blue-300">
                <span>تم تعديل المسودة؛ أعد التحقق قبل اعتمادها.</span>
                <Button type="button" variant="outline" size="sm" onClick={validateDraft} disabled={validate.isPending}>
                  {validate.isPending ? "جارٍ التحقق…" : "إعادة التحقق"}
                </Button>
              </div>
            )}

            {validate.error && (
              <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{validate.error.message}</div>
            )}

            {(validation?.blockers?.length ?? 0) > 0 && (
              <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                لا يمكن اعتماد المسودة قبل إصلاح: {validation?.blockers.join("؛ ")}
              </div>
            )}

            {(validation?.warnings.length ?? 0) > 0 && (
              <div className="rounded-md border border-amber-300/70 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300">
                <p className="font-semibold">ملاحظات المراجعة</p>
                <ul className="mt-1 list-disc space-y-1 pe-5">{(validation?.warnings ?? []).map((warning) => <li key={warning}>{warning}</li>)}</ul>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <CheckCircle2 aria-hidden className="size-4 text-emerald-600" />
                الثقة: {visibleDraft.confidence === "high" ? "مرتفعة" : visibleDraft.confidence === "medium" ? "متوسطة" : "منخفضة"}
              </div>
              <Button type="button" onClick={applyDraft} disabled={needsValidation || (validation != null && !validation.ok)}>
                تطبيق المسودة على النموذج
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
