/**
 * اختبارات taxSettingsService — إعدادات الضريبة (صفّ singleton id=1):
 * get-or-create كسول + تحديث بالتحقّق من النطاق [0,100] + تدقيق القيم decimal(5,2).
 */
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getTaxSettings, updateTaxSettings } from "../taxSettingsService";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

// updatedBy → users.id (FK) — ينبغي وجود مستخدمَين على الأقلّ (id=1 admin، id=2 مستخدم آخر)
// كي تصحّ عمليات updateTaxSettings({ userId: 1|2 }) في كل اختبار (__setup__ يفرّغ users بعد كل اختبار).
beforeEach(async () => {
  const d = db();
  await d.insert(s.users).values([
    { id: 1, openId: "local_admin", name: "admin", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "local_user2", name: "مستخدم آخر", role: "manager", loginMethod: "local", branchId: 1 },
  ]);
});

describe("taxSettingsService", () => {
  it("ينشئ الصفّ الافتراضي عند أول قراءة (get-or-create كسول)", async () => {
    const s = await getTaxSettings();
    expect(s.id).toBe(1);
    expect(s.enabledByDefault).toBe(false);
    expect(s.defaultTaxRatePercent).toBe("0.00");
    expect(s.taxRegistrationNumber).toBeNull();
  });

  it("القراءة الثانية تُرجع نفس الصفّ (لا تُنشئ صفّاً مكرَّراً)", async () => {
    await getTaxSettings();
    await getTaxSettings();
    const rows = await db().select().from(s.taxSettings);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
  });

  it("يحدّث الإعدادات بنجاح ضمن النطاق [0,100]", async () => {
    const updated = await updateTaxSettings(
      { enabledByDefault: true, defaultTaxRatePercent: "15", taxRegistrationNumber: "IQ-12345" },
      { userId: 1 },
    );
    expect(updated.enabledByDefault).toBe(true);
    expect(updated.defaultTaxRatePercent).toBe("15.00");
    expect(updated.taxRegistrationNumber).toBe("IQ-12345");
    expect(updated.updatedBy).toBe(1);

    const reread = await getTaxSettings();
    expect(reread.enabledByDefault).toBe(true);
    expect(reread.defaultTaxRatePercent).toBe("15.00");
  });

  it("يعمل حتى لو لم يُقرأ الصفّ من قبل (get-or-create داخل التحديث نفسه)", async () => {
    const updated = await updateTaxSettings(
      { enabledByDefault: false, defaultTaxRatePercent: "5.5" },
      { userId: 2 },
    );
    expect(updated.defaultTaxRatePercent).toBe("5.50");
    expect(updated.taxRegistrationNumber).toBeNull();
  });

  it("يرفض نسبة سالبة", async () => {
    await expect(
      updateTaxSettings({ enabledByDefault: true, defaultTaxRatePercent: "-1" }, { userId: 1 }),
    ).rejects.toThrow();
  });

  it("يرفض نسبة أكبر من ١٠٠", async () => {
    await expect(
      updateTaxSettings({ enabledByDefault: true, defaultTaxRatePercent: "100.01" }, { userId: 1 }),
    ).rejects.toThrow();
  });

  it("يقبل الحدّ الأقصى ١٠٠ بالضبط", async () => {
    const updated = await updateTaxSettings(
      { enabledByDefault: true, defaultTaxRatePercent: "100" },
      { userId: 1 },
    );
    expect(updated.defaultTaxRatePercent).toBe("100.00");
  });

  it("يمسح الرقم الضريبي عند إرسال سلسلة فارغة/فراغات", async () => {
    await updateTaxSettings(
      { enabledByDefault: true, defaultTaxRatePercent: "10", taxRegistrationNumber: "  " },
      { userId: 1 },
    );
    const s = await getTaxSettings();
    expect(s.taxRegistrationNumber).toBeNull();
  });
});
