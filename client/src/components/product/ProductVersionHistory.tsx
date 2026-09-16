/**
 * ProductVersionHistory — لوحةُ «السجلّ» في شاشة المنتج (م٦ ق٨): النسخ (مَن/متى/السبب/الحقول
 * المتغيّرة)، و«ما الذي تغيّر» حقلاً بحقل (قديم ⇒ جديد)، وزرّ «استعادة هذه النسخة».
 *
 * دلالةُ النسخة N: حالةُ المنتج **قبل** التعديل N. فاستعادتُها = التراجع عن التعديل N وما بعده،
 * بتعديلٍ جديد يمرّ بكلّ حرّاس التعديل (التكلفة على صنفٍ له رصيد تُرفض — الاستعادة لا تملك سلطةً
 * أوسع من التعديل)، وتُكتب الحالةُ الحاليّة نسخةً جديدة فتبقى الاستعادةُ نفسُها قابلةً للتراجع.
 *
 * النتيجة **مُهيكَلة** (`SaveOutcome`) بنفس شكل شريط الحفظ — لا توستٌ يختفي: الرفضُ يبقى معروضاً
 * بسببه («ماذا حدث · لماذا · ماذا تفعل») حتى المحاولة التالية.
 *
 * الأرقام لاتينية (لا `toLocaleString("ar-…")`)، ولا تشكيل في الشارات (حارس `check:tashkeel`).
 */
import { ChevronDown, ChevronUp, History, RotateCcw } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SaveOutcomeNotice } from "@/components/form/SaveOutcomeNotice";
import { deriveSaveOutcome, type SaveOutcome } from "@/components/form/saveOutcome";
import { confirm } from "@/lib/confirm";
import { fmtDateTime } from "@/lib/date";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { ACTION_LABELS } from "@shared/actionLabels";
import { displayChangeValue } from "@shared/productVersionDiff";

type VersionRow = RouterOutputs["catalog"]["productVersions"][number];

