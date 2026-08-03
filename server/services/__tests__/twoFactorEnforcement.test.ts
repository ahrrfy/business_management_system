/**
 * M9 (تدقيق ٣/٨) — إلزام المصادقة الثنائية (2FA) خادمياً للمدير/المشرف.
 *
 * الفجوة المُغلَقة: كانت راية `mustEnroll2FA` توجيهاً واجهياً فقط (ForceTwoFactorEnroll يحجب الشاشة)
 * فعميلٌ غير قياسيّ أو استدعاء API مباشر يتجاوزها ويعمل بكامل الصلاحية بلا عاملٍ ثانٍ. الآن تُحجب
 * كل الإجراءات (عدا مسارات التفعيل) خادمياً لدورٍ مُلزَمٍ (admin/manager) لم يُفعّل 2FA.
 *
 * بوّابات إنقاذ الأدمن المُثبَتة هنا: (١) مسارات التفعيل مُستثناة، (٢) مفتاح الإيقاف
 * TWO_FACTOR_ENFORCEMENT=off يُعطّل الإنفاذ. (isCryptoReady مضبوط في __setup__ فالإنفاذ فعّال ما لم يُطفأ.)
 *
 * ملاحظة: __setup__.ts يضبط TWO_FACTOR_ENFORCEMENT=off عالمياً (وإلا حُجبت مئات اختبارات createCaller
 * لأن بذورها admin/manager بلا 2FA). كل حالةٍ هنا تضبط القيمة صراحةً ثم تعيدها إلى "off".
 */
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { twoFactorEnrollmentRequired } from "../../trpc";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of ["invoices", "customers", "users", "branches"]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}
async function seed() {
  await db().insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
}

/** caller بدور + حالة تفعيل 2FA اختيارية (totpEnabledAt). undefined ⇒ غير مُفعّل. */
function caller(role: string, opts: { totpEnabledAt?: Date | null; override?: Record<string, string> | null } = {}) {
  const ctx = {
    req: { headers: {} },
    res: { cookie() {}, clearCookie() {} },
    user: { id: 1, role, branchId: 1, permissionsOverride: opts.override ?? null, totpEnabledAt: opts.totpEnabledAt ?? null },
  } as any;
  return appRouter.createCaller(ctx);
}

const TWO_FA_REQUIRED = /المصادقة الثنائية/;

function enforce(on: boolean) {
  if (on) delete process.env.TWO_FACTOR_ENFORCEMENT; // أي قيمة ≠ "off" تُفعّل؛ الحذف يُفعّل.
  else process.env.TWO_FACTOR_ENFORCEMENT = "off";
}

beforeEach(async () => { await reset(); await seed(); });
afterEach(() => { process.env.TWO_FACTOR_ENFORCEMENT = "off"; });

describe("M9 — الإنفاذ الخادميّ فعّال (TWO_FACTOR_ENFORCEMENT مُفعَّل)", () => {
  beforeEach(() => enforce(true));

  it("admin بلا 2FA ⇒ يُحجب عن إجراءٍ عاديّ (customers.list)", async () => {
    await expect(caller("admin").customers.list()).rejects.toThrow(TWO_FA_REQUIRED);
  });

  it("manager بلا 2FA ⇒ يُحجب عبر بوّابة الوحدة (reports.arAging)", async () => {
    await expect(caller("manager").reports.arAging({ branchId: 1 })).rejects.toThrow(TWO_FA_REQUIRED);
  });

  it("admin مُفعِّل 2FA ⇒ يمرّ (لا حجب)", async () => {
    await expect(caller("admin", { totpEnabledAt: new Date() }).customers.list()).resolves.toBeDefined();
  });

  it("cashier (دور غير مُلزَم) بلا 2FA ⇒ لا يُحجب بسبب 2FA", async () => {
    // قد يُرفَض لسببٍ آخر (صلاحية وحدة) لكن ليس برسالة 2FA.
    try {
      await caller("cashier").customers.list();
    } catch (e: any) {
      expect(String(e?.message)).not.toMatch(TWO_FA_REQUIRED);
    }
  });

  it("مسار التفعيل (auth.twoFactorSetupStart) مُستثنى ⇒ لا يُحجب بـ2FA حتى لأدمن غير مُفعِّل", async () => {
    // سيفشل لسببٍ آخر (لا صفّ مستخدم/كلمة مرور خاطئة) — المهم ألّا تكون الرسالة رسالة إلزام 2FA.
    try {
      await caller("admin").auth.twoFactorSetupStart({ password: "whatever" });
    } catch (e: any) {
      expect(String(e?.message)).not.toMatch(TWO_FA_REQUIRED);
    }
  });
});

describe("M9 — بوّابة إنقاذ الأدمن: مفتاح الإيقاف يُعطّل الإنفاذ", () => {
  it("TWO_FACTOR_ENFORCEMENT=off ⇒ admin بلا 2FA يمرّ (رغم لزوم الدور)", async () => {
    enforce(false);
    await expect(caller("admin").customers.list()).resolves.toBeDefined();
  });
});

describe("M9 — منطق twoFactorEnrollmentRequired", () => {
  afterEach(() => { process.env.TWO_FACTOR_ENFORCEMENT = "off"; });

  it("مفتاح الإيقاف ⇒ false مهما كان الدور", () => {
    process.env.TWO_FACTOR_ENFORCEMENT = "off";
    expect(twoFactorEnrollmentRequired({ role: "admin", totpEnabledAt: null })).toBe(false);
  });

  it("مُفعَّل + admin بلا 2FA ⇒ true", () => {
    enforce(true);
    expect(twoFactorEnrollmentRequired({ role: "admin", totpEnabledAt: null })).toBe(true);
  });

  it("مُفعَّل + manager مُفعِّل 2FA ⇒ false", () => {
    enforce(true);
    expect(twoFactorEnrollmentRequired({ role: "manager", totpEnabledAt: new Date() })).toBe(false);
  });

  it("مُفعَّل + cashier (غير مُلزَم) ⇒ false", () => {
    enforce(true);
    expect(twoFactorEnrollmentRequired({ role: "cashier", totpEnabledAt: null })).toBe(false);
  });
});
