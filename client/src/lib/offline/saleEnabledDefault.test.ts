import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * الافتراضي: البيع الأوفلايني **مفعَّل تلقائياً** على كل جهاز (قرار مالك ١٦/٨/٢٦).
 *
 * قبله كان معطَّلاً ويلزمه تفعيلٌ يدويّ لكل جهاز، فكاشيرٌ ينقطع عنه الإنترنت لا يستطيع
 * البيع أصلاً لأنّ أحداً لم يفتح إعدادات جهازه سلفاً — نقيض غرض المنظومة.
 *
 * وهذا الاختبار هو الحارس: أيّ عودةٍ إلى «معطَّل افتراضياً» تُسقطه.
 */

const meta = new Map<string, string>();
vi.mock("./db", () => ({
  getMeta: async (k: string) => meta.get(k) ?? null,
  setMeta: async (k: string, v: string) => void meta.set(k, v),
  offlineDb: {},
}));

beforeEach(() => {
  meta.clear();
  vi.resetModules();
});

describe("الافتراضي الأوفلايني — تفعيلٌ تلقائيّ بلا تدخّل", () => {
  it("جهازٌ لم يُضبَط قط ⇒ الالتقاط مفعَّل", async () => {
    const { isOfflineSaleEnabled } = await import("./outbox");
    expect(await isOfflineSaleEnabled()).toBe(true);
  });

  it("لا يُعطَّل إلّا بقيمة «0» صريحة كتبها مدير", async () => {
    const { isOfflineSaleEnabled, setOfflineSaleEnabled } = await import("./outbox");
    await setOfflineSaleEnabled(false);
    expect(await isOfflineSaleEnabled()).toBe(false);

    await setOfflineSaleEnabled(true);
    expect(await isOfflineSaleEnabled()).toBe(true);
  });

  it("قيمةٌ غريبة في التخزين لا تُعطّل البيع (fail-open للالتقاط لا للمال)", async () => {
    // الالتقاط ليس إذناً مالياً: حرّاس المال (نقديّ فقط، عمر الأسعار، سقف الطابور) تبقى
    // نافذةً بعده. فقيمةٌ تالفة يجب ألّا تمنع كاشيراً من قبول نقدٍ أثناء الانقطاع.
    meta.set("offlineSaleEnabled", "yes");
    const { isOfflineSaleEnabled } = await import("./outbox");
    expect(await isOfflineSaleEnabled()).toBe(true);
  });
});
