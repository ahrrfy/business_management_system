import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("../SystemHealth.tsx", import.meta.url), "utf8");
const adminHub = readFileSync(new URL("../AdminHub.tsx", import.meta.url), "utf8");

describe("لوحة صحة النظام — رسائل التوصيل المستنفدة", () => {
  it("تظهر للأدمن في تبويب مستقل وتفشل بحالة خطأ صريحة", () => {
    expect(adminHub).toContain('value: "system-health"');
    expect(adminHub).toContain('gate: { adminOnly: true }');
    expect(page).toContain("listDeadLetterOutbox.useQuery");
    expect(page).toContain("ErrorState");
    expect(page).toContain("rows.length");
  });

  it("تعرض سبب الفشل وتؤكد إعادة الطابور وتقدم تغذية راجعة", () => {
    expect(page).toContain("lastError");
    expect(page).toContain("requeueDeadLetter.useMutation");
    expect(page).toContain("await confirm({");
    expect(page).toContain("إعادة إلى الطابور");
    expect(page).toContain("notify.ok");
    expect(page).toContain("notify.warn");
  });
});
