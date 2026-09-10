import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(resolve(process.cwd(), "client/src/pages/store/StoreQuoteRequests.tsx"), "utf8");

describe("StoreQuoteRequests quote operations guidance", () => {
  it("keeps the staff workflow and acceptance safeguards explicit", () => {
    expect(page).toContain("استفسار العميل ← مراجعة الموظف ← عرض رسمي ← قبول أو إعادة تسعير");
    expect(page).toContain('request.status === "QUOTED"');
    expect(page).toContain("يعيد النظام التحقق من السعر والتوفر التشغيلي (ATP)");
    expect(page).toContain("يعود العرض لمراجعة الموظف وإعادة التسعير");
    expect(page).toContain("لا ينشئ القبول فاتورة أو طلب بيع");
  });
});
