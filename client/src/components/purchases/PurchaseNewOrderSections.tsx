import { useEffect, useRef, type Dispatch } from "react";
import { ClipboardList } from "lucide-react";
import { Button } from "@/components/ui/button";
import { D, fmtAr } from "@/lib/money";
import { notify } from "@/lib/notify";
import type { RouterOutputs } from "@/lib/trpc";
import { variantDisplayName } from "@shared/variantDisplay";
import { derivePurchaseLinePriceFromRequisition } from "@/components/invoice/purchasePrice";
import type { InvoiceAction, InvoiceLine } from "@/components/invoice";

type CatalogPurchaseRow = RouterOutputs["catalog"]["forPurchase"][number];
type RequisitionOutput = RouterOutputs["purchases"]["requisition"];

function buildHydratedLine(
  row: CatalogPurchaseRow,
  branchId: number,
  qty: number,
  price: string,
  note: string,
): InvoiceLine {
  const conversionFactor = String(row.conversionFactor || "1");
  return {
    productId: Number(row.productId),
    variantId: Number(row.variantId),
    productUnitId: Number(row.productUnitId),
    name: variantDisplayName({
      productName: row.productName,
      variantName: row.variantName,
      color: row.color,
      size: row.size,
      sku: row.sku,
    }),
    sku: row.sku ?? "",
    barcode: null,
    unit: row.unitName ?? "",
    qty,
    conversionFactor,
    stockBase: row.stockBase ?? 0,
    stockBranchId: branchId,
    reservedBase: 0,
    availableBase: row.stockBase ?? 0,
    isService: false,
    price,
    costBase: row.costPriceBase ?? "0",
    discount: "0",
    discountType: "percent",
    note,
  };
}

export function usePurchaseNewHydrationEffects({
  requisitionId,
  requisitionData,
  requisitionUnitIds,
  requisitionCatalogData,
  prefillVariantIds,
  purchasableCatalogData,
  branchId,
  autoReason,
  prefillKey,
  dispatch,
}: {
  requisitionId: number | null;
  requisitionData: RequisitionOutput | null | undefined;
  requisitionUnitIds: number[];
  requisitionCatalogData: CatalogPurchaseRow[] | null | undefined;
  prefillVariantIds: number[];
  purchasableCatalogData: CatalogPurchaseRow[] | null | undefined;
  branchId: number;
  autoReason: string | null;
  prefillKey: string | null;
  dispatch: Dispatch<InvoiceAction>;
}) {
  const requisitionHydratedRef = useRef(false);
  useEffect(() => {
    if (!requisitionId || requisitionHydratedRef.current || !requisitionData) return;
    if (requisitionUnitIds.length > 0 && !requisitionCatalogData) return;
    if (!["APPROVED", "PARTIALLY_ORDERED"].includes(requisitionData.status)) {
      notify.warn("لا يمكن تحويل طلب الشراء قبل اعتماده أو بعد إقفاله بالكامل.");
      requisitionHydratedRef.current = true;
      return;
    }
    const catalogByUnit = new Map(
      (requisitionCatalogData ?? []).map((row) => [Number(row.productUnitId), row]),
    );
    const missingUnits: number[] = [];
    const reqBranchId = Number(requisitionData.branchId);
    const lines = requisitionData.items.flatMap((item): InvoiceLine[] => {
      const availableBase = D(item.approvedBaseQuantity).minus(D(item.orderedBaseQuantity));
      if (availableBase.lte(0)) return [];
      const row = catalogByUnit.get(Number(item.productUnitId));
      if (!row) {
        missingUnits.push(Number(item.productUnitId));
        return [];
      }
      const conversionFactor = String(row.conversionFactor || "1");
      return [
        buildHydratedLine(
          row,
          reqBranchId,
          availableBase.dividedBy(D(conversionFactor)).toNumber(),
          derivePurchaseLinePriceFromRequisition(
            item.estimatedUnitPrice,
            row.costPriceBase,
            conversionFactor,
          ),
          item.justification ?? "",
        ),
      ];
    });
    dispatch({ type: "SET_FIELD", field: "branchId", value: reqBranchId });
    const preferredSupplierIds = Array.from(
      new Set(
        requisitionData.items
          .map((item) => item.preferredSupplierId)
          .filter((id): id is number => id != null)
          .map(Number),
      ),
    );
    if (preferredSupplierIds.length === 1) {
      dispatch({ type: "SET_ENTITY", id: preferredSupplierIds[0] });
    }
    dispatch({
      type: "SET_FIELD",
      field: "notes",
      value: `تحويل من طلب الشراء ${requisitionData.requisitionNumber}: ${requisitionData.purpose}`,
    });
    if (lines.length) dispatch({ type: "ADD_ITEMS", items: lines });
    if (missingUnits.length > 0) {
      notify.warn(
        "تعذّر تحميل بعض سطور طلب الشراء",
        `تُخطِّي ${missingUnits.length} سطر من الطلب لأن الصنف أو وحدته معطّل أو غير قابل للشراء (الوحدات: ${missingUnits.map((id) => `#${id}`).join("، ")}).`,
      );
    }
    requisitionHydratedRef.current = true;
  }, [requisitionId, requisitionData, requisitionCatalogData, requisitionUnitIds, dispatch]);

  const prefillHydratedRef = useRef(false);
  useEffect(() => {
    if (prefillHydratedRef.current || prefillVariantIds.length === 0 || !purchasableCatalogData) {
      return;
    }
    const variantIdSet = new Set(prefillVariantIds);
    const matchedRows = new Map<number, CatalogPurchaseRow>();
    for (const row of purchasableCatalogData) {
      if (variantIdSet.has(Number(row.variantId))) {
        if (!matchedRows.has(Number(row.variantId)) || row.isBaseUnit) {
          matchedRows.set(Number(row.variantId), row);
        }
      }
    }
    const lines: InvoiceLine[] = Array.from(matchedRows.values()).map((row) =>
      buildHydratedLine(
        row,
        branchId,
        1,
        derivePurchaseLinePriceFromRequisition(
          null,
          row.costPriceBase,
          String(row.conversionFactor || "1"),
        ),
        autoReason === "low_stock" ? "نواقص مخزون بحاجة لتأمين" : "",
      ),
    );
    if (lines.length > 0) {
      dispatch({ type: "ADD_ITEMS", items: lines });
      notify.ok(`تم إدراج ${lines.length} صنف من نواقص المخزون تلقائياً في مسودة الشراء`);
      if (prefillKey) {
        try {
          sessionStorage.removeItem(prefillKey);
        } catch {}
      }
    }
    prefillHydratedRef.current = true;
  }, [prefillVariantIds, purchasableCatalogData, branchId, autoReason, prefillKey, dispatch]);
}

