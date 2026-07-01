import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "../drizzle/schema";
import { getCurrentCompanyId, getCurrentTenantDb } from "./tenancy/context";
import { resolveCompanyById } from "./tenancy/registry";

/**
 * Build a pooled Drizzle instance. A pool (not a single connection) is required
 * so that `db.transaction(...)` works for the atomic flows.
 *
 * ضبط الـpool للاعتمادية تحت الحِمل وفي بيئة متجر قد تنقطع شبكته:
 * - enableKeepAlive: يبقي الاتصالات حيّة فلا تُغلَق بصمت ⇒ يمنع "PROTOCOL_CONNECTION_LOST".
 * - connectTimeout: يفشل بسرعة بدل التعليق عند تعذّر الوصول للقاعدة.
 * - queueLimit/connectionLimit: يحدّان الضغط على القاعدة في الذروة.
 */
function createDb(url: string) {
  const pool = mysql.createPool({
    uri: url,
    // المنطقة الزمنية صراحةً = UTC ('Z') بدل افتراض mysql2 الضمني 'local' (منطقة عملية Node).
    // يجعل تحويل JS Date ↔ سلسلة SQL حتمياً ومستقلاً عن منطقة المضيف، ويُصلح انزياح فلترة التواريخ
    // الذي كان يحدث حين تختلف منطقة Node عن جلسة القاعدة قرب حدّ اليوم (علّة inventoryMovements «(د4)»
    // المتقطّعة). يكتمل الضبط بتشغيل Node بـTZ=UTC (سكربتات dev/start/test + pm2) لتتطابق منطقة العملية
    // مع جلسة القاعدة (حاوية MySQL تعمل UTC افتراضاً: NOW()=UTC_TIMESTAMP()) ⇒ اتّساق تامّ. تجنّبنا تثبيت
    // الجلسة عبر معالِج 'connection' لأنه يتسابق مع مُلتقِط الاتصال تحت الحِمل فيُفسد بروتوكول الاتصال.
    timezone: "Z",
    connectionLimit: Number(process.env.DB_POOL_LIMIT ?? 20),
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    connectTimeout: 10_000,
    waitForConnections: true,
    queueLimit: 50,
  });
  return { pool, db: drizzle(pool, { schema, mode: "default" }) };
}

export type DB = ReturnType<typeof createDb>["db"];
/** Transaction handle as passed to `db.transaction(async (tx) => { ... })`. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

// المسار أحادي الاستئجار (سلوك المشروع قبل تعدد الشركات، وما زال المسار الافتراضي
// لكل سكربت/بذرة/اختبار ولكل نشر لا يعتمد تعدد الشركات): قاعدة واحدة من DATABASE_URL.
let _single: ReturnType<typeof createDb> | null = null;

// المسار متعدد الشركات: تجمّع اتصال مُخزَّن لكل companyId، يُنشأ مرّة واحدة لعمر العملية
// (لا يُعاد إنشاؤه لكل طلب) ثم يُقرأ منه بشكل متزامن عبر AsyncLocalStorage.
const _tenantPools = new Map<number, ReturnType<typeof createDb>>();

/**
 * يُهيّئ (أو يُرجع من الذاكرة) تجمّع اتصال شركة معيّنة. يُستدعى **قبل** دخول سياق
 * `runWithCompany` (من وسيط server/index.ts بعد فكّ الجلسة، أو من تدفّق الدخول نفسه)
 * — لذا هو async: الاستعلام عن قاعدة التحكّم (`resolveCompanyById`) يحدث فعلياً مرّة
 * واحدة فقط لكل شركة طوال عمر العملية؛ الاستدعاءات اللاحقة تُعيد من الذاكرة مباشرة.
 */
export async function ensureTenantDb(companyId: number): Promise<DB> {
  const existing = _tenantPools.get(companyId);
  if (existing) return existing.db;
  const company = await resolveCompanyById(companyId);
  if (!company) {
    throw new Error(`لا توجد شركة فعّالة بمعرّف ${companyId} في سجلّ التحكّم (erp_control.companies).`);
  }
  const created = createDb(company.connectionUrl);
  _tenantPools.set(companyId, created);
  return created.db;
}

/** إغلاق رشيق لكل التجمّعات (أحادي الاستئجار + كل تجمّعات الشركات) — يُستدعى عند SIGTERM/SIGINT. */
export async function closeDb(): Promise<void> {
  if (_single) {
    await _single.pool.end();
    _single = null;
  }
  for (const entry of Array.from(_tenantPools.values())) {
    await entry.pool.end();
  }
  _tenantPools.clear();
}

