/**
 * **زر محضر تسليم الطرود** (٢٢/٨) — الأداة التي كانت مفقودة لطباعة مستندٍ يوقّعه مستلم الشركة
 * بمجموع الطرود وأرقامها. بلا هذا: كشف الشركة يصل بعد أسبوع، وأيّ خلافٍ على «كم طرداً استلمنا»
 * بلا خطّ أساسٍ موقَّع.
 *
 * البيانات كلّها موجودة (`inTransit` يقبل partyId)؛ الفجوة عرضٌ فحسب.
 */
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
  const q = trpc.delivery.inTransit.useQuery({ partyId }, { refetchInterval: 30_000 });
  const allRows = q.data ?? [];
  const rows = onlyConsignmentIds && onlyConsignmentIds.length > 0
    ? allRows.filter((r) => onlyConsignmentIds.includes(Number(r.id)))
    : allRows;
  const count = rows.length;

  const disabled = q.isLoading || count === 0;

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={disabled}
      className={cn(className)}
      title={count === 0 ? "لا طرود مفتوحة لطباعة محضر" : undefined}
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
            deliveryFee: null,
          })),
          branchName ?? null,
        );
      }}
    >
      <FileText aria-hidden className="size-3.5" />
      محضر تسليم ({count})
    </Button>
  );
}
