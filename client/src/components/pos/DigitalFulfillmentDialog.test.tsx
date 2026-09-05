import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialog = readFileSync(new URL("./DigitalFulfillmentDialog.tsx", import.meta.url), "utf8");
const pos = readFileSync(new URL("../../pages/POS.tsx", import.meta.url), "utf8");

describe("نافذة تنفيذ الكروت — سبب فشل التثبيت الحقيقي لا «تعذّر الاتصال» دائماً", () => {
  it("تقبل finalizeError وتعرضه بدل النصّ الثابت حين موجود", () => {
    expect(dialog).toContain("finalizeError?: string | null");
    expect(dialog).toContain("finalizeError ? (");
    expect(dialog).toContain("{finalizeError}");
  });

  it("لا يُتّهم تعذّر الاتصال حين السبب الحقيقي معروف ومعروض", () => {
    expect(dialog).toContain('"أعد محاولة تثبيت الفاتورة"');
    expect(dialog).toContain('"إعادة محاولة تثبيت الفاتورة عند تعذّر الاتصال"');
  });

  it("POS.tsx يمرّر خطأ finalizeSale الفعلي إلى النافذة بدل إسقاطه صامتاً", () => {
    expect(pos).toContain("finalizeError={finalizeSale.error ? errMsg(finalizeSale.error) : null}");
  });
});
