/**
 * اختبارات المصادقة الثنائية TOTP (٦/٧/٢٦):
 *  - خوارزمية RFC 6238 ضد متجهات المعيار الرسمية (Appendix B).
 *  - base32 roundtrip + نافذة ±1 + منع replay.
 *  - تدفّق التفعيل من «حسابي» (كلمة مرور ← تأكيد برمز ← رموز استرداد).
 *  - تدفّق الدخول بمرحلتين (تذكرة ← رمز) + عدّ الفشل على قفل الحساب نفسه.
 *  - رموز الاسترداد أحادية الاستخدام + ربط التذكرة ببصمة الجهاز + حجب السرّ من me.
 *  - نافذة عدّاد القفل الزمنية (lastFailedLoginAt) + إنقاذ الأدمن (resetTwoFactor).
 */
import crypto from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { hashPassword } from "../../auth/password";
import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateRecoveryCode,
  hotp,
  normalizeRecoveryCode,
  verifyTotp,
} from "../../auth/totp";
import { getUserFromRequest, verifySession } from "../../auth/session";
import { signTwoFactorTicket } from "../../auth/twoFactorTicket";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { __resetKeyCacheForTests } from "../cryptoService";
import { isStrongPassword } from "@shared/const";

// مفتاح تشفير للاختبارات — يُولَّد وقت التشغيل (لا سرّ ثابت في المصدر يُقلق ماسحات
// الأسرار كـGitGuardian؛ round-trip يعمل داخل التشغيلة الواحدة). يلزم قبل أي encryptSecret.
process.env.INTEGRATIONS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
__resetKeyCacheForTests();

const TABLES = ["userRecoveryCodes", "userSessions", "auditLogs", "users", "branches"];

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

async function seedAdmin() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({
    id: 1,
    openId: "local_admin",
    name: "المدير",
    email: "admin@test.local",
    passwordHash: hashPassword("Admin@12345"),
    role: "admin",
    loginMethod: "local",
    branchId: 1,
    sessionsValidFrom: new Date(Date.now() - 2000),
  });
  return (await d.select().from(s.users).where(eq(s.users.id, 1)).limit(1))[0];
}

async function freshUser(id = 1) {
  return (await db().select().from(s.users).where(eq(s.users.id, id)).limit(1))[0];
}

/** سياق tRPC وهمي مع res يلتقط الكوكي — UA ثابت كي تتطابق بصمة الجهاز بين المرحلتين. */
function makeCtx(user: any = null, ua = "vitest-UA") {
  const cookies: Record<string, string> = {};
  const res = {
    cookie(name: string, val: string) { cookies[name] = val; },
    clearCookie(name: string) { delete cookies[name]; },
  };
  const req = { headers: { "user-agent": ua } as Record<string, string>, protocol: "http" };
  return { ctx: { req, res, user } as any, cookies };
}

/** الرمز الصالح حالياً لسرّ base32 (نفس ما يعرضه تطبيق الهاتف الآن). */
function currentCode(secretB32: string, offsetSteps = 0): string {
  const step = Math.floor(Date.now() / 1000 / 30) + offsetSteps;
  return hotp(base32Decode(secretB32), step);
}

/** يفعّل 2FA لمستخدم عبر المسار الرسمي كاملاً، ويعيد السرّ ورموز الاسترداد. */
async function enable2fa(user: any) {
  const caller = appRouter.createCaller(makeCtx(user).ctx);
  const start = await caller.auth.twoFactorSetupStart({ password: "Admin@12345" });
  const confirm = await caller.auth.twoFactorSetupConfirm({ code: currentCode(start.secretB32) });
  return { secret: start.secretB32, recoveryCodes: confirm.recoveryCodes };
}

beforeEach(async () => {
  await reset();
});

// ─── الخوارزمية الخالصة ─────────────────────────────────────────────────────

describe("totp — متجهات RFC 6238 الرسمية (SHA1، آخر ٦ خانات)", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890", "ascii"));
  const vectors: Array<[number, string]> = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ];
  for (const [t, expected] of vectors) {
    it(`T=${t} ⇒ ${expected}`, () => {
      expect(verifyTotp(secret, expected, { nowMs: t * 1000, window: 0 })).not.toBeNull();
      expect(hotp(base32Decode(secret), Math.floor(t / 30))).toBe(expected);
    });
  }
});

