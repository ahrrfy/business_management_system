import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildReverseDeliveryControlAttempt,
  isRequestableReverseRefundSource,
  reverseDeliveryAttemptStorageKey,
} from "./ReverseDeliveryRequestDialog";

type BuildArgs = Parameters<typeof buildReverseDeliveryControlAttempt>[0];

function preflight(): BuildArgs["preflight"] {
  return {
    eligible: true,
    workOrderId: 5079,
    branchId: 1,
    status: "DELIVERED",
    version: 8,
    invoiceId: 991,
    netPaid: "140000.00",
    priorCompletedOut: "10000.00",
    priorPendingOut: "5000.00",
    refundSources: [
      {
        sourceReceiptId: 41,
        amount: "80000.00",
        collectedMethod: "CASH",
        refundMethod: "CASH",
        counterRole: "OTHER_LIABILITY",
      },
      {
        sourceReceiptId: 77,
        amount: "45000.00",
        collectedMethod: "TRANSFER",
        refundMethod: "TRANSFER",
        counterRole: "AR",
      },
    ],
    openReceptionShifts: [
      { id: 12, userId: 5, userName: "موظف الاستقبال", expectedCash: "250000.00" },
    ],
    consignment: null,
  };
}

describe("عقد واجهة طلب عكس تسليم أمر الشغل", () => {
  it("يثبت النسخة ومصادر الرد والوردية في طلب تحكم صفري الأثر", () => {
    const attempt = buildReverseDeliveryControlAttempt({
      workOrderId: 5079,
      reason: "  أعاد العميل الطلب بعد فحصه  ",
      reopen: true,
      refundShiftId: 12,
      requestKey: "reverse-fixed-key",
      preflight: preflight(),
    });

    expect(attempt.input).toEqual({
      requestType: "REVERSE_DELIVERY",
      requestKey: "reverse-fixed-key",
      workOrderId: 5079,
      baseVersion: 8,
      reason: "أعاد العميل الطلب بعد فحصه",
      payload: {
        expectedVersion: 8,
        reopen: true,
        refundShiftId: 12,
        refundSources: preflight().refundSources,
      },
    });
  });

  it("يبقى تمثيل المحاولة المحفوظة مطابقاً حرفياً عند إعادة المحاولة", () => {
    const attempt = buildReverseDeliveryControlAttempt({
      workOrderId: 5079,
      reason: "رفض العميل العمل المسلّم",
      reopen: false,
      refundShiftId: 12,
      requestKey: "retry-same-key",
      preflight: preflight(),
    });
    const recovered = JSON.parse(JSON.stringify(attempt));

    expect(JSON.stringify(recovered.input)).toBe(JSON.stringify(attempt.input));
    expect(reverseDeliveryAttemptStorageKey(5079)).toBe("work-order-reverse-delivery-attempt:5079");
  });

  it("يفشل مغلقاً عند طريقة مبادلة لا يقبلها عقد الطلب", () => {
    const unsupported = { ...preflight().refundSources[0]!, collectedMethod: "EXCHANGE" as const };
    expect(isRequestableReverseRefundSource(unsupported)).toBe(false);
    expect(() => buildReverseDeliveryControlAttempt({
      workOrderId: 5079,
      reason: "رد بمصدر غير مدعوم",
      reopen: false,
      refundShiftId: null,
      requestKey: "unsupported-source",
      preflight: { ...preflight(), refundSources: [unsupported] },
    })).toThrow("طريقة قبض لا يقبلها عقد طلب العكس");
  });

  it("يعرض التحميل والخطأ والمصادر والوردية ويعيد الحمولة المحفوظة نفسها", () => {
    const source = readFileSync(new URL("./ReverseDeliveryRequestDialog.tsx", import.meta.url), "utf8");
    expect(source).toContain("workOrders.controlPreflight.useQuery");
    expect(source).toContain("workOrders.requestControl.useMutation");
    expect(source).toContain("مصادر الاسترداد المطابقة للمقبوضات");
    expect(source).toContain("وردية الاسترداد النقدي");
    expect(source).toContain("تعذّر التحقق من حالة الأمر ومصادر القبض والورديات");
    expect(source).toContain("request.mutate(exact.input)");
    expect(source).toContain("JSON.stringify(next)");
    expect(source).toContain('result.status === "APPROVED"');
    expect(source).toContain('result.status === "REJECTED"');
    expect(source).toContain('result.status === "STALE"');
    expect(source).toContain("لا تصبح حالة الأمر «جاهز» أو «ملغى» قبل اعتماد مراجع مستقل");
  });
});
