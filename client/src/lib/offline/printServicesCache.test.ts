/**
 * نسخة بلاطات خدمات الطباعة المحليّة — طبقة قراءة كاشير الطباعة دون اتصال.
 *
 * الثوابت: (١) لا تُستبدَل نسخةٌ صالحة بقائمةٍ فارغة (خطأ جلبٍ عابر كان سيمحو الشاشة)،
 * (٢) لا تُقدَّم أسعار فئةٍ لفئةٍ أخرى (بيعٌ بسعرٍ خاطئ أسوأ من شاشةٍ فارغة).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.mock("./db", () => ({
  getMeta: async (k: string) => store.get(k) ?? null,
  setMeta: async (k: string, v: string) => { store.set(k, v); },
}));

const { cachePrintServices, readCachedPrintServices } = await import("./printServicesCache");

interface Svc { variantId: number; productName: string }
const items: Svc[] = [{ variantId: 1, productName: "طباعة A4" }];

describe("نسخة خدمات الطباعة المحليّة", () => {
  beforeEach(() => store.clear());

  it("تحفظ وتُعيد القائمة لنفس فئة السعر", async () => {
    await cachePrintServices("RETAIL", items);
    const snap = await readCachedPrintServices<Svc>("RETAIL");
    expect(snap?.items).toHaveLength(1);
    expect(snap?.items[0].productName).toBe("طباعة A4");
  });

  it("لا تستبدل نسخةً صالحة بقائمةٍ فارغة (خطأ جلبٍ عابر)", async () => {
    await cachePrintServices("RETAIL", items);
    await cachePrintServices("RETAIL", [] as Svc[]);
    expect((await readCachedPrintServices<Svc>("RETAIL"))?.items).toHaveLength(1);
  });

  it("لا تُقدّم أسعار فئةٍ لفئةٍ أخرى", async () => {
    await cachePrintServices("RETAIL", items);
    expect(await readCachedPrintServices<Svc>("WHOLESALE")).toBeNull();
  });

  it("بلا نسخة ⇒ null (الجهاز لم يعمل أونلاين على هذه الشاشة قط)", async () => {
    expect(await readCachedPrintServices<Svc>("RETAIL")).toBeNull();
  });
});