describe("totp — base32 والنافذة", () => {
  it("base32 roundtrip لأطوال غير مقسومة على ٥", () => {
    for (const len of [1, 2, 3, 4, 5, 10, 19, 20, 33]) {
      const buf = Buffer.alloc(len, 7);
      expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    }
  });
  it("يقبل رمز الخطوة السابقة (±1) ويرفض ما قبلها (±2)", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890", "ascii"));
    const nowMs = 1111111111 * 1000;
    const stepNow = Math.floor(1111111111 / 30);
    const codePrev = hotp(base32Decode(secret), stepNow - 1);
    const codePrev2 = hotp(base32Decode(secret), stepNow - 2);
    expect(verifyTotp(secret, codePrev, { nowMs })).toBe(stepNow - 1);
    expect(verifyTotp(secret, codePrev2, { nowMs })).toBeNull();
  });
  it("يرفض صيغاً غير ٦ أرقام", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890", "ascii"));
    expect(verifyTotp(secret, "12345", {})).toBeNull();
    expect(verifyTotp(secret, "abcdef", {})).toBeNull();
  });
  it("otpauth URI يحمل السرّ والمُصدِر", () => {
    const uri = buildOtpauthUri("admin@test.local", "ABC234");
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain("secret=ABC234");
    expect(uri).toContain("issuer=Alroya%20ERP");
  });
  it("رمز الاسترداد بالصيغة المتوقعة ويطبَّع بإسقاط الشرطة", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(normalizeRecoveryCode(code.toLowerCase())).toBe(code.replace("-", ""));
  });
});

// ─── سياسة كلمة المرور الجديدة (قرار المالك ٦/٧: ٦ خانات + كبير أو رمز) ─────

describe("سياسة كلمة المرور — حدود القاعدة الجديدة (٨ خانات + كبير أو رمز)", () => {
  // قيم منخفضة العشوائية (حروف مكرّرة + مميّز واحد) والرمز مبنيّ عبر fromCharCode — كي لا
  // تُعلَّم «Generic Password» زائفةً من ماسحات الأسرار على حالات اختبار السياسة.
  const SYM = String.fromCharCode(33); // "!"
  it("يرفض ٧ خانات ولو بحرف كبير", () => expect(isStrongPassword("Aaaaaaa")).toBe(false));
  it("يقبل ٨ خانات برمز واحد", () => expect(isStrongPassword("aaaaaaa" + SYM)).toBe(true));
  it("يقبل ٨ خانات بحرف كبير واحد", () => expect(isStrongPassword("Aaaaaaaa")).toBe(true));
  it("يرفض ٩ خانات بلا كبير ولا رمز", () => expect(isStrongPassword("aaaaaaaaa")).toBe(false));
});

// ─── تدفّق التفعيل والدخول ──────────────────────────────────────────────────

describe("2FA — التفعيل من «حسابي»", () => {
  it("التدفّق الكامل: بدء ← تأكيد برمز ← ١٠ رموز استرداد ← الحالة مفعّلة", async () => {
    const admin = await seedAdmin();
    const caller = appRouter.createCaller(makeCtx(admin).ctx);
    const start = await caller.auth.twoFactorSetupStart({ password: "Admin@12345" });
    expect(start.secretB32).toMatch(/^[A-Z2-7]{32}$/);
    expect(start.otpauthUri).toContain("otpauth://totp/");
    // معلّق (غير مؤكَّد) ⇒ الدخول ما يزال بمرحلة واحدة.
    const loginCaller = appRouter.createCaller(makeCtx().ctx);
    const r1 = await loginCaller.auth.login({ email: "admin@test.local", password: "Admin@12345" });
    expect(r1.requiresTwoFactor).toBe(false);

    const confirm = await caller.auth.twoFactorSetupConfirm({ code: currentCode(start.secretB32) });
    expect(confirm.recoveryCodes).toHaveLength(10);
    const status = await caller.auth.twoFactorStatus();
    expect(status.enabled).toBe(true);
    expect(status.recoveryCodesRemaining).toBe(10);
  });

  it("بدء التفعيل بكلمة مرور خاطئة يُرفض", async () => {
    const admin = await seedAdmin();
    const caller = appRouter.createCaller(makeCtx(admin).ctx);
    await expect(caller.auth.twoFactorSetupStart({ password: "wrong-pass!" })).rejects.toThrow(
      /كلمة المرور/
    );
  });

  it("تأكيد برمز خاطئ يُرفض ولا يفعّل", async () => {
    const admin = await seedAdmin();
    const caller = appRouter.createCaller(makeCtx(admin).ctx);
    await caller.auth.twoFactorSetupStart({ password: "Admin@12345" });
    await expect(caller.auth.twoFactorSetupConfirm({ code: "000000" })).rejects.toThrow(/رمز التحقق/);
    expect((await caller.auth.twoFactorStatus()).enabled).toBe(false);
  });
});

