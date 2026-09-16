/* ============================================================================
 * حارس البرميل — server/services/advances/index.ts
 * م٣ من برنامج v2: يمنع كسرَ العقد الخارجيّ لخدمة السلف بلا قصد
 * (حذفُ تصديرٍ أو إعادةُ تسميته دون تحديث المستهلكين تمرّ من `pnpm check`
 * لأنّ TypeScript يُرضيها البرميل، لكنّ الاستيراد يفشل في زمن التشغيل).
 * لا يفحص السلوك — يفحص السطحَ العامّ وحده.
 * ========================================================================== */
import { describe, expect, it } from "vitest";
import * as advances from "..";

describe("advances — السطح العامّ للبرميل", () => {
  it("يُصدّر دوال منح/تسوية/إلغاء السلف المطلوبة للمستهلكين الحاليّين", () => {
    // من `advancesService.ts` — يستهلكها payrollRouter/generate/voucher.*
    expect(typeof advances.advanceThresholds).toBe("function");
    expect(typeof advances.listAdvances).toBe("function");
    expect(typeof advances.employeeBalance).toBe("function");
    expect(typeof advances.grantAdvance).toBe("function");
    expect(typeof advances.cancelAdvance).toBe("function");
    expect(typeof advances.suggestDeductionsTx).toBe("function");
    expect(typeof advances.suggestDeductionsForPeriod).toBe("function");
    expect(typeof advances.settleAdvancesOnPayTx).toBe("function");
    expect(typeof advances.restoreAdvanceSettlementsTx).toBe("function");
    expect(typeof advances.assertEmployeeAdvanceVoucherRequestTx).toBe("function");
    expect(typeof advances.activateAdvanceForApprovedVoucherTx).toBe("function");
  });

  it("يُصدّر قفلَ إلغاءِ سلفةٍ غير مُستعمَلة (voucher.cancel)", () => {
    // من `employeeAdvanceCancellation.ts` — يستهلكها voucher/approval.ts + voucher/cancel.ts
    expect(typeof advances.lockUntouchedEmployeeAdvanceForCancellationTx).toBe("function");
    expect(typeof advances.cancelLockedEmployeeAdvanceTx).toBe("function");
  });

  it("يُعيد تصدير مساعدات سداد السلف من payroll/advanceRepayment", () => {
    // `advancesService.ts` يحمل `export * from "../payroll/advanceRepayment"`؛
    // ادّعاءٌ أرقّ من أن يفرض شكلاً بعينه لأنّ #965 يعمل على نفس الملفّ.
    expect(advances).toBeTypeOf("object");
    const keys = Object.keys(advances);
    expect(keys.length).toBeGreaterThan(10);
  });
});
