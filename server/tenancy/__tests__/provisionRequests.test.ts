/**
 * طابور توفير الشركات عبر الويب — أول اختبار يلمس قاعدة التحكّم (erp_control) فعلياً
 * (لا كائنات وهمية). يضبط CONTROL_DATABASE_URL/INTEGRATIONS_ENCRYPTION_KEY محلياً لهذا
 * الملف فقط ويستعيدهما بعد الانتهاء (fileParallelism:false يعني تشغيل كل الملفات في
 * عملية واحدة ⇒ تسريب متغيّرات env لملفات لاحقة خطر حقيقي بلا هذا التنظيف — راجع نمط
 * channelWebhooks.test.ts). يغطّي: التحقّق من صحّة المدخلات، منع تكرار الرمز (شركة
 * قائمة أو طلب معلَّق)، المطالبة الذرّية (claim) بلا سباق مزدوج، ومسح كلمة المرور
 * المؤقّتة بعد النجاح.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../../auth/password";
import { extractInsertId } from "../../lib/insertId";
import { appRouter } from "../../routers";
import { __resetKeyCacheForTests } from "../../services/cryptoService";
import { closeControlDb, getControlDb } from "../controlDb";
import { companies, companyProvisionRequests, platformAdmins } from "../controlSchema";
import {
  claimNextPendingRequest,
  createProvisionRequest,
  getProvisionRequestStatus,
  listRecentProvisionRequests,
  markProvisionRequestDone,
  markProvisionRequestFailed,
} from "../provisionRequests";

const savedControlUrl = process.env.CONTROL_DATABASE_URL;
const savedEncKey = process.env.INTEGRATIONS_ENCRYPTION_KEY;

beforeAll(() => {
  process.env.CONTROL_DATABASE_URL = "mysql://root:testpw@127.0.0.1:3310/erp_control_test";
  process.env.INTEGRATIONS_ENCRYPTION_KEY = "1".repeat(64); // 64 hex chars = 32 bytes صالحة للاختبار فقط
  __resetKeyCacheForTests();
});

afterAll(async () => {
  await closeControlDb();
  if (savedControlUrl === undefined) delete process.env.CONTROL_DATABASE_URL;
  else process.env.CONTROL_DATABASE_URL = savedControlUrl;
  if (savedEncKey === undefined) delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
  else process.env.INTEGRATIONS_ENCRYPTION_KEY = savedEncKey;
  __resetKeyCacheForTests();
});

function db() {
  const d = getControlDb();
  if (!d) throw new Error("CONTROL_DATABASE_URL not set for test");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of ["companyProvisionRequests", "platformAuditLogs", "companies", "platformAdmins"]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedPlatformAdmin(): Promise<number> {
  const result = await db().insert(platformAdmins).values({
    email: "pa@test.local",
    passwordHash: hashPassword("Pass1234!Aaa"),
    name: "مدير المنصّة",
  });
  return extractInsertId(result);
}

function callerWithPlatformAdmin(id: number, email: string) {
  const ctx = {
    req: { headers: {} },
    res: { cookie() {}, clearCookie() {} },
    user: null,
    sessionId: null,
    platformAdmin: { id, email, name: "مدير المنصّة", isActive: true },
  } as any;
  return appRouter.createCaller(ctx);
}

beforeEach(async () => {
  await reset();
});

describe("createProvisionRequest — تحقّق ومنع التكرار", () => {
  it("ينشئ طلباً بكلمة مرور عشوائية قوية (لا تُخزَّن مفكوكة التشفير)", async () => {
    const adminId = await seedPlatformAdmin();
    const { id, tempPassword } = await createProvisionRequest({
      code: "acme",
      name: "شركة أكمي",
      adminEmail: "admin@acme.test",
      adminUsername: "admin",
      demo: false,
      requestedByAdminId: adminId,
    });
    expect(id).toBeGreaterThan(0);
    expect(tempPassword.length).toBeGreaterThanOrEqual(10);

    const row = (await db().select().from(companyProvisionRequests).where(eq(companyProvisionRequests.id, id)).limit(1))[0];
    expect(row.status).toBe("PENDING");
    expect(row.tempPasswordEncrypted).not.toBeNull();
    expect(row.tempPasswordEncrypted).not.toContain(tempPassword); // مشفّرة فعلاً لا نصّية
  });

  it("يرفض رمزاً غير صالح (ليس kebab-case)", async () => {
    const adminId = await seedPlatformAdmin();
    await expect(
      createProvisionRequest({ code: "Acme_Co!", name: "x", adminEmail: "a@b.com", adminUsername: "admin", demo: false, requestedByAdminId: adminId })
    ).rejects.toThrow(/kebab-case/);
  });

  it("يرفض رمزاً تستعمله شركة قائمة فعلاً", async () => {
    const adminId = await seedPlatformAdmin();
    await db().insert(companies).values({
      code: "acme", name: "أكمي", dbHost: "127.0.0.1", dbPort: 3310, dbName: "erp_co_acme", dbUser: "u_acme", dbPasswordEncrypted: "v1:x:y:z",
    });
    await expect(
      createProvisionRequest({ code: "acme", name: "أكمي ٢", adminEmail: "a@b.com", adminUsername: "admin", demo: false, requestedByAdminId: adminId })
    ).rejects.toThrow(/مستخدَم/);
  });

  it("يرفض طلباً ثانياً بنفس الرمز طالما الأول PENDING/PROCESSING", async () => {
    const adminId = await seedPlatformAdmin();
    await createProvisionRequest({ code: "acme", name: "أكمي", adminEmail: "a@b.com", adminUsername: "admin", demo: false, requestedByAdminId: adminId });
    await expect(
      createProvisionRequest({ code: "acme", name: "أكمي ٢", adminEmail: "c@d.com", adminUsername: "admin", demo: false, requestedByAdminId: adminId })
    ).rejects.toThrow(/قيد التنفيذ/);
  });

  it("مراجعة عدائية (٣/٧): طلبان متزامنان بنفس الرمز — واحد فقط ينجح (لا سباق TOCTOU)", async () => {
    // يثبت أن uq_provision_active_code (قيد DB حقيقي) يحسم السباق بين فحص التفرّد
    // التطبيقي والإدراج — لا الفحص وحده (الذي كان عرضة لسباق حقيقي قبل هذا الإصلاح).
    const adminId = await seedPlatformAdmin();
    const results = await Promise.allSettled([
      createProvisionRequest({ code: "acme", name: "أكمي A", adminEmail: "a@b.com", adminUsername: "admin", demo: false, requestedByAdminId: adminId }),
      createProvisionRequest({ code: "acme", name: "أكمي B", adminEmail: "c@d.com", adminUsername: "admin", demo: false, requestedByAdminId: adminId }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason?.message).toMatch(/قيد التنفيذ/);

    // صفّ نشط واحد فقط بهذا الرمز في companyProvisionRequests — لا صفّان.
    const activeRows = await db()
      .select()
      .from(companyProvisionRequests)
      .where(and(eq(companyProvisionRequests.code, "acme"), inArray(companyProvisionRequests.status, ["PENDING", "PROCESSING"])));
    expect(activeRows).toHaveLength(1);
  });

  it("طلب سابق فشل (FAILED) لا يمنع طلباً جديداً بنفس الرمز", async () => {
    const adminId = await seedPlatformAdmin();
    const first = await createProvisionRequest({ code: "acme", name: "أكمي", adminEmail: "a@b.com", adminUsername: "admin", demo: false, requestedByAdminId: adminId });
    await markProvisionRequestFailed(first.id, "فشل تجريبي");
    await expect(
      createProvisionRequest({ code: "acme", name: "أكمي", adminEmail: "a@b.com", adminUsername: "admin", demo: false, requestedByAdminId: adminId })
    ).resolves.toBeDefined();
  });
});

describe("claimNextPendingRequest — مطالبة ذرّية بلا سباق مزدوج", () => {
  it("يطالب بأقدم طلب PENDING ويفكّ تشفير كلمة المرور بنجاح", async () => {
    const adminId = await seedPlatformAdmin();
    const { id, tempPassword } = await createProvisionRequest({
      code: "acme", name: "أكمي", adminEmail: "admin@acme.test", adminUsername: "adm", demo: true, requestedByAdminId: adminId,
    });
    const claimed = await claimNextPendingRequest();
    expect(claimed?.id).toBe(id);
    expect(claimed?.tempPassword).toBe(tempPassword);
    expect(claimed?.demo).toBe(true);

    const row = (await db().select().from(companyProvisionRequests).where(eq(companyProvisionRequests.id, id)).limit(1))[0];
    expect(row.status).toBe("PROCESSING");
    expect(row.startedAt).not.toBeNull();
  });

  it("لا يُعيد المطالبة بنفس الطلب مرّتين (أصبح PROCESSING)", async () => {
    const adminId = await seedPlatformAdmin();
    await createProvisionRequest({ code: "acme", name: "أكمي", adminEmail: "a@b.com", adminUsername: "admin", demo: false, requestedByAdminId: adminId });
    const first = await claimNextPendingRequest();
    expect(first).not.toBeNull();
    const second = await claimNextPendingRequest();
    expect(second).toBeNull();
  });

  it("مطالبتان متزامنتان لنفس الطلب الوحيد: واحدة فقط تفوز (لا سباق)", async () => {
    const adminId = await seedPlatformAdmin();
    await createProvisionRequest({ code: "acme", name: "أكمي", adminEmail: "a@b.com", adminUsername: "admin", demo: false, requestedByAdminId: adminId });
    const [a, b] = await Promise.all([claimNextPendingRequest(), claimNextPendingRequest()]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);
  });

  it("null إن لم يوجد طلب PENDING", async () => {
    expect(await claimNextPendingRequest()).toBeNull();
  });
});

describe("markProvisionRequestDone/Failed — حالات نهائية", () => {
  it("النجاح يمسح كلمة المرور المؤقّتة فوراً ويسجّل معرّف الشركة", async () => {
    const adminId = await seedPlatformAdmin();
    const { id } = await createProvisionRequest({ code: "acme", name: "أكمي", adminEmail: "a@b.com", adminUsername: "admin", demo: false, requestedByAdminId: adminId });
    await claimNextPendingRequest();
    await markProvisionRequestDone(id, 999);

    const row = (await db().select().from(companyProvisionRequests).where(eq(companyProvisionRequests.id, id)).limit(1))[0];
    expect(row.status).toBe("DONE");
    expect(row.resultCompanyId).toBe(999);
    expect(row.tempPasswordEncrypted).toBeNull();
    expect(row.completedAt).not.toBeNull();
  });

  it("الفشل يُبقي كلمة المرور المشفّرة (يتيح إعادة محاولة الطلب نفسه)", async () => {
    const adminId = await seedPlatformAdmin();
    const { id } = await createProvisionRequest({ code: "acme", name: "أكمي", adminEmail: "a@b.com", adminUsername: "admin", demo: false, requestedByAdminId: adminId });
    await claimNextPendingRequest();
    await markProvisionRequestFailed(id, "docker exec فشل");

    const row = (await db().select().from(companyProvisionRequests).where(eq(companyProvisionRequests.id, id)).limit(1))[0];
    expect(row.status).toBe("FAILED");
    expect(row.errorMessage).toMatch(/docker exec/);
    expect(row.tempPasswordEncrypted).not.toBeNull();
  });
});

describe("getProvisionRequestStatus/listRecentProvisionRequests — لا تسريب كلمة مرور", () => {
  it("الحالة والقائمة لا تحملان حقل tempPasswordEncrypted إطلاقاً", async () => {
    const adminId = await seedPlatformAdmin();
    const { id } = await createProvisionRequest({ code: "acme", name: "أكمي", adminEmail: "a@b.com", adminUsername: "admin", demo: false, requestedByAdminId: adminId });

    const status = await getProvisionRequestStatus(id);
    expect(status).not.toBeNull();
    expect(status).not.toHaveProperty("tempPasswordEncrypted");
    expect(status?.status).toBe("PENDING");

    const list = await listRecentProvisionRequests();
    expect(list.some((r) => r.id === id)).toBe(true);
    expect(list.every((r) => !("tempPasswordEncrypted" in r))).toBe(true);
  });
});

describe("platformAdminRouter.companies — طبقة الراوتر", () => {
  it("requestCreate يُعيد requestId + tempPassword، ويُسجَّل التدقيق", async () => {
    const adminId = await seedPlatformAdmin();
    const caller = callerWithPlatformAdmin(adminId, "pa@test.local");
    const res = await caller.platformAdmin.companies.requestCreate({
      code: "acme", name: "أكمي", adminEmail: "admin@acme.test", adminUsername: "admin", demo: false,
    });
    expect(res.requestId).toBeGreaterThan(0);
    expect(res.tempPassword.length).toBeGreaterThanOrEqual(10);
  });

  it("requestCreate يرفض بريداً غير صالح (zod)", async () => {
    const adminId = await seedPlatformAdmin();
    const caller = callerWithPlatformAdmin(adminId, "pa@test.local");
    await expect(
      caller.platformAdmin.companies.requestCreate({ code: "acme", name: "أكمي", adminEmail: "not-an-email", adminUsername: "admin", demo: false })
    ).rejects.toThrow();
  });

  it("provisionStatus/provisionRequests يعملان عبر الراوتر بلا كلمة مرور", async () => {
    const adminId = await seedPlatformAdmin();
    const caller = callerWithPlatformAdmin(adminId, "pa@test.local");
    const created = await caller.platformAdmin.companies.requestCreate({
      code: "acme", name: "أكمي", adminEmail: "admin@acme.test", adminUsername: "admin", demo: false,
    });
    const status = await caller.platformAdmin.companies.provisionStatus({ requestId: created.requestId });
    expect(status?.status).toBe("PENDING");

    const list = await caller.platformAdmin.companies.provisionRequests();
    expect(list.some((r) => r.id === created.requestId)).toBe(true);
  });
});
