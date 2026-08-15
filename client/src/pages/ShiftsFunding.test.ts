import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Shifts — واجهة العهدة الإضافية", () => {
  it("تُظهر طلب المالك وقبول صاحب الوردية وتمنع اعتبار الطلب نقداً قبل الاستلام", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "client/src/pages/Shifts.tsx"),
      "utf8",
    );
    expect(source).toContain("تمويل إضافي");
    expect(source).toContain("لا تُخصم الخزنة ولا يزيد الدرج حتى يستلم صاحب الوردية النقد فعلياً");
    expect(source).toContain("استلمت النقد");
    expect(source).toContain("تأكيد الرفض بلا أثر نقدي");
    expect(source).toContain("sourceTreasuryReceiptId");
    expect(source).toContain("trpc.shifts.fundingSources.useQuery");
    expect(source).toContain("trpc.shifts.fundingOutgoing.useQuery");
    expect(source).toContain("اختر سحباً نقدياً مقبولاً وغير مستخدم");
    expect(source).toContain("setFundingAmount(selected?.amount ?? \"\")");
    expect(source).toContain("targetShiftId: fundingShiftId ?? 0");
    expect(source).toContain("fundingSourcesQ.data?.items ?? []");
    expect(source).toContain("fundingSourcesQ.data?.nextCursor");
    expect(source).toContain("إلزامي: يجب أن يكون سحباً مقبولاً من وردية أخرى وبنفس المبلغ");
    expect(source).toContain("!fundingSourceReceiptId");
    expect(source).not.toContain("sourceTreasuryReceiptId: fundingSourceReceiptId\n                    ?");
    expect(source).toContain("fundingExpected.lt(0)");
    expect(source).toContain("Number(r.userId) === Number(me.data?.id)");
    expect(source).toContain("decision: \"ACCEPT\"");
    expect(source).toContain("decision: \"REJECT\"");
    expect(source).toContain("إلغاء الطلب بلا أثر نقدي");
    expect(source).not.toMatch(/requestFundingM\.mutate\(\{[\s\S]*?cashBucket:/);
  });
});
