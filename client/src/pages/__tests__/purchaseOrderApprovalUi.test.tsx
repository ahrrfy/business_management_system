import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = (name: string) =>
  readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

describe("واجهة دورة اعتماد أمر الشراء", () => {
  it("لا تنشئ CONFIRMED مباشرة وتعرض الحفظ والاعتماد كخطوتين", () => {
    const create = page("PurchaseNew.tsx");
    const list = page("Purchases.tsx");
    expect(create).not.toContain('buildPayload("CONFIRMED")');
    expect(create).toContain('primaryLabel="حفظ المسودة"');
    expect(create).toContain("أرسله للاعتماد من قائمة المشتريات");
    expect(list).toContain("reason:");
    expect(list).toContain("clientRequestId:");
    expect(list).toContain("expectedVersion:");
    expect(list).toContain("أُرسل أمر الشراء للاعتماد");
    expect(list).not.toContain("اعتُمد أمر الشراء — أصبح قابلاً للاستلام");
  });

  it("تشرح أن المعتمد غير قابل للتعديل", () => {
    const edit = page("PurchaseEdit.tsx");
    expect(edit).toContain('order.status === "CONFIRMED"');
    expect(edit).toContain("غير قابل للتعديل");
    expect(edit).toContain("revisionReason:");
    expect(edit).toContain("expectedVersion:");
  });
});