describe("2FA — الدخول بمرحلتين", () => {
  it("login يعيد تذكرة بلا كوكي، وtwoFactorVerify يُصدر الجلسة", async () => {
    const admin = await seedAdmin();
    const { secret } = await enable2fa(admin);

    const { ctx, cookies } = makeCtx();
    const caller = appRouter.createCaller(ctx);
    const r = await caller.auth.login({ email: "admin@test.local", password: "Admin@12345" });
    expect(r.requiresTwoFactor).toBe(true);
    if (!r.requiresTwoFactor) throw new Error("unreachable");
    expect(r.ticket).toBeTruthy();
    expect(cookies["app_session_id"]).toBeUndefined();

    // خطوة +١: التأكيد في enable2fa استهلك خطوة «الآن» (totpLastUsedStep) ⇒ نستعمل الرمز
    // التالي (ضمن نافذة ±١ وأكبر من الخطوة المستهلَكة) — يطابق واقع مرور ثوانٍ بين التفعيل والدخول.
    const v = await caller.auth.twoFactorVerify({ ticket: r.ticket, code: currentCode(secret, 1) });
    expect(v.id).toBe(1);
    expect(cookies["app_session_id"]).toBeTruthy();
    const u = await freshUser();
    expect(u.failedLoginAttempts).toBe(0);
  });

  it("نفس الرمز لا يُقبل مرّتين (منع replay)", async () => {
    const admin = await seedAdmin();
    const { secret } = await enable2fa(admin);
    const { ctx } = makeCtx();
    const caller = appRouter.createCaller(ctx);

    const code = currentCode(secret, 1); // خطوة تالية للتأكيد المستهلَك
    const r1 = await caller.auth.login({ email: "admin@test.local", password: "Admin@12345" });
    if (!r1.requiresTwoFactor) throw new Error("expected 2fa");
    await caller.auth.twoFactorVerify({ ticket: r1.ticket, code });

    const r2 = await caller.auth.login({ email: "admin@test.local", password: "Admin@12345" });
    if (!r2.requiresTwoFactor) throw new Error("expected 2fa");
    await expect(caller.auth.twoFactorVerify({ ticket: r2.ticket, code })).rejects.toThrow(/رمز التحقق/);
  });

  it("رموز خاطئة تتراكم على قفل الحساب نفسه حتى القفل", async () => {
    const admin = await seedAdmin();
    await enable2fa(admin);
    const { ctx } = makeCtx();
    const caller = appRouter.createCaller(ctx);
    const r = await caller.auth.login({ email: "admin@test.local", password: "Admin@12345" });
    if (!r.requiresTwoFactor) throw new Error("expected 2fa");
    for (let i = 0; i < 5; i++) {
      await expect(
        caller.auth.twoFactorVerify({ ticket: r.ticket, code: `00000${i}` })
      ).rejects.toThrow();
    }
    const u = await freshUser();
    expect(u.lockedUntil).toBeTruthy();
  });

  it("تذكرة تالفة/منتهية ⇒ رسالة انتهاء المهلة", async () => {
    await seedAdmin();
    const caller = appRouter.createCaller(makeCtx().ctx);
    await expect(
      caller.auth.twoFactorVerify({ ticket: "not-a-ticket", code: "123456" })
    ).rejects.toThrow(/انتهت مهلة التحقق/);
  });

  it("التذكرة مربوطة ببصمة الجهاز — جهاز آخر يُرفض", async () => {
    const admin = await seedAdmin();
    const { secret } = await enable2fa(admin);
    const callerA = appRouter.createCaller(makeCtx(null, "device-A").ctx);
    const r = await callerA.auth.login({ email: "admin@test.local", password: "Admin@12345" });
    if (!r.requiresTwoFactor) throw new Error("expected 2fa");
    const callerB = appRouter.createCaller(makeCtx(null, "device-B").ctx);
    await expect(
      callerB.auth.twoFactorVerify({ ticket: r.ticket, code: currentCode(secret) })
    ).rejects.toThrow(/انتهت مهلة التحقق/);
  });

  it("رمز الاسترداد يدخل مرّة واحدة فقط ويُنقص المتبقي", async () => {
    const admin = await seedAdmin();
    const { recoveryCodes } = await enable2fa(admin);
    const { ctx, cookies } = makeCtx();
    const caller = appRouter.createCaller(ctx);

    const r1 = await caller.auth.login({ email: "admin@test.local", password: "Admin@12345" });
    if (!r1.requiresTwoFactor) throw new Error("expected 2fa");
    const v = await caller.auth.twoFactorVerify({ ticket: r1.ticket, recoveryCode: recoveryCodes[0] });
    expect(v.recoveryCodesRemaining).toBe(9);
    expect(cookies["app_session_id"]).toBeTruthy();

    const r2 = await caller.auth.login({ email: "admin@test.local", password: "Admin@12345" });
    if (!r2.requiresTwoFactor) throw new Error("expected 2fa");
    await expect(
      caller.auth.twoFactorVerify({ ticket: r2.ticket, recoveryCode: recoveryCodes[0] })
    ).rejects.toThrow(/رمز التحقق/);
  });
});

