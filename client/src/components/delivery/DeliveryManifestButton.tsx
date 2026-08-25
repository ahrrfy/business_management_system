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
      refetchInterval: 30_000,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );
  useEffect(() => {
    if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  }, [q.hasNextPage, q.isFetchingNextPage, q.fetchNextPage]);
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
  const rows = onlyConsignmentIds && onlyConsignmentIds.length > 0
    ? handoverRows.filter((r) => onlyConsignmentIds.includes(Number(r.id)))
    : handoverRows;
  const count = rows.length;

  const disabled = q.isLoading || stillLoading || count === 0;

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={disabled}
      className={cn(className)}
      title={stillLoading ? "جارٍ تحميل قائمة الطرود…" : count === 0 ? "لا طرود مفتوحة لطباعة محضر" : undefined}
      onClick={() => {
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
      محضر تسليم ({stillLoading ? "…" : count})
    </Button>
  );
}
