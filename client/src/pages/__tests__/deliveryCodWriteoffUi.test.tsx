import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("../DeliveryParties.tsx", import.meta.url), "utf8");

describe("واجهة طلب شطب عهدة COD", () => {
  it("توضح أن الإنشاء صفر الأثر وتطلب سبباً وإثباتاً", () => {
    expect(page).toContain("هذا مستند طلب فقط؛ لا يتغير الرصيد ولا الإرسالية قبل اعتماد مراجع توصيل مستقل ومخوّل");
    expect(page).toContain("evidenceNote");
    expect(page).toContain("attachmentUrl");
    expect(page).toContain("إرسال طلب الشطب");
  });

  it("تعرض قائمة مراجعة مستقلة مع النسخة ومفاتيح القرار", () => {
    expect(page).toContain("const canReviewWriteOff = !!role && moduleAccessAllowed");
    expect(page).toContain("listWriteOffRequests.useQuery");
    expect(page).toContain("approveWriteOffRequest.useMutation");
    expect(page).toContain("rejectWriteOffRequest.useMutation");
    expect(page).toContain("expectedVersion: Number(row.basePartyVersion)");
    expect(page).toContain("طلبك — يلزم مراجع آخر");
  });
});