/**
 * وضع تعدّد الشركات مُفعَّل = `CONTROL_DATABASE_URL` مضبوط. في هذا الوضع، أي استدعاء
 * لـ`getDb()`/`getPool()` **بلا** سياق `runWithCompany` (طلب حقيقي هرب من سلسلة
 * الاستمرارية — مثلاً عبر setTimeout/fire-and-forget promise لا ALS يتتبّعها) يجب أن
 * **يفشل بصوت عالٍ**، لا أن يسقط صامتاً على `DATABASE_URL` (قد يكون قيمة متبقّية من
 * نشر أحادي الشركة قديم فيُنتج كتابة/قراءة صامتة على قاعدة شركة خاطئة تماماً — أخطر
 * صنف أخطاء ممكن في نظام متعدّد المستأجرين). مراجعة عدائية (Phase 1) حسمت هذا الفرق.
 */
export function isMultiTenantModeActive(): boolean {
  return !!process.env.CONTROL_DATABASE_URL;
}

/**
 * Lazily create/return the DB.
 *
 * **تعدّد الشركات:** إن كان الاستدعاء يجري داخل سياق `runWithCompany` (طلب HTTP مُغلَّف
 * في server/index.ts بعد تحديد الشركة من الجلسة)، يُعاد اتصال تلك الشركة تحديداً —
 * مُحضَّر سلفاً عبر `ensureTenantDb` فلا حاجة لأي await هنا (يبقى `getDb()` متزامناً
 * تماماً كسابقه، بلا تغيير توقيعه في أي من ١٨٦ موضع استدعاء عبر الخدمات/الراوترات).
 *
 * **بلا سياق، ووضع تعدّد الشركات مُفعَّل:** فشل صريح (throw) — لا سقوط صامت على
 * `DATABASE_URL` (راجع `isMultiTenantModeActive`).
 *
 * **بلا سياق، ووضع تعدّد الشركات غير مُفعَّل** (سكربتات/بذرة/اختبارات/نشر أحادي
 * الشركة): يُنشأ اتصال وحيد من `DATABASE_URL` — نفس سلوك المشروع قبل تعدد الشركات،
 * بلا أي كسر.
 */
export function getDb(): DB | null {
  const tenantDb = getCurrentTenantDb();
  if (tenantDb) return tenantDb;

  if (isMultiTenantModeActive()) {
    throw new Error(
      "getDb() استُدعيت بلا سياق شركة (runWithCompany) في وضع تعدّد الشركات — " +
        "هذا يعني تسريباً محتملاً خارج سلسلة الاستمرارية (fire-and-forget/setTimeout/queue) " +
        "قد يوجّه قراءة/كتابة لقاعدة شركة خاطئة. أصلح مصدر الاستدعاء بدل الاعتماد على " +
        "سقوط صامت على DATABASE_URL."
    );
  }

  if (!_single) {
    const url = process.env.DATABASE_URL;
    if (!url) return null;
    _single = createDb(url);
  }
  return _single.db;
}

/** Raw pool for test helpers that need a dedicated connection (e.g. TRUNCATE with FK_CHECKS).
 *  في سياق شركة: يُلزَم وجود تجمّعها في `_tenantPools` (لا سقوط صامت على `_single.pool` —
 *  ذلك كان سيُنتج تناقض getDb()/getPool() يُشير كلٌّ منهما لقاعدة شركة مختلفة). */
export function getPool(): mysql.Pool {
  const companyId = getCurrentCompanyId();
  if (companyId != null) {
    const entry = _tenantPools.get(companyId);
    if (!entry) {
      throw new Error(
        `getPool() استُدعيت داخل سياق الشركة ${companyId} لكن لا تجمّع مُحضَّر لها بعد — ` +
          "استدعِ ensureTenantDb(companyId) قبل runWithCompany، لا تعتمد على getPool() لتحضيره."
      );
    }
    return entry.pool;
  }
  if (isMultiTenantModeActive()) {
    throw new Error("getPool() استُدعيت بلا سياق شركة في وضع تعدّد الشركات — راجع getDb() لنفس السبب.");
  }
  if (!_single) throw new Error("DB pool not initialized — call getDb() first");
  return _single.pool;
}
