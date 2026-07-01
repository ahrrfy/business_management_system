/**
 * اختبارات integrationService (tokens التكاملات الخارجية: WhatsApp/Instagram/Store) — فجوة موثَّقة:
 * upsertIntegration بدلالات partial-update حسّاسة (undefined=لا تُغيَّر / null=امسح / string=اكتب)
 * على أسرار مشفَّرة (AES-256-GCM عبر cryptoService)، بصفر تغطية للمنطق الأعلى من cryptoService نفسها.
 * لا تُختبَر verifyWhatsAppConnection/verifyInstagramConnection (تضرب Meta API فعلياً — خارج نطاق
 * اختبار وحدة بلا mocking للشبكة)؛ فرع STORE في verifyIntegration لا يحتاج شبكة ⇒ مُختبَر.
 */
import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { __resetKeyCacheForTests, decryptSecret } from "../cryptoService";
import {
  deleteIntegration,
  findIntegrationByVerifyToken,
  getDecryptedIntegration,
  listIntegrations,
  setIntegrationStatus,
  upsertIntegration,
  verifyIntegration,
} from "../integrationService";

const ORIGINAL_KEY = process.env.INTEGRATIONS_ENCRYPTION_KEY;
const TEST_KEY_HEX = crypto.randomBytes(32).toString("hex");

const TABLES = ["channelIntegrations", "branches", "users"];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "local_admin", name: "المدير", role: "admin", loginMethod: "local" });
}

beforeEach(async () => {
  process.env.INTEGRATIONS_ENCRYPTION_KEY = TEST_KEY_HEX;
  __resetKeyCacheForTests();
  await reset();
  await seedBase();
});

afterAll(() => {
  if (ORIGINAL_KEY) process.env.INTEGRATIONS_ENCRYPTION_KEY = ORIGINAL_KEY;
  else delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
  __resetKeyCacheForTests();
});

async function rawRow(id: number) {
  return (await db().select().from(s.channelIntegrations).where(eq(s.channelIntegrations.id, id)))[0];
}