export function PurchaseNewSidebarCards({
  currency,
  grandTotal,
  agreedRate,
  landedGrand,
  hasLandedRate,
  hasEntityId,
  hasItems,
  canCreateRequisition,
  isAnySaving,
  onSaveRequisition,
}: {
  currency: string;
  grandTotal: string;
  agreedRate: string;
  landedGrand: string;
  hasLandedRate: boolean;
  hasEntityId: boolean;
  hasItems: boolean;
  canCreateRequisition: boolean;
  isAnySaving: boolean;
  onSaveRequisition: () => void;
}) {
  return (
    <>
      {currency === "USD" && hasLandedRate && (
        <section className="rounded-lg border bg-card px-3 py-2 text-xs">
          <div className="flex justify-between text-muted-foreground">
            <span>إجمالي فاتورة المورد (دولار)</span>
            <span dir="ltr" className="font-bold text-foreground">
              {fmtAr(grandTotal)} $
            </span>
          </div>
          <div className="mt-1 flex justify-between text-muted-foreground">
            <span>سعر التثبيت</span>
            <span dir="ltr" className="font-bold text-foreground">
              {fmtAr(agreedRate)} د.ع/$
            </span>
          </div>
          <div className="mt-1 flex justify-between border-t pt-1.5 font-bold">
            <span>التكلفة بالدينار</span>
            <span dir="ltr">{fmtAr(landedGrand)} د.ع</span>
          </div>
        </section>
      )}
      {!hasEntityId && hasItems && (
        <section className="rounded-lg border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]/20 p-2.5 flex flex-col gap-1.5">
          <div className="text-xs font-semibold text-foreground">
            مسودة بدون مورد محدد (سوق مفتوح):
          </div>
          <Button
            type="button"
            className="w-full bg-[var(--sem-warn)] hover:bg-[var(--sem-warn)]/90 text-background font-semibold text-xs h-8 shadow-sm gap-1.5"
            disabled={!canCreateRequisition || isAnySaving}
            onClick={onSaveRequisition}
          >
            <ClipboardList className="size-4" />
            حفظ كطلب تأمين (إسناد للمدير للتفاوض)
          </Button>
        </section>
      )}
    </>
  );
}
