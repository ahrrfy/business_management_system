import { eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { _clearAllMgrAttempts } from "../../routers/saleRouter";
import { hashPassword } from "../../auth/password";

const TABLES = [
  "auditLogs",
  "receipts",
  "invoices",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) {
    try {
      await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
    } catch {
      // ignore
    }
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

function makeCtx(user: any) {
  return {
    req: { headers: {} },
    res: { cookie() {}, clearCookie() {} },
    user,
  } as any;
}

async function userById(id: number) {
  return (await db().select().from(s.users).where(eq(s.users.id, id)).limit(1))[0];
}

describe("اعتماد المدير الشامل — باركود الشارة، رمز PIN السريع، كلمة المرور وسياسات SOD-03 وعزل الفروع", () => {
  let pwHash: string;
  let pin1Hash: string;
  let pin2Hash: string;

  beforeAll(async () => {
    pwHash = await hashPassword("ManagerPass123!");
    pin1Hash = await hashPassword("1234");
    pin2Hash = await hashPassword("9999");
  });

  beforeEach(async () => {
    _clearAllMgrAttempts();
    await reset();
    const d = db();

    // 1. الفروع
    await d.insert(s.branches).values([
      { id: 1, name: "فرع المنصور", code: "B1", type: "MAIN" },
      { id: 2, name: "فرع الكرادة", code: "B2", type: "SALES" },
    ]);

    // 2. المستخدمون
    await d.insert(s.users).values([
      // أدمن عام (فرع 1)
      {
        id: 1,
        openId: "admin-1",
        name: "المسؤول العام",
        email: "admin@test.local",
        username: "admin_user",
        passwordHash: pwHash,
        role: "admin",
        branchId: 1,
        isActive: true,
      },
      // كاشير عادي (فرع 1)
      {
        id: 2,
        openId: "cashier-1",
        name: "كاشير فرع 1",
        email: "cashier1@test.local",
        username: "cashier1",
        passwordHash: pwHash,
        role: "cashier",
        branchId: 1,
        isActive: true,
      },
      // مدير فرع 1 — يملك PIN وشارة باركود
      {
        id: 3,
        openId: "mgr-1",
        name: "مدير فرع 1",
        email: "mgr1@test.local",
        username: "mgr1",
        passwordHash: pwHash,
        pinHash: pin1Hash,
        badgeBarcode: "MGR-3-112233",
        role: "manager",
        branchId: 1,
        isActive: true,
      },
      // مدير فرع 2 — يملك PIN وشارة باركود
      {
        id: 4,
        openId: "mgr-2",
        name: "مدير فرع 2",
        email: "mgr2@test.local",
        username: "mgr2",
        passwordHash: pwHash,
        pinHash: pin2Hash,
        badgeBarcode: "MGR-4-445566",
        role: "manager",
        branchId: 2,
        isActive: true,
      },
      // مالك النظام (isOwner=true)
      {
        id: 5,
        openId: "owner-1",
        name: "المالك",
        email: "owner@test.local",
        username: "owner",
        passwordHash: pwHash,
        pinHash: pin1Hash,
        badgeBarcode: "MGR-5-778899",
        role: "admin",
        branchId: 1,
        isOwner: true,
        isActive: true,
      },
      // مدير معطّل (غير نشط)
      {
        id: 6,
        openId: "mgr-inactive",
        name: "مدير معطل",
        email: "mgrinact@test.local",
        username: "mgrinact",
        passwordHash: pwHash,
        pinHash: pin1Hash,
        badgeBarcode: "MGR-6-000000",
        role: "manager",
        branchId: 1,
        isActive: false,
      },
      // مدير بدون PIN
      {
        id: 7,
        openId: "mgr-nopin",
        name: "مدير بلا بين",
        email: "nopin@test.local",
        username: "nopin_mgr",
        passwordHash: pwHash,
        pinHash: null,
        badgeBarcode: "MGR-7-999999",
        role: "manager",
        branchId: 1,
        isActive: true,
      },
    ]);
  });

  describe("1. اعتماد باركود الشارة (Badge Barcode)", () => {
    it("ينجح مسح شارة مدير الفرع المعتمد ويعيد معرف المدير", async () => {
      const cashier = await userById(2);
      const caller = appRouter.createCaller(makeCtx(cashier));

      const res = await caller.sales.verifyManager({
        approval: {
          method: "BARCODE",
          barcode: "MGR-3-112233",
        },
        branchId: 1,
      });

      expect(res.success).toBe(true);
      expect(res.managerId).toBe(3);

      // التحقق من تسجيل الأثر في سجل التدقيق
      const logs = await db()
        .select()
        .from(s.auditLogs)
        .where(eq(s.auditLogs.action, "sale.creditOverride.success"));
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(Number(logs[0].entityId)).toBe(3);
    });

    it("يرفض باركود غير موجود في النظام", async () => {
      const cashier = await userById(2);
      const caller = appRouter.createCaller(makeCtx(cashier));

      await expect(
        caller.sales.verifyManager({
          approval: {
            method: "BARCODE",
            barcode: "UNKNOWN-BARCODE-999",
          },
          branchId: 1,
        }),
      ).rejects.toThrow(/غير صالح/);

      // تسجيل فشل في التدقيق
      const failLogs = await db()
        .select()
        .from(s.auditLogs)
        .where(eq(s.auditLogs.action, "sale.creditOverride.fail"));
      expect(failLogs.length).toBeGreaterThanOrEqual(1);
    });

    it("يرفض باركود شارة حساب معطل", async () => {
      const cashier = await userById(2);
      const caller = appRouter.createCaller(makeCtx(cashier));

      await expect(
        caller.sales.verifyManager({
          approval: {
            method: "BARCODE",
            barcode: "MGR-6-000000",
          },
          branchId: 1,
        }),
      ).rejects.toThrow(/غير صالح/);
    });
  });

  describe("2. اعتماد رمز PIN السريع (Quick PIN)", () => {
    it("ينجح اعتماد المدير عبر اسم المستخدم ورمز PIN الصحيح", async () => {
      const cashier = await userById(2);
      const caller = appRouter.createCaller(makeCtx(cashier));

      const res = await caller.sales.verifyManager({
        approval: {
          method: "PIN",
          identifier: "mgr1",
          pin: "1234",
        },
        branchId: 1,
      });

      expect(res.success).toBe(true);
      expect(res.managerId).toBe(3);
    });

    it("ينجح اعتماد المدير عبر البريد الإلكتروني ورمز PIN الصحيح", async () => {
      const cashier = await userById(2);
      const caller = appRouter.createCaller(makeCtx(cashier));

      const res = await caller.sales.verifyManager({
        approval: {
          method: "PIN",
          identifier: "mgr1@test.local",
          pin: "1234",
        },
        branchId: 1,
      });

      expect(res.success).toBe(true);
      expect(res.managerId).toBe(3);
    });

    it("يرفض رمز PIN غير الصحيح", async () => {
      const cashier = await userById(2);
      const caller = appRouter.createCaller(makeCtx(cashier));

      await expect(
        caller.sales.verifyManager({
          approval: {
            method: "PIN",
            identifier: "mgr1",
            pin: "0000",
          },
          branchId: 1,
        }),
      ).rejects.toThrow(/غير صحيح/);
    });

    it("يوضّح الخطأ إذا كان حساب المدير غير معيّن له رمز PIN بعد", async () => {
      const cashier = await userById(2);
      const caller = appRouter.createCaller(makeCtx(cashier));

      await expect(
        caller.sales.verifyManager({
          approval: {
            method: "PIN",
            identifier: "nopin_mgr",
            pin: "1234",
          },
          branchId: 1,
        }),
      ).rejects.toThrow(/لم يتم تعيين رمز PIN/);
    });
  });

  describe("3. اعتماد كلمة المرور التقليدي (Legacy Password Compatibility)", () => {
    it("ينجح اعتماد المدير عبر البريد وكلمة المرور", async () => {
      const cashier = await userById(2);
      const caller = appRouter.createCaller(makeCtx(cashier));

      const res = await caller.sales.verifyManager({
        approval: {
          method: "PASSWORD",
          email: "mgr1@test.local",
          password: "ManagerPass123!",
        },
        branchId: 1,
      });

      expect(res.success).toBe(true);
      expect(res.managerId).toBe(3);
    });

    it("يرفض اعتماد كلمة المرور غير الصحيحة", async () => {
      const cashier = await userById(2);
      const caller = appRouter.createCaller(makeCtx(cashier));

      await expect(
        caller.sales.verifyManager({
          approval: {
            method: "PASSWORD",
            email: "mgr1@test.local",
            password: "WrongPassword999",
          },
          branchId: 1,
        }),
      ).rejects.toThrow(/غير صالحة/);
    });
  });

  describe("4. سياسة فصل المهام (SOD-03: منع الاعتماد الذاتي)", () => {
    it("يمنع المدير من اعتماد عمليته بنفسه عند قيامه بدور الكاشير", async () => {
      const mgr1 = await userById(3);
      // المدير هو صاحب الجلسة
      const caller = appRouter.createCaller(makeCtx(mgr1));

      await expect(
        caller.sales.verifyManager({
          approval: {
            method: "BARCODE",
            barcode: "MGR-3-112233",
          },
          branchId: 1,
        }),
      ).rejects.toThrow(/فصل المهام/);
    });

    it("يسمح للمالك (isOwner=true) باعتماد عمليته ذاتياً كاستثناء للمالك", async () => {
      const owner = await userById(5);
      const caller = appRouter.createCaller(makeCtx(owner));

      const res = await caller.sales.verifyManager({
        approval: {
          method: "PIN",
          identifier: "owner",
          pin: "1234",
        },
        branchId: 1,
      });

      expect(res.success).toBe(true);
      expect(res.managerId).toBe(5);
    });
  });

  describe("5. عزل الفروع (Cross-Branch Isolation)", () => {
    it("يمنع مدير فرع 1 من اعتماد عملية في فرع 2", async () => {
      const cashier = await userById(2);
      const caller = appRouter.createCaller(makeCtx(cashier));

      await expect(
        caller.sales.verifyManager({
          approval: {
            method: "BARCODE",
            barcode: "MGR-3-112233", // مدير فرع 1
          },
          branchId: 2, // فرع 2
        }),
      ).rejects.toThrow(/المعتمد ليس مدير هذا الفرع/);
    });

    it("يسمح لمدير فرع 2 باعتماد عملية فرع 2", async () => {
      const cashier = await userById(2);
      const caller = appRouter.createCaller(makeCtx(cashier));

      const res = await caller.sales.verifyManager({
        approval: {
          method: "BARCODE",
          barcode: "MGR-4-445566", // مدير فرع 2
        },
        branchId: 2, // فرع 2
      });

      expect(res.success).toBe(true);
      expect(res.managerId).toBe(4);
    });

    it("يسمح للأدمن العام باعتماد عمليات عبر الفروع مع تسجيل تدقيق عابر للفروع", async () => {
      const cashier = await userById(2);
      const caller = appRouter.createCaller(makeCtx(cashier));

      const res = await caller.sales.verifyManager({
        approval: {
          method: "PASSWORD",
          email: "admin@test.local",
          password: "ManagerPass123!",
        },
        branchId: 2, // الأدمن فرعه 1 أو عام ويعتمد لفرع 2
      });

      expect(res.success).toBe(true);
      expect(res.managerId).toBe(1);

      // التحقق من تسجيل أثر التدقيق العابر
      const crossLogs = await db()
        .select()
        .from(s.auditLogs)
        .where(eq(s.auditLogs.action, "sale.creditOverride.adminCrossBranch"));
      expect(crossLogs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("6. إدارة الـ PIN والشارة عبر مسارات المستخدمين (User Service & Router)", () => {
    it("يسمح للأدمن بتعيين وتعديل وإلغاء رمز PIN للمدير", async () => {
      const admin = await userById(1);
      const caller = appRouter.createCaller(makeCtx(admin));

      // تعيين PIN جديد
      const setRes = await caller.users.setPin({
        userId: 7,
        pin: "5566",
      });
      expect(setRes.success).toBe(true);

      const uAfterSet = await userById(7);
      expect(uAfterSet?.pinHash).toBeTruthy();

      // المدير رقم 7 يستطيع الآن الاعتماد بالـ PIN الجديد
      const cashier = await userById(2);
      const cashierCaller = appRouter.createCaller(makeCtx(cashier));
      const verifyRes = await cashierCaller.sales.verifyManager({
        approval: {
          method: "PIN",
          identifier: "nopin_mgr",
          pin: "5566",
        },
        branchId: 1,
      });
      expect(verifyRes.success).toBe(true);
      expect(verifyRes.managerId).toBe(7);

      // إلغاء الـ PIN
      const clearRes = await caller.users.clearPin({ userId: 7 });
      expect(clearRes.success).toBe(true);

      const uAfterClear = await userById(7);
      expect(uAfterClear?.pinHash).toBeNull();
    });

    it("يسمح للأدمن بتوليد وتجديد وإلغاء شارة باركود للمدير مع إبطال الباركود القديم فور التجديد", async () => {
      const admin = await userById(1);
      const cashier = await userById(2);
      const adminCaller = appRouter.createCaller(makeCtx(admin));
      const cashierCaller = appRouter.createCaller(makeCtx(cashier));

      const oldBarcode = "MGR-3-112233";

      // التأكد أن الباركود القديم صالح حالياً
      const initialVerify = await cashierCaller.sales.verifyManager({
        approval: { method: "BARCODE", barcode: oldBarcode },
        branchId: 1,
      });
      expect(initialVerify.success).toBe(true);

      // تجديد الشارة
      const genRes = await adminCaller.users.generateBadgeBarcode({ userId: 3 });
      expect(genRes.barcode).toMatch(/^MGR-3-\d+$/);
      expect(genRes.barcode).not.toBe(oldBarcode);

      const uAfterGen = await userById(3);
      expect(uAfterGen?.badgeBarcode).toBe(genRes.barcode);

      // الباركود القديم صار باطلاً ومرفوضاً الآن
      await expect(
        cashierCaller.sales.verifyManager({
          approval: { method: "BARCODE", barcode: oldBarcode },
          branchId: 1,
        }),
      ).rejects.toThrow(/غير صالح/);

      // الباركود الجديد صالح ويعتمد العملية
      const newVerify = await cashierCaller.sales.verifyManager({
        approval: { method: "BARCODE", barcode: genRes.barcode },
        branchId: 1,
      });
      expect(newVerify.success).toBe(true);

      // إلغاء الشارة
      const clearRes = await adminCaller.users.clearBadgeBarcode({ userId: 3 });
      expect(clearRes.success).toBe(true);

      const uAfterClear = await userById(3);
      expect(uAfterClear?.badgeBarcode).toBeNull();
    });

    it("تجريد وإلغاء شارة الباركود ورمز PIN فوراً عند تخفيض دور المدير إلى كاشير", async () => {
      const admin = await userById(1);
      const cashier = await userById(2);
      const adminCaller = appRouter.createCaller(makeCtx(admin));
      const cashierCaller = appRouter.createCaller(makeCtx(cashier));

      // المدير 3 لديه شارة باركود ورمز PIN
      const beforeUser = await userById(3);
      expect(beforeUser?.badgeBarcode).toBe("MGR-3-112233");
      expect(beforeUser?.pinHash).toBeTruthy();

      // الأدمن يخفّض دور المدير 3 إلى كاشير
      await adminCaller.users.update({
        userId: 3,
        role: "cashier",
      });

      const afterUser = await userById(3);
      expect(afterUser?.role).toBe("cashier");
      expect(afterUser?.badgeBarcode).toBeNull();
      expect(afterUser?.pinHash).toBeNull();

      // محاولة الاعتماد بالباركود القديم بعد التخفيض تُرفض
      await expect(
        cashierCaller.sales.verifyManager({
          approval: { method: "BARCODE", barcode: "MGR-3-112233" },
          branchId: 1,
        }),
      ).rejects.toThrow(/غير صالح/);

      // محاولة الاعتماد بالـ PIN القديم بعد التخفيض تُرفض
      await expect(
        cashierCaller.sales.verifyManager({
          approval: { method: "PIN", identifier: "mgr1", pin: "1234" },
          branchId: 1,
        }),
      ).rejects.toThrow(/غير مقبول/);
    });

    it("يمنع إصدار شارة باركود لمستخدم عادي لا يملك دور مدير أو أدمن", async () => {
      const admin = await userById(1);
      const caller = appRouter.createCaller(makeCtx(admin));

      // محاولة إصدار شارة للكاشير
      await expect(
        caller.users.generateBadgeBarcode({ userId: 2 }),
      ).rejects.toThrow(/شارة الاعتماد مخصصة للمديرين/);
    });

    it("الخدمة الذاتية: يسمح للمدير بتغيير رمز PIN الخاص به وإدارة شارته", async () => {
      const mgr1 = await userById(3);
      const caller = appRouter.createCaller(makeCtx(mgr1));

      // تغيير PIN الذاتي
      const changeRes = await caller.users.changeMyPin({
        pin: "7890",
      });
      expect(changeRes.success).toBe(true);

      // توليد شارة ذاتياً
      const genRes = await caller.users.generateMyBadgeBarcode();
      expect(genRes.barcode).toMatch(/^MGR-3-\d+$/);

      // إلغاء الشارة ذاتياً
      const clearRes = await caller.users.clearMyBadgeBarcode();
      expect(clearRes.success).toBe(true);
    });
  });

  describe("7. حماية حد المعدل (Rate Limiting) وتصفير المحاولات عند النجاح", () => {
    it("ينجح المدير في اعتماد 6 عمليات متتالية ناجحة دون أن يُحظر بسبب حد المعدل", async () => {
      const cashier = await userById(2);
      const caller = appRouter.createCaller(makeCtx(cashier));

      for (let i = 0; i < 6; i++) {
        const res = await caller.sales.verifyManager({
          approval: {
            method: "BARCODE",
            barcode: "MGR-3-112233",
          },
          branchId: 1,
        });
        expect(res.success).toBe(true);
        expect(res.managerId).toBe(3);
      }
    });

    it("يتم حظر الاعتماد بـ TOO_MANY_REQUESTS عند تجاوز 5 محاولات فاشلة متتالية خلال دقيقة", async () => {
      const cashier = await userById(2);
      const caller = appRouter.createCaller(makeCtx(cashier));

      // 5 محاولات فاشلة
      for (let i = 0; i < 5; i++) {
        await expect(
          caller.sales.verifyManager({
            approval: {
              method: "PIN",
              identifier: "mgr1",
              pin: `999${i}`, // خاطئ
            },
            branchId: 1,
          }),
        ).rejects.toThrow(/غير صحيح/);
      }

      // المحاولة السادسة تُحظر بـ TOO_MANY_REQUESTS
      await expect(
        caller.sales.verifyManager({
          approval: {
            method: "PIN",
            identifier: "mgr1",
            pin: "1234", // حتى لو كتب الرمز الصحيح الآن
          },
          branchId: 1,
        }),
      ).rejects.toThrow(/محاولات كثيرة جداً/);

      // التحقق من تسجيل الأثر في سجل التدقيق
      const rateLimitLogs = await db()
        .select()
        .from(s.auditLogs)
        .where(eq(s.auditLogs.action, "sale.creditOverride.rateLimited"));
      expect(rateLimitLogs.length).toBeGreaterThanOrEqual(1);
    });

    it("يتم حظر هجمات تخمين باركود المدير (Brute Force) بباركودات مختلفة تستهدف نفس المدير أو الكاشير", async () => {
      const cashier = await userById(2);
      const caller = appRouter.createCaller(makeCtx(cashier));

      // 5 محاولات تخمين متتالية بباركودات مختلفة تستهدف مدير 3
      for (let i = 1; i <= 5; i++) {
        await expect(
          caller.sales.verifyManager({
            approval: {
              method: "BARCODE",
              barcode: `MGR-3-99900${i}`, // باركودات عشوائية غير صحيحة
            },
            branchId: 1,
          }),
        ).rejects.toThrow(/رمز باركود المدير غير صالح/);
      }

      // المحاولة السادسة يجب أن تُحظر بـ TOO_MANY_REQUESTS وليس خطأ باركود عادي
      await expect(
        caller.sales.verifyManager({
          approval: {
            method: "BARCODE",
            barcode: "MGR-3-112233", // حتى لو جلب الباركود الصحيح الآن
          },
          branchId: 1,
        }),
      ).rejects.toThrow(/محاولات كثيرة جداً/);
    });
  });

  describe("8. اختبارات المتانة ومطابقة عتاد المسح (Robustness & POS Scanners)", () => {
    it("يتعرف بنجاح على الباركود حتى مع وجود بادئات ماسحات الباركود التجارية (AIM Code ID) أو الفراغات", async () => {
      const cashier = await userById(2);
      const caller = appRouter.createCaller(makeCtx(cashier));

      // محاكاة ماسح تجاري يرسل بادئة GS1-128 ]C1 وفراغات طرفية
      const res = await caller.sales.verifyManager({
        approval: {
          method: "BARCODE",
          barcode: " ]C1MGR-3-112233 \r\n",
        },
        branchId: 1,
      });

      expect(res.success).toBe(true);
      expect(res.managerId).toBe(3);
    });

    it("يعتمد أولوية method الصريحة حتى لو كانت حقول أخرى موجودة في كائن الاعتماد", async () => {
      const cashier = await userById(2);
      const caller = appRouter.createCaller(makeCtx(cashier));

      // كائن يحتوي على method: PIN ورمز PIN صحيح مع باركود وهمي قديم
      const res = await caller.sales.verifyManager({
        approval: {
          method: "PIN",
          identifier: "mgr1",
          pin: "1234",
          barcode: "MGR-99-INVALID", // يجب ألا يُستخدم لأن الطريقة المحددة صراحة هي PIN
        },
        branchId: 1,
      });

      expect(res.success).toBe(true);
      expect(res.managerId).toBe(3);
    });
  });
});