describe("upsertIntegration", () => {
  it("رفض: بلا INTEGRATIONS_ENCRYPTION_KEY ⇒ PRECONDITION_FAILED", async () => {
    delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
    __resetKeyCacheForTests();
    await expect(
      upsertIntegration({ branchId: 1, channel: "WHATSAPP", accessToken: "tok", updatedBy: 1 }),
    ).rejects.toThrow(/INTEGRATIONS_ENCRYPTION_KEY/);
  });

  it("إدراج جديد: يُشَفّر الأسرار ويَضبط status=PENDING", async () => {
    const r = await upsertIntegration({
      branchId: 1,
      channel: "WHATSAPP",
      displayName: "واتساب الفرع الرئيسي",
      phoneNumberId: "1234567890",
      verifyToken: "vtok-abc",
      appSecret: "secret-xyz",
      accessToken: "access-123",
      updatedBy: 1,
    });
    expect(r.isNew).toBe(true);

    const row = await rawRow(r.id);
    expect(row.status).toBe("PENDING");
    expect(row.displayName).toBe("واتساب الفرع الرئيسي");
    // الأسرار مُشَفَّرة في DB لا نصّاً عادياً.
    expect(row.encryptedVerifyToken).not.toBe("vtok-abc");
    expect(row.encryptedVerifyToken).toMatch(/^v1:/);
    expect(decryptSecret(row.encryptedVerifyToken)).toBe("vtok-abc");
    expect(decryptSecret(row.encryptedAppSecret)).toBe("secret-xyz");
    expect(decryptSecret(row.encryptedAccessToken)).toBe("access-123");
  });

  it("تحديث موجود: نفس الفرع+القناة ⇒ upsert على نفس الصفّ (isNew=false)، لا تكرار", async () => {
    const first = await upsertIntegration({ branchId: 1, channel: "WHATSAPP", accessToken: "a1", updatedBy: 1 });
    const second = await upsertIntegration({ branchId: 1, channel: "WHATSAPP", accessToken: "a2", updatedBy: 1 });
    expect(second.isNew).toBe(false);
    expect(second.id).toBe(first.id);
    const all = await db().select().from(s.channelIntegrations);
    expect(all).toHaveLength(1);
  });

  it("partial-update: تعديل displayName فقط (undefined لبقية الحقول) لا يمسّ الأسرار ولا يُعيد الحالة لِـPENDING", async () => {
    const created = await upsertIntegration({
      branchId: 1,
      channel: "WHATSAPP",
      accessToken: "keep-me",
      updatedBy: 1,
    });
    // فعّلها يدوياً لمحاكاة تكامل يعمل فعلاً.
    await db().update(s.channelIntegrations).set({ status: "ACTIVE" }).where(eq(s.channelIntegrations.id, created.id));

    await upsertIntegration({ branchId: 1, channel: "WHATSAPP", displayName: "اسم جديد فقط", updatedBy: 1 });

    const row = await rawRow(created.id);
    expect(row.displayName).toBe("اسم جديد فقط");
    expect(row.status).toBe("ACTIVE"); // لم يُعَد ضبطها PENDING — لم تُمَسّ أي سرّ
    expect(decryptSecret(row.encryptedAccessToken)).toBe("keep-me"); // لم يُمَسّ
  });

  it("partial-update: تعديل verifyToken فقط يُعيد status لِـPENDING ويمسح lastError، ويُبقي بقية الأسرار", async () => {
    const created = await upsertIntegration({
      branchId: 1,
      channel: "INSTAGRAM",
      appSecret: "secret-keep",
      accessToken: "access-keep",
      updatedBy: 1,
    });
    await db()
      .update(s.channelIntegrations)
      .set({ status: "FAILED", lastError: "خطأ سابق" })
      .where(eq(s.channelIntegrations.id, created.id));

    await upsertIntegration({ branchId: 1, channel: "INSTAGRAM", verifyToken: "new-vtok", updatedBy: 1 });

    const row = await rawRow(created.id);
    expect(row.status).toBe("PENDING");
    expect(row.lastError).toBeNull();
    expect(decryptSecret(row.encryptedVerifyToken)).toBe("new-vtok");
    expect(decryptSecret(row.encryptedAppSecret)).toBe("secret-keep"); // غير مُتأثّر
    expect(decryptSecret(row.encryptedAccessToken)).toBe("access-keep"); // غير مُتأثّر
  });

  it("مسح صريح: accessToken=null يمحو السرّ (لا يتركه undefined) ويُعيد الحالة PENDING", async () => {
    const created = await upsertIntegration({ branchId: 1, channel: "STORE", accessToken: "to-be-cleared", updatedBy: 1 });
    await db().update(s.channelIntegrations).set({ status: "ACTIVE" }).where(eq(s.channelIntegrations.id, created.id));

    await upsertIntegration({ branchId: 1, channel: "STORE", accessToken: null, updatedBy: 1 });

    const row = await rawRow(created.id);
    expect(row.encryptedAccessToken).toBeNull();
    expect(row.status).toBe("PENDING"); // accessToken !== undefined (حتى لو null) ⇒ يُعيد الضبط
  });

  it("فرعان/قناتان مختلفتان ⇒ صفّان مستقلّان بلا تصادم", async () => {
    await db().insert(s.branches).values({ id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" });
    const a = await upsertIntegration({ branchId: 1, channel: "WHATSAPP", accessToken: "x1", updatedBy: 1 });
    const b = await upsertIntegration({ branchId: 2, channel: "WHATSAPP", accessToken: "x2", updatedBy: 1 });
    const c = await upsertIntegration({ branchId: 1, channel: "INSTAGRAM", accessToken: "x3", updatedBy: 1 });
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });
});

describe("listIntegrations — العرض المُقنَّع", () => {
  it("يُقَنِّع الأسرار (لا نصّ عادي) ويَضمّ اسم الفرع، ويُصفّي بحسب branchId", async () => {
    await db().insert(s.branches).values({ id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" });
    await upsertIntegration({ branchId: 1, channel: "WHATSAPP", accessToken: "supersecrettoken1234", updatedBy: 1 });
    await upsertIntegration({ branchId: 2, channel: "WHATSAPP", accessToken: "othertoken", updatedBy: 1 });

    const all = await listIntegrations();
    expect(all).toHaveLength(2);
    const row1 = all.find((r) => r.branchId === 1)!;
    expect(row1.branchName).toBe("الرئيسي");
    expect(row1.accessTokenMasked).not.toBe("supersecrettoken1234");
    expect(row1.accessTokenMasked).not.toContain("supersecrettoken");
    expect(row1.accessTokenMasked?.endsWith("1234")).toBe(true);
    expect(row1.webhookUrl).toMatch(/whatsapp/);

    const scoped = await listIntegrations(2);
    expect(scoped).toHaveLength(1);
    expect(scoped[0].branchId).toBe(2);
  });

  it("سرّ تالف (ciphertext ملفَّق) ⇒ قناع null بلا استثناء يكسر العرض", async () => {
    const created = await upsertIntegration({ branchId: 1, channel: "STORE", accessToken: "x", updatedBy: 1 });
    await db()
      .update(s.channelIntegrations)
      .set({ encryptedAccessToken: "garbage-not-encrypted" })
      .where(eq(s.channelIntegrations.id, created.id));

    const rows = await listIntegrations(1);
    expect(rows[0].accessTokenMasked).toBeNull();
  });
});

describe("getDecryptedIntegration", () => {
  it("يُعيد الأسرار مفكوكة لتكامل ACTIVE/PENDING", async () => {
    await upsertIntegration({ branchId: 1, channel: "WHATSAPP", phoneNumberId: "555", accessToken: "tok-plain", updatedBy: 1 });
    const dec = await getDecryptedIntegration(1, "WHATSAPP");
    expect(dec).toBeTruthy();
    expect(dec!.accessToken).toBe("tok-plain");
    expect(dec!.phoneNumberId).toBe("555");
  });

  it("تكامل DISABLED ⇒ null (لا تستقبل/ترسل)", async () => {
    const created = await upsertIntegration({ branchId: 1, channel: "WHATSAPP", accessToken: "tok", updatedBy: 1 });
    await setIntegrationStatus(created.id, "DISABLED");
    expect(await getDecryptedIntegration(1, "WHATSAPP")).toBeNull();
  });

  it("لا تكامل لهذا الفرع/القناة ⇒ null", async () => {
    expect(await getDecryptedIntegration(1, "INSTAGRAM")).toBeNull();
  });
});

describe("findIntegrationByVerifyToken", () => {
  it("يطابق verifyToken المفكوك ويُعيد branchId", async () => {
    await upsertIntegration({ branchId: 1, channel: "WHATSAPP", verifyToken: "hook-secret-1", updatedBy: 1 });
    const found = await findIntegrationByVerifyToken("WHATSAPP", "hook-secret-1");
    expect(found).toEqual({ branchId: 1 });
  });

  it("يتجاهل تكاملات DISABLED حتى لو تطابق الرمز", async () => {
    const created = await upsertIntegration({ branchId: 1, channel: "WHATSAPP", verifyToken: "hook-secret-2", updatedBy: 1 });
    await setIntegrationStatus(created.id, "DISABLED");
    expect(await findIntegrationByVerifyToken("WHATSAPP", "hook-secret-2")).toBeNull();
  });

  it("لا تطابق ⇒ null", async () => {
    await upsertIntegration({ branchId: 1, channel: "WHATSAPP", verifyToken: "correct", updatedBy: 1 });
    expect(await findIntegrationByVerifyToken("WHATSAPP", "wrong")).toBeNull();
  });
});

describe("deleteIntegration / setIntegrationStatus", () => {
  it("deleteIntegration يحذف السجلّ فعلياً", async () => {
    const created = await upsertIntegration({ branchId: 1, channel: "STORE", accessToken: "x", updatedBy: 1 });
    await deleteIntegration(created.id);
    expect(await rawRow(created.id)).toBeUndefined();
  });

  it("setIntegrationStatus يبدّل الحالة بلا حذف", async () => {
    const created = await upsertIntegration({ branchId: 1, channel: "STORE", accessToken: "x", updatedBy: 1 });
    await setIntegrationStatus(created.id, "DISABLED");
    expect((await rawRow(created.id)).status).toBe("DISABLED");
    await setIntegrationStatus(created.id, "ACTIVE");
    expect((await rawRow(created.id)).status).toBe("ACTIVE");
  });
});

describe("verifyIntegration — فرع STORE (بلا شبكة)", () => {
  it("appSecret طويل بما يكفي (>=16) ⇒ ok=true ويُحدَّث status=ACTIVE", async () => {
    const created = await upsertIntegration({ branchId: 1, channel: "STORE", appSecret: "0123456789abcdef", updatedBy: 1 });
    const result = await verifyIntegration(created.id);
    expect(result.ok).toBe(true);
    const row = await rawRow(created.id);
    expect(row.status).toBe("ACTIVE");
    expect(row.lastVerifiedAt).toBeTruthy();
  });

  it("appSecret قصير (<16) ⇒ ok=false ويُحدَّث status=FAILED مع lastError", async () => {
    const created = await upsertIntegration({ branchId: 1, channel: "STORE", appSecret: "short", updatedBy: 1 });
    const result = await verifyIntegration(created.id);
    expect(result.ok).toBe(false);
    const row = await rawRow(created.id);
    expect(row.status).toBe("FAILED");
    expect(row.lastError).toBeTruthy();
  });

  it("تكامل غير موجود ⇒ ok=false بلا استثناء", async () => {
    const result = await verifyIntegration(999999);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/غَير مَوجود|غير موجود/);
  });
});
