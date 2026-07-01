import { AsyncLocalStorage } from "node:async_hooks";
import type { DB } from "../db";

/**
 * سياق "الشركة الحالية" لكل طلب — عبر AsyncLocalStorage كي يبقى `getDb()` بلا وسائط
 * (١٨٦ موضع استدعاء عبر ١١٢+ ملف خدمة/راوتر بلا أي تعديل توقيع). كل طلب HTTP يُغلَّف
 * بـ`runWithCompany(companyId, db, next)` مبكراً (server/index.ts، قبل وسيط tRPC) بعد
 * استخراج companyId من جلسة المستخدم (JWT) وتحضير اتصال قاعدته مسبقاً عبر
 * `ensureTenantDb` (server/db.ts) — الاتصال يُحضَّر **قبل** دخول السياق كي يبقى
 * `getDb()` متزامناً (sync) تماماً كسلوكه الحالي، بلا أي await إضافي في كل استدعاء.
 *
 * غياب السياق (سكربتات/بذرة/اختبارات تعمل خارج Express) ⇒ القيم تُعيد null، و`getDb()`
 * (server/db.ts) يستمرّ بسلوكه أحادي الاستئجار الحالي (DATABASE_URL من env مباشرة) بلا
 * أي تغيير — توافق تام مع كل أداة/جلسة عمل موجودة.
 */
interface TenancyStore {
  companyId: number;
  db: DB;
}

const als = new AsyncLocalStorage<TenancyStore>();

/** يُشغّل `fn` داخل سياق شركة مُحدَّدة (اتصال `db` مُحضَّر سلفاً) — كل استدعاء `getDb()`
 *  أثناء تنفيذها (حتى عبر await متعدّدة) يُوجَّه لهذه القاعدة تحديداً. */
export function runWithCompany<T>(companyId: number, db: DB, fn: () => T): T {
  return als.run({ companyId, db }, fn);
}

/** معرّف الشركة الحالية إن وُجد سياق (طلب HTTP ضمن تعدد شركات)، وإلا null. */
export function getCurrentCompanyId(): number | null {
  return als.getStore()?.companyId ?? null;
}

/** اتصال قاعدة الشركة الحالية المُحضَّر سلفاً (sync) إن وُجد سياق، وإلا null. */
export function getCurrentTenantDb(): DB | null {
  return als.getStore()?.db ?? null;
}