export function ProductVersionHistory({
  productId,
  onRestored,
  className,
}: {
  productId: number;
  /** بعد استعادةٍ ناجحة — الشاشةُ تُعيد تعبئة النموذج من الخادم. */
  onRestored?: (result: RouterOutputs["catalog"]["restoreProductVersion"]) => void;
  className?: string;
}) {
  const utils = trpc.useUtils();
  const versionsQ = trpc.catalog.productVersions.useQuery({ productId, limit: 50 }, { enabled: productId > 0 });
  const [open, setOpen] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const restore = trpc.catalog.restoreProductVersion.useMutation();

  async function restoreVersion(v: VersionRow) {
    const ok = await confirm({
      variant: "warning",
      title: `استعادة النسخة ${v.versionNumber}؟`,
      description:
        "ستُطبَّق قيم هذه النسخة على المنتج بتعديلٍ جديد يمرّ بكل حرّاس التعديل، وتُحفظ الحالة الحالية نسخةً جديدة يمكن الرجوع إليها. الصور لا تتأثّر.",
      confirmText: "استعادة",
      cancelText: ACTION_LABELS.cancel,
    });
    if (!ok) return;
    let next: SaveOutcome;
    try {
      const res = await restore.mutateAsync({ productId, versionNumber: v.versionNumber });
      next = deriveSaveOutcome({ result: res, savedMessage: `استُعيدت النسخة ${v.versionNumber} — وحُفظت الحالة السابقة نسخةً ${res.versionNumber ?? ""}`.trim() });
      await Promise.all([
        utils.catalog.productVersions.invalidate({ productId }),
        utils.catalog.getForVariantEdit.invalidate({ productId }),
        utils.catalog.posList.invalidate(),
        utils.catalog.adminList.invalidate(),
        utils.catalog.forPurchase.invalidate(),
        utils.printPos.services.invalidate(),
      ]);
      setOpen(null);
      onRestored?.(res);
    } catch (error) {
      next = deriveSaveOutcome({ error });
    }
    setOutcome(next);
  }

  const versions = versionsQ.data ?? [];

  return (
    <Card className={className} data-slot="product-version-history">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History aria-hidden className="size-4" />
          السجل — النسخ والاستعادة
        </CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          كل حفظ يحفظ الحالة السابقة نسخةً كاملة. «استعادة» تُعيد قيم النسخة بتعديلٍ جديد يمرّ بكل الحرّاس، ولا تمحو التاريخ.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <SaveOutcomeNotice outcome={outcome} />

        {versionsQ.isLoading ? (
          <p className="text-sm text-muted-foreground">{ACTION_LABELS.loading}</p>
        ) : versionsQ.isError ? (
          <div role="alert" className="rounded-md border border-[var(--sem-neg)]/30 bg-[var(--sem-neg-bg)] px-3 py-2 text-sm text-[var(--sem-neg)]">
            تعذّر تحميل السجل: {versionsQ.error.message}
            <Button type="button" variant="outline" size="sm" className="ms-2" onClick={() => versionsQ.refetch()}>
              {ACTION_LABELS.retry}
            </Button>
          </div>
        ) : versions.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
            لا نسخ بعد — أول حفظ لهذا المنتج سيحفظ حالته الحالية نسخةً.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {versions.map((v) => (
              <VersionItem
                key={v.id}
                productId={productId}
                version={v}
                open={open === v.versionNumber}
                onToggle={() => setOpen((cur) => (cur === v.versionNumber ? null : v.versionNumber))}
                onRestore={() => void restoreVersion(v)}
                restoring={restore.isPending}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function VersionItem({
  productId,
  version: v,
  open,
  onToggle,
  onRestore,
  restoring,
}: {
  productId: number;
  version: VersionRow;
  open: boolean;
  onToggle: () => void;
  onRestore: () => void;
  restoring: boolean;
}) {
  const diffQ = trpc.catalog.productVersionDiff.useQuery(
    { productId, versionNumber: v.versionNumber },
    { enabled: open, staleTime: 30_000 },
  );
  const Chevron = open ? ChevronUp : ChevronDown;
  return (
    <li className="p-3">
      <div className="flex flex-wrap items-start gap-2">
        <Badge variant="outline" className="tabular-nums" dir="ltr">
          #{v.versionNumber}
        </Badge>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="font-medium">{v.reason ?? "تعديل"}</span>
            <span className="text-xs text-muted-foreground" dir="ltr">{fmtDateTime(v.createdAt)}</span>
            <span className="text-xs text-muted-foreground">بواسطة {v.actorName ?? `المستخدم #${v.actorUserId}`}</span>
          </div>
          {v.changedFields.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {v.changedFields.slice(0, 8).map((label) => (
                <Badge key={label} variant="secondary" className="font-normal">
                  {label}
                </Badge>
              ))}
              {v.changedFields.length > 8 && (
                <Badge variant="neutral" className="font-normal tabular-nums">
                  +{v.changedFields.length - 8}
                </Badge>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {v.comparedTo === "current" ? "مطابقة للحالة الحالية" : "لا فرق مرصود مع النسخة التالية"}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={onToggle} aria-expanded={open}>
            <Chevron aria-hidden className="size-4" />
            ما الذي تغيّر
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onRestore} disabled={restoring} title="تُطبَّق قيم هذه النسخة بتعديلٍ جديد يمرّ بكل الحرّاس">
            <RotateCcw aria-hidden className="size-4" />
            استعادة هذه النسخة
          </Button>
        </div>
      </div>

      {open && (
        <div className="mt-3 rounded-md border bg-muted/20">
          <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 border-b px-3 py-1.5 text-xs font-semibold text-muted-foreground">
            <span>الحقل</span>
            <span>قبل</span>
            <span>بعد</span>
          </div>
          {diffQ.isLoading ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">{ACTION_LABELS.loading}</p>
          ) : diffQ.isError ? (
            <p role="alert" className="px-3 py-3 text-sm text-[var(--sem-neg)]">تعذّر تحميل الفرق: {diffQ.error.message}</p>
          ) : (diffQ.data?.changes ?? []).length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">لا فرق بين هذه النسخة وما بعدها.</p>
          ) : (
            <ul className="divide-y">
              {(diffQ.data?.changes ?? []).map((c) => (
                <li key={c.path} className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 px-3 py-1.5 text-sm">
                  <span className="min-w-0 break-words">{c.label}</span>
                  <span className={cn("min-w-0 break-words tabular-nums", c.before === null && "text-muted-foreground")} dir="auto">
                    {displayChangeValue(c.before)}
                  </span>
                  <span className={cn("min-w-0 break-words font-medium tabular-nums", c.after === null && "text-muted-foreground")} dir="auto">
                    {displayChangeValue(c.after)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {diffQ.data && (
            <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">
              المقارنة مع {diffQ.data.comparedTo === "current" ? "الحالة الحالية" : `النسخة #${diffQ.data.comparedToVersion}`}.
            </p>
          )}
        </div>
      )}
    </li>
  );
}