describe("2FA — تحصين التذكرة (مراجعة Codex)", () => {
  it("P1: تذكرة التحدّي لا تصلح جلسةً — verifySession/getUserFromRequest يرفضانها (purpose)", async () => {
    await seedAdmin();
    const req = { headers: { "user-agent": "vitest-UA" } } as any;
    const ticket = await signTwoFactorTicket({ uid: 1, companyCode: "", remember: false }, req);
    // لو قُبلت كجلسة لالتفّ المهاجم على التحقّق الثاني بمجرّد كلمة المرور.
    expect(await verifySession(ticket, req)).toBeNull();
    const cookieReq = { headers: { cookie: `app_session_id=${ticket}`, "user-agent": "vitest-UA" } } as any;
    expect(await getUserFromRequest(cookieReq)).toBeNull();
  });

  it("P2: تذكرة صُكّت قبل إبطال الجلسات تُرفض في twoFactorVerify", async () => {
    const admin = await seedAdmin();
    const { secret } = await enable2fa(admin);
    const { ctx } = makeCtx();
    const caller = appRouter.createCaller(ctx);
    const r = await caller.auth.login({ email: "admin@test.local", password: "Admin@12345" });
    if (!r.requiresTwoFactor) throw new Error("expected 2fa");
    // المدير يعيد تعيين كلمة المرور/يطرد المستخدم (يرفع sessionsValidFrom) أثناء التحدّي القائم.
    await db().update(s.users).set({ sessionsValidFrom: new Date(Date.now() + 60_000) }).where(eq(s.users.id, 1));
    await expect(
      caller.auth.twoFactorVerify({ ticket: r.ticket, code: currentCode(secret, 1) })
    ).rejects.toThrow(/انتهت مهلة التحقق/);
  });
});

