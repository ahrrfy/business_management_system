/**
 * ═══ اختبار وصل اللقطة بمسار `updateCustomer` (م٦ ق٨) ═══
 *
 * كل تعديلٍ لعميل يكتب صفَّ لقطةٍ في `recordVersions` بحمولةٍ كاملة قبل التعديل. الاختبار
 * الوحدويّ لعقد الخدمة نفسه في `versioning/__tests__/recordVersion.test.ts` — هذا يوثّق
 * التوصيل فعلياً في مسار حقيقيّ.
 */
import { asc, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createCustomer, updateCustomer } from "../customerService";

const ACTOR = { userId: 1, branchId: 1, role: "admin", isOwner: true };

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const TABLES = ["recordVersions", "accountingEntries", "customers", "branches", "users"];

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({
    id: 1,
    openId: "local_admin",
    name: "المدير",
    role: "admin",
    loginMethod: "local",
  });
}

describe("updateCustomer + recordVersions", () => {
  beforeEach(async () => {
    await reset();
    await seedBase();
  });

  it("كلُّ تعديلٍ يكتب لقطةً كاملةً بالحالة القديمة قبل التعديل", async () => {
    // إنشاء أولٌ لا يكتب لقطةً (اللقطةُ تعني «قبل تعديل» — الحالة قبل الإنشاء لا وجود لها).
    const created = await createCustomer(
      { name: "أحمد", phone: "07700000001", customerType: "فرد" },
      ACTOR,
    );

    // بعد الإنشاء: لا لقطات
    let versions = await db().select().from(s.recordVersions);
    expect(versions.length).toBe(0);

    // تعديلٌ أوّل: تغيير الاسم
    await updateCustomer(
      { customerId: created.customerId, name: "أحمد محمد" },
      ACTOR,
    );

    versions = await db()
      .select()
      .from(s.recordVersions)
      .orderBy(asc(s.recordVersions.versionNumber));
    expect(versions.length).toBe(1);
    expect(versions[0].entityType).toBe("customer");
    expect(versions[0].entityId).toBe(created.customerId);
    expect(versions[0].versionNumber).toBe(1);
    expect(versions[0].reason).toBe("تعديل بيانات العميل");
    expect(versions[0].actorUserId).toBe(ACTOR.userId);
    // اللقطةُ تحمل الحالةَ **قبل** التعديل (الاسم القديم)
    const payload = versions[0].payloadJson as { name: string };
    expect(payload.name).toBe("أحمد");

    // تعديلٌ ثانٍ بسببٍ مخصَّص
    await updateCustomer(
      {
        customerId: created.customerId,
        city: "بغداد",
        updateReason: "تحديث بيانات المدينة",
      },
      ACTOR,
    );

    versions = await db()
      .select()
      .from(s.recordVersions)
      .orderBy(asc(s.recordVersions.versionNumber));
    expect(versions.length).toBe(2);
    expect(versions[1].versionNumber).toBe(2);
    expect(versions[1].reason).toBe("تحديث بيانات المدينة");
    const payload2 = versions[1].payloadJson as { name: string; city: string | null };
    // اللقطة الثانية تحمل الاسم بعد التعديل الأول (لأنها «قبل» التعديل الثاني)
    expect(payload2.name).toBe("أحمد محمد");
    expect(payload2.city).toBe(null);
  });

  it("تعديلٌ لعميلٍ غير موجود يفشل ولا يكتب لقطةً (ROLLBACK كامل)", async () => {
    await expect(
      updateCustomer({ customerId: 99999, name: "لا يوجد" }, ACTOR),
    ).rejects.toThrow(/غير موجود/);
    const versions = await db().select().from(s.recordVersions);
    expect(versions.length).toBe(0);
  });
});
