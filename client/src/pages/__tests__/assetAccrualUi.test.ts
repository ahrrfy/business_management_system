import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assetSettlementPresentation } from "../../lib/assetAccrualStatus";

const newSource = readFileSync(
  new URL("../AssetNew.tsx", import.meta.url),
  "utf8",
);
const registerSource = readFileSync(
  new URL("../AssetRegister.tsx", import.meta.url),
  "utf8",
);
const expensesSource = readFileSync(
  new URL("../Expenses.tsx", import.meta.url),
  "utf8",
);

const correctionDialogSource = readFileSync(
  new URL("../../components/expenses/ExpenseCorrectionDialog.tsx", import.meta.url),
  "utf8",
);

describe("asset accrual UI disclosure", () => {
  it("explains that recognition and depreciation do not wait for cash settlement", () => {
    expect(newSource).toContain("ثُبّت الأصل");
    expect(newSource).toContain("الأصل نشط ويبدأ إهلاكه");
    expect(newSource).toContain("خروج النقد فينتظر اعتماد مالكٍ آخر");
    expect(newSource).not.toContain("لا يبدأ إهلاكه قبل اعتماد");
  });

  it("exports and displays settlement state separately from asset status", () => {
    expect(registerSource).toContain('header: "تسوية الاقتناء"');
    expect(registerSource).toContain("assetStatusLabel(r.status)");
    expect(registerSource).toContain(
      "assetSettlementPresentation(r.settlementStatus).label",
    );
    expect(registerSource).toContain("<AssetStatusBadge status={a.status} />");
    expect(registerSource).toContain(
      "assetSettlementPresentation(a.settlementStatus)",
    );
    expect(assetSettlementPresentation("ACCRUED_UNPAID")).toMatchObject({
      label: "مستحق غير مدفوع",
      liabilityOutstanding: true,
      cashMoved: false,
    });
    expect(assetSettlementPresentation("PAID")).toMatchObject({
      label: "مسوّى ومدفوع",
      liabilityOutstanding: false,
      cashMoved: true,
    });
  });

  it("يوصل إعادة تقديم استرداد التصحيح المرفوض من الواجهة إلى الإجراء الخادمي", () => {
    // حوار التصحيح استُخرج إلى مكوّن مستقلّ؛ الصفحة تركّبه والمنطق فيه.
    expect(expensesSource).toContain("<ExpenseCorrectionDialog");
    expect(correctionDialogSource).toContain(
      "trpc.expenses.retryAccrualCorrectionRefund.useMutation",
    );
    expect(correctionDialogSource).toContain("إعادة تقديم طلب قبض الاسترداد");
    expect(correctionDialogSource).toContain("retryableRefundCorrection.requestedBy");
    expect(correctionDialogSource).toContain(
      "clientRequestId: correctionClientRequestId",
    );
  });
});