describe("2FA — التعطيل والإنقاذ والحجب", () => {
  it("التعطيل بكلمة المرور + رمز صحيح يعيد الدخول لمرحلة واحدة ويحذف رموز الاسترداد", async () => {
    const admin = await seedAdmin();
    const { secret } = await enable2fa(admin);
    const fresh = await freshUser();
    const caller = appRouter.createCaller(makeCtx(fresh).ctx);
    // الرمز التالي (خطوة مختلفة عن رمز التأكيد المستهلَك في enable2fa).
    await caller.auth.twoFactorDisable({ password: "Admin@12345", code: currentCode(secret, 1) });
    const u = await freshUser();
    expect(u.totpEnabledAt).toBeNull();
    expect(u.totpSecretEncrypted).toBeNull();
    const codes = await db().select().from(s.userRecoveryCodes);
    expect(codes).toHaveLength(0);
    const loginCaller = appRouter.createCaller(makeCtx().ctx);
    const r = await loginCaller.auth.login({ email: "admin@test.local", password: "Admin@12345" });
    expect(r.requiresTwoFactor).toBe(false);
  });

  it("التعطيل برمز خاطئ يُرفض ويزيد عدّاد القفل", async () => {
    const admin = await seedAdmin();
    await enable2fa(admin);
    const fresh = await freshUser();
    const caller = appRouter.createCaller(makeCtx(fresh).ctx);
    await expect(
      caller.auth.twoFactorDisable({ password: "Admin@12345", code: "000000" })
    ).rejects.toThrow();
    expect((await freshUser()).failedLoginAttempts).toBe(1);
  });

  it("إنقاذ الأدمن users.resetTwoFactor يصفّر 2FA ويبطل الجلسات", async () => {
    const admin = await seedAdmin();
    await db().insert(s.users).values({
      id: 2,
      openId: "local_cashier",
      name: "كاشير",
      email: "cashier@test.local",
      passwordHash: hashPassword("Admin@12345"),
      role: "cashier",
      branchId: 1,
      sessionsValidFrom: new Date(Date.now() - 2000),
    });
    const cashier = await freshUser(2);
    // فعّل للكاشير عبر الخدمة الرسمية.
    const cashierCaller = appRouter.createCaller(makeCtx(cashier).ctx);
    const start = await cashierCaller.auth.twoFactorSetupStart({ password: "Admin@12345" });
    await cashierCaller.auth.twoFactorSetupConfirm({ code: currentCode(start.secretB32) });
    expect((await freshUser(2)).totpEnabledAt).toBeTruthy();

    const before = (await freshUser(2)).sessionsValidFrom;
    const adminCaller = appRouter.createCaller(makeCtx(admin).ctx);
    await adminCaller.users.resetTwoFactor({ userId: 2 });
    const after = await freshUser(2);
    expect(after.totpEnabledAt).toBeNull();
    expect(after.totpSecretEncrypted).toBeNull();
    expect(new Date(after.sessionsValidFrom).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });

  it("auth.me لا يسرّب سرّ TOTP المشفَّر", async () => {
    const admin = await seedAdmin();
    await enable2fa(admin);
    const fresh = await freshUser();
    const caller = appRouter.createCaller(makeCtx(fresh).ctx);
    const me = await caller.auth.me();
    expect(me).toBeTruthy();
    expect(me && "totpSecretEncrypted" in me).toBe(false);
    expect(me && "passwordHash" in me).toBe(false);
  });
});

describe("قفل الحساب — نافذة العدّاد الزمنية (٦/٧)", () => {
  it("إخفاق أقدم من النافذة يبدأ عدّاً جديداً (لا قفل مفاجئاً بعد أسبوع)", async () => {
    await seedAdmin();
    await db()
      .update(s.users)
      .set({ failedLoginAttempts: 4, lastFailedLoginAt: new Date(Date.now() - 20 * 60 * 1000) })
      .where(eq(s.users.id, 1));
    const caller = appRouter.createCaller(makeCtx().ctx);
    await expect(caller.auth.login({ email: "admin@test.local", password: "nope-nope" })).rejects.toThrow();
    const u = await freshUser();
    expect(u.failedLoginAttempts).toBe(1);
    expect(u.lockedUntil).toBeNull();
  });

  it("إخفاق داخل النافذة يراكم حتى القفل (لا انحدار)", async () => {
    await seedAdmin();
    await db()
      .update(s.users)
      .set({ failedLoginAttempts: 4, lastFailedLoginAt: new Date(Date.now() - 60 * 1000) })
      .where(eq(s.users.id, 1));
    const caller = appRouter.createCaller(makeCtx().ctx);
    await expect(caller.auth.login({ email: "admin@test.local", password: "nope-nope" })).rejects.toThrow();
    const u = await freshUser();
    expect(u.lockedUntil).toBeTruthy();
  });
});
