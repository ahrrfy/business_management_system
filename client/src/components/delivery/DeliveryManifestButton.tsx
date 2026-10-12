/**
 * **زر محضر تسليم الطرود** (٢٢/٨) — الأداة التي كانت مفقودة لطباعة مستندٍ يوقّعه مستلم الشركة
 * بمجموع الطرود وأرقامها. بلا هذا: كشف الشركة يصل بعد أسبوع، وأيّ خلافٍ على «كم طرداً استلمنا»
 * بلا خطّ أساسٍ موقَّع.
 *
 * البيانات كلّها موجودة (`inTransit` يقبل partyId)؛ الفجوة عرضٌ فحسب.
 */
import { useEffect } from "react";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { printDeliveryManifest } from "@/lib/printing/deliveryDocs";
import { cn } from "@/lib/utils";
import { manifestCanPrint } from "@/lib/deliveryOperations";

export interface DeliveryManifestButtonProps {
  partyId: number;
  partyName: string;
  branchName?: string | null;
  /** فلترة اختيارية: إن مُرِّرت، تُطبع فقط الطرود ذات هذه الأرقام (تحديد جماعي في الشاشة). */
  onlyConsignmentIds?: number[];
  variant?: "outline" | "default";
  size?: "sm" | "default";
  className?: string;
}

export function DeliveryManifestButton({
  partyId,
  partyName,
  branchName,
  onlyConsignmentIds,
  variant = "outline",
  size = "sm",
  className,
}: DeliveryManifestButtonProps) {
  /**
   * Codex P1 #3 (٢٥/٨): المحضرُ سندُ عهدةٍ يوقّعه المندوب — لا نقبل أن يُخفي الترقيمُ طرداً
   * فيوقّع على عهدةٍ ناقصة. نجلب كلّ الصفحات (٥٠٠ لكل نداء) قبل تمكين الزرّ.
   */
  const q = trpc.delivery.inTransit.useInfiniteQuery(
    { partyId, limit: 500 },
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );
  useEffect(() => {
    if (q.hasNextPage && !q.isFetchingNextPage&& !q.isError) void q.fetchNextPage();
  }, [q.hasNextPage, q.isFetchingNextPage, q.isError, q.fetchNextPage]);
  const stillLoading = q.hasNextPage || q.isFetchingNextPage;
  /**
   * **فلترة المحضر لطرود التسليم الفعليّ فقط** (Codex P1 #6 — ٢٢/٨): `inTransit` يُعيد كلّ
   * `consignmentStatus=DISPATCHED` — بما فيها المُسلَّمة (بانتظار التوريد) والمفشولة والمرتجعة
   * المُعلَنة. المحضرُ مستندٌ يوقّعه المندوبُ باستلامٍ حاليّ للتوصيل، فإدراجُ طرودٍ مُسلَّمةٍ
   * سلفاً يُنتج إقرارَ عهدةٍ كاذبة. نقصر السطور على الطرود القابلة للتسليم فعلاً
   * (`ASSIGNED`/`ACCEPTED`/`PICKED_UP`/`OUT_FOR_DELIVERY`) ونستثني ما أُعلن رجوعُه.
   */
  const HANDOVER_ELIGIBLE = new Set(["ASSIGNED", "ACCEPTED", "PICKED_UP", "OUT_FOR_DELIVERY"]);
  const allRows = (q.data?.pages ?? []).flatMap((p) => p.rows);
  const handoverRows = allRows.filter((r) =>
    HANDOVER_ELIGIBLE.has(r.parcelStatus ?? "") && r.returnDeclaredAt == null,
  );
  const rows = onlyConsignmentIds ? handoverRows.filter((r) => onlyConsignmentIds.includes(Number(r.id)))
    : handoverRows;
  const count = rows.length;

  const disabled = !manifestCanPrint({
    isLoading: q.isLoading ,
    isFetching: q.isFetching,
    isError: q.isError,
    hasNextPage: !!q.hasNextPage,
    requestedIds: onlyConsignmentIds,
    availableIds: handoverRows.map((row) => Number(row.id)),
  });
  const incompleteSelection = onlyConsignmentIds?.some(
    (id) => !handoverRows.some((row) => Number(row.id) === id),
  );

  return (
    <>
      <Button
      type="button"
      variant={variant}
      size={size}
      disabled={disabled}
      className={cn(className)}
      title={q.isError
            ? "تعذر تحميل المحضر كاملاً؛ أعد المحاولة قبل الطباعة"
            : stillLoading || q.isFetching
              ? "تحميل قائمة الطرود كاملة…"
              : incompleteSelection
                ? "بعض الطرود المحددة غير متاحة للتسليم؛ راجع التحديد"
                : count === 0 ? "لا طرود مفتوحة لطباعة محضر" : undefined}
      onClick={() => {
        if (disabled) return;
          printDeliveryManifest(
          { name: partyName },
          rows.map((r) => ({
            consignmentNumber: r.consignmentNumber,
            invoiceNumber: r.invoiceNumber,
            orderNumber: r.orderNumber ?? null,
            recipientName: r.recipientName ?? r.customerName ?? null,
            recipientPhone: r.recipientPhone ?? null,
            address: r.address ?? null,
            codAmount: r.codAmount,
            // Codex P2 #7 (٢٢/٨): كان `null` يطبع «مجموع الأجور 0» على مستندٍ يوقّعه المندوب —
            // خطُّ أساسٍ ماليٌّ كاذبٌ في نزاعِ التسوية. الآن نُمرِّر الأجرة الفعليّة من الاستعلام.
            deliveryFee: (r as { deliveryFee?: string | null }).deliveryFee ?? null,
          })),
          branchName ?? null,
        );
      }}
    >
      <FileText aria-hidden className="size-3.5" />
      محضر تسليم مادي ({q.isError ? "تعذر التحميل" : stillLoading ? "…" : count})
    </Button>
  {q.isError && (
        <Button
          type="button"
          variant="outline"
          size={size}
          disabled={q.isFetching}
          onClick={() => void q.refetch()}
        >
          إعادة تحميل المحضر
        </Button>
      )}
    </>
  );
}
