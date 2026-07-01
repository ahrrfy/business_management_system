import { describe, expect, it } from "vitest";
import { getCurrentCompanyId, getCurrentTenantDb, runWithCompany } from "../context";
import type { DB } from "../../db";

/**
 * اختبار عدائي لأخطر فرضية في تعدد الشركات: هل يتسرّب سياق شركة إلى طلب شركة أخرى
 * يعمل بالتوازي معه؟ نُثبت هذا بمحاكاة طلبات حقيقية متشابكة (تأخيرات عشوائية بين كل
 * `await` تجبر مُجدوِل Node على تبديل السياقات فعلياً وسط التنفيذ)، لا بمجرّد استدعاءات
 * متتابعة قد تنجح صدفةً بلا تشابك حقيقي.
 *
 * قِيَم `db` هنا كائنات وهمية مميَّزة (لا اتصال MySQL فعلي) — هذا اختبار **آلية**
 * AsyncLocalStorage نفسها (server/tenancy/context.ts + server/db.ts)، مستقلّ عمداً عن
 * صحّة سجلّ الشركات/صلاحيات MySQL (تلك مُتحقَّق منها حيّاً بتوفير شركتين فعليتين
 * وتأكيد رفض MySQL اتصال مستخدم إحداهما بقاعدة الأخرى — راجع docs/tenancy أو الذاكرة).
 */
describe("تعدد الشركات — عزل AsyncLocalStorage (server/tenancy/context.ts)", () => {
  it("طلبان متزامنان بتشابك فعلي: كل واحد يرى شركته وقاعدته فقط طوال تنفيذه", async () => {
    const dbA = { marker: "company-A" } as unknown as DB;
    const dbB = { marker: "company-B" } as unknown as DB;

    const observedA: Array<{ companyId: number | null; db: DB | null }> = [];
    const observedB: Array<{ companyId: number | null; db: DB | null }> = [];

    async function simulateRequest(companyId: number, db: DB, observed: Array<{ companyId: number | null; db: DB | null }>) {
      return runWithCompany(companyId, db, async () => {
        for (let i = 0; i < 8; i++) {
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          observed.push({ companyId: getCurrentCompanyId(), db: getCurrentTenantDb() });
        }
      });
    }

    await Promise.all([
      simulateRequest(101, dbA, observedA),
      simulateRequest(202, dbB, observedB),
    ]);

    expect(observedA).toHaveLength(8);
    expect(observedB).toHaveLength(8);
    expect(observedA.every((o) => o.companyId === 101 && o.db === dbA)).toBe(true);
    expect(observedB.every((o) => o.companyId === 202 && o.db === dbB)).toBe(true);

    // بعد انتهاء كل الطلبات: لا سياق مُتسرّب خارج نطاقه.
    expect(getCurrentCompanyId()).toBeNull();
    expect(getCurrentTenantDb()).toBeNull();
  });

  it("عشرات الطلبات المتزامنة لعدّة شركات — صفر تسريب عبر أي مزيج", async () => {
    const COMPANIES = 8;
    const REQUESTS_PER_COMPANY = 6;
    const dbs = Array.from({ length: COMPANIES }, (_, i) => ({ marker: `co-${i}` }) as unknown as DB);

    const tasks: Promise<void>[] = [];
    for (let c = 0; c < COMPANIES; c++) {
      for (let r = 0; r < REQUESTS_PER_COMPANY; r++) {
        tasks.push(
          runWithCompany(c, dbs[c], async () => {
            await new Promise((res) => setTimeout(res, Math.random() * 8));
            const seenId = getCurrentCompanyId();
            const seenDb = getCurrentTenantDb();
            if (seenId !== c || seenDb !== dbs[c]) {
              throw new Error(`تسريب سياق! متوقَّع شركة ${c}، رُصد ${seenId}`);
            }
            await new Promise((res) => setTimeout(res, Math.random() * 8));
            if (getCurrentCompanyId() !== c || getCurrentTenantDb() !== dbs[c]) {
              throw new Error(`تسريب سياق بعد await ثانٍ! متوقَّع شركة ${c}`);
            }
          })
        );
      }
    }

    await expect(Promise.all(tasks)).resolves.toBeDefined();
  });

  it("بلا سياق (سكربتات/بذرة/اختبارات عادية): getCurrentCompanyId/getCurrentTenantDb فارغان", () => {
    expect(getCurrentCompanyId()).toBeNull();
    expect(getCurrentTenantDb()).toBeNull();
  });

  it("سياقات متداخلة (شركة تستدعي منطقاً يفترض بيئة بلا سياق مؤقّتاً) لا تتسرّب بعد الخروج", async () => {
    const dbOuter = { marker: "outer" } as unknown as DB;
    const dbInner = { marker: "inner" } as unknown as DB;

    await runWithCompany(1, dbOuter, async () => {
      expect(getCurrentCompanyId()).toBe(1);
      await runWithCompany(2, dbInner, async () => {
        expect(getCurrentCompanyId()).toBe(2);
        expect(getCurrentTenantDb()).toBe(dbInner);
      });
      // بعد الخروج من السياق الداخلي: نعود لسياق الخارجي، لا نبقى على الداخلي ولا نفقده.
      expect(getCurrentCompanyId()).toBe(1);
      expect(getCurrentTenantDb()).toBe(dbOuter);
    });

    expect(getCurrentCompanyId()).toBeNull();
  });
});
