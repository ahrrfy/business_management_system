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
    | "branches"
    | "selectedCategory"
    | "selectedCategoryReady"
    | "treasuryNotice"
    | "amountNum"
  >,
) {
  const {
    direction,
    branchId,
    method,
    partyType,
    branches,
    selectedCategory,
    selectedCategoryReady,
    treasuryNotice,
    amountNum,
  } = ctx;

  // مَعاينة قَيد الدفتر (P1-10) — صفّان بسيطان مَدين/دائن.
  const ledgerPreview = useMemo(() => {
    if (amountNum <= 0) return null;
    const a = fmt(amountNum);
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
          ? "ذمة عميل (تَنقص)"
          : partyType === "SUPPLIER"
            ? "ذمة مورّد (تَزيد)"
            : partyType === "DELIVERY_PARTY"
              ? "عهدة جهة توصيل (تَنقص)"
              : selectedCategoryReady
                ? voucherCategoryRoleLabel(selectedCategory?.postingRole)
                : "اختر فئة محاسبية مهيأة";
      return [
        {
          side: "مَدين",
          account: `صندوق ${branchName} — ${cashBucketLabel}`,
          amount: a,
        },
        { side: "دائن", account: credit, amount: a },
      ];
    }
    const debit =
      partyType === "CUSTOMER"
        ? "ذمة عميل (تَزيد)"
        : partyType === "SUPPLIER"
          ? "ذمة مورّد (تَنقص)"
          : partyType === "DELIVERY_PARTY"
            ? "مستحق جهة توصيل (تَنقص)"
            : selectedCategoryReady
              ? voucherCategoryRoleLabel(selectedCategory?.postingRole)
              : "اختر فئة محاسبية مهيأة";
    return [
      { side: "مَدين", account: debit, amount: a },
      {
        side: "دائن",
        account: `صندوق ${branchName} — ${cashBucketLabel}`,
        amount: a,
      },
    ];
  }, [
    amountNum,
    branches.data,
    branchId,
    method,
    treasuryNotice,
    direction,
    partyType,
    selectedCategory,
    selectedCategoryReady,
  ]);
  return { ledgerPreview };
}
