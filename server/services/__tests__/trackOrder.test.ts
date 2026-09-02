/**
 * عقد التتبّع الإرثي مغلق: orderNumber المتسلسل + الهاتف ليسا إثبات ملكية. هذا الاختبار
 * يثبت أن إجراء GET نفسه غير مركّب في الراوتر وأن الإغلاق يحدث قبل أي قراءة DB، فلا يبقى oracle يفرّق
 * بين طلب/هاتف موجودين وغير موجودين. التتبّع الجديد (جلسة/رمز ضيف) مغطّى في
 * onlineOrderTrackingSecurity.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbProbe = vi.hoisted(() => vi.fn());

vi.mock("../../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db")>()),
  getDb: dbProbe,
}));

import { storefrontRouter } from "../../routers/storefrontRouter";

beforeEach(() => {
  dbProbe.mockReset();
  dbProbe.mockImplementation(() => {
    throw new Error("legacy tracking must not read the database");
  });
});

describe("storefront.trackOrder legacy GET — fail closed without DB oracle", () => {
  it("غير موجود في خريطة الإجراءات، فلا يبلغ أي طلب قديم خدمة أو قاعدة بيانات", () => {
    const procedures = storefrontRouter._def.procedures as Record<string, unknown>;
    expect(procedures).not.toHaveProperty("trackOrder");
    expect(dbProbe).not.toHaveBeenCalled();
  });
});
