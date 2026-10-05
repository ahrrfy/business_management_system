/**
 * رؤى أسعار سطور البيع لعميلٍ مُسمّى — جلبٌ واحدٌ مُجمَّع لكل الأسطر (لا استعلامَ لكل صفّ).
 *
 * يعيش هنا لا في صفحة البيع: صفحة `SalesInvoiceNew` فوق سقف الأسطر (`check:page-size`) فلا تُنفَخ،
 * و`ProductTable` هو الذي يعرض التلميحات فيستدعيه مباشرةً.
 *
 * ⚠️ `settled` مقصود: بعد إضافة سطرٍ جديد يبقى الجواب القديم (نفس العميل) ظاهراً أثناء جلب الجديد،
 * لكن الصنف المُضاف حديثاً بلا مفتاحٍ فيه — لا يجوز أن نقرأ غيابه «لم يشترِه سابقاً» قبل أن يصل
 * جوابٌ يخصّه فعلاً. المستهلك يقرأ الغياب كـ«أول بيع» **فقط** حين `settled`.
 */
import { useMemo, useRef } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import type { SaleLineInsight } from "@shared/priceAlerts";
import { trpc } from "@/lib/trpc";
import type { InvoiceLine } from "./types";

/** سقف الإجراء الخادميّ (`sales.lineInsights`): يُقصّ هنا بدل أن يُرفَض الطلب كاملاً. */
const MAX_LINES = 200;

export const saleInsightKey = (variantId: number, productUnitId: number) => `${variantId}:${productUnitId}`;

export function useSaleLineInsights(args: {
  enabled: boolean;
  customerId: number | null | undefined;
  items: readonly InvoiceLine[];
  /** فاتورةٌ قيد التصحيح — تُستثنى من «آخر بيع» كي لا تُقارَن بنفسها. */
  excludeInvoiceId?: number | null;
}): { insights: Record<string, SaleLineInsight> | null; settled: boolean } {
  const { enabled, customerId, items, excludeInvoiceId } = args;
  const customer = customerId != null && customerId > 0 ? customerId : null;

  // توقيعٌ ثابتٌ لمجموعة (صنف × وحدة): الكميّة/السعر لا تُعيد الجلب — المعرّفات وحدها.
  const signature = useMemo(() => {
    const keys = new Set<string>();
    for (const it of items) {
      if (it.digital || it.isGift) continue;
      keys.add(saleInsightKey(it.variantId, it.productUnitId));
    }
    return Array.from(keys).sort().slice(0, MAX_LINES).join("|");
  }, [items]);
  const pairs = useMemo(
    () =>
      signature === ""
        ? []
        : signature.split("|").map((k) => {
            const [variantId, productUnitId] = k.split(":").map(Number);
            return { variantId, productUnitId };
          }),
    [signature],
  );

  const query = trpc.sales.lineInsights.useQuery(
    {
      customerId: customer ?? 1,
      items: pairs.length > 0 ? pairs : [{ variantId: 1, productUnitId: 1 }],
      ...(excludeInvoiceId != null && excludeInvoiceId > 0 ? { excludeInvoiceId } : {}),
    },
    {
      enabled: enabled && customer != null && pairs.length > 0,
      staleTime: 60_000,
      retry: false,
      refetchOnWindowFocus: false,
      placeholderData: keepPreviousData,
    },
  );

  // آخر جوابٍ طازج لكل عميل — كي لا يُعرَض جوابُ عميلٍ سابقٍ لعميلٍ جديد.
  const lastFresh = useRef<{ customerId: number; excludeId: number | null; data: Record<string, SaleLineInsight> } | null>(null);
  const fresh = customer != null && query.data && !query.isPlaceholderData ? query.data : null;
  const excludeId = excludeInvoiceId != null && excludeInvoiceId > 0 ? excludeInvoiceId : null;
  if (fresh && customer != null) lastFresh.current = { customerId: customer, excludeId, data: fresh };

  if (!enabled || customer == null) return { insights: null, settled: false };
  if (fresh) return { insights: fresh, settled: true };
  const stash = lastFresh.current;
  return stash && stash.customerId === customer && stash.excludeId === excludeId
    ? { insights: stash.data, settled: false }
    : { insights: null, settled: false };
}
