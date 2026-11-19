import { fmt } from "@/lib/money";
import { useMemo } from "react";
import { voucherCategoryRoleLabel } from "@shared/voucherCategoryAccounting";
import type { useVoucherFormState } from "./useVoucherFormState";
import type { useVoucherFormQueries } from "./useVoucherFormQueries";
export function useVoucherLedgerPreview(
  ctx: Pick<
    ReturnType<typeof useVoucherFormState> &
      ReturnType<typeof useVoucherFormQueries>,
    | "direction"
    | "branchId"
    | "method"
    | "partyType"
    | "supplierReceiptPurpose"
    | "branches"
    | "selectedCategory"
    | "selectedCategoryReady"
    | "treasuryNotice"
    | "amountDec"
  >,
) {
  const {
    direction,
    branchId,
    method,
    partyType,
    supplierReceiptPurpose,
    branches,
    selectedCategory,
    selectedCategoryReady,
    treasuryNotice,
    amountDec,
  } = ctx;

  // معاينة قيد الدفتر (P1-10) — صفان بسيطان مدين/دائن.
  const ledgerPreview = useMemo(() => {
    if (amountDec.lte(0)) return null;
    const a = fmt(amountDec.toFixed(2));
    const branchName =
      (branches.data ?? []).find((b) => Number(b.id) === Number(branchId))
        ?.name ?? "—";
    const cashBucketLabel =
      method === "CASH"
        ? treasuryNotice
          ? "خزينة إدارية"
          : "درج كاشير"
        : "بنك/محفظة";
    if (direction === "IN") {
      const credit =
        partyType === "CUSTOMER"
          ? "ذمة عميل (تنقص)"
          : partyType === "SUPPLIER"
            ? supplierReceiptPurpose === "ADVANCE_REFUND"
              ? "ذمة مورد (عكس استرداد دفعة)"
              : "ذمة مورد (تزيد — له علينا)"
            : partyType === "DELIVERY_PARTY"
              ? "عهدة جهة توصيل (تنقص)"
              : selectedCategoryReady
                ? voucherCategoryRoleLabel(selectedCategory?.postingRole)
                : "اختر فئة محاسبية مهيأة";
      return [
        {
          side: "مدين",
          account: `صندوق ${branchName} — ${cashBucketLabel}`,
          amount: a,
        },
        { side: "دائن", account: credit, amount: a },
      ];
    }
    const debit =
      partyType === "CUSTOMER"
        ? "ذمة عميل (تزيد)"
        : partyType === "SUPPLIER"
          ? "ذمة مورد (تنقص)"
          : partyType === "DELIVERY_PARTY"
            ? "مستحق جهة توصيل (ينقص)"
            : selectedCategoryReady
              ? voucherCategoryRoleLabel(selectedCategory?.postingRole)
              : "اختر فئة محاسبية مهيأة";
    return [
      { side: "مدين", account: debit, amount: a },
      {
        side: "دائن",
        account: `صندوق ${branchName} — ${cashBucketLabel}`,
        amount: a,
      },
    ];
  }, [
    amountDec,
    branches.data,
    branchId,
    method,
    treasuryNotice,
    direction,
    partyType,
    supplierReceiptPurpose,
    selectedCategory,
    selectedCategoryReady,
  ]);
  return { ledgerPreview };
}
