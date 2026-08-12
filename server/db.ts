import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "../drizzle/schema";
import { getCurrentCompanyId, getCurrentTenantDb } from "./tenancy/context";
import { resolveCompanyById } from "./tenancy/registry";
import { logger } from "./logger";

function boundedIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export interface TenantPoolPolicy {
  connectionLimit: number;
  maxPoolsPerWorker: number;
  idleMs: number;
  webWorkers: number;
  mysqlMaxConnections: number;
  connectionReserve: number;
  controlPoolPerWorker: number;
}

/**
 * A bounded, explicit connection budget. The defaults fit the bundled two-worker PM2
 * deployment under MySQL's default 151 connections while retaining a healthy reserve.
 */
export function tenantPoolPolicy(): TenantPoolPolicy {
  return {
    connectionLimit: boundedIntEnv("DB_POOL_LIMIT", 5, 1, 50),
    maxPoolsPerWorker: boundedIntEnv("DB_MAX_TENANT_POOLS_PER_WORKER", 10, 1, 100),
    idleMs: boundedIntEnv("DB_TENANT_POOL_IDLE_MS", 15 * 60_000, 60_000, 24 * 60 * 60_000),
    webWorkers: boundedIntEnv("WEB_INSTANCES", 2, 1, 32),
    mysqlMaxConnections: boundedIntEnv("MYSQL_MAX_CONNECTIONS", 151, 20, 100_000),
    connectionReserve: boundedIntEnv("DB_CONNECTION_RESERVE", 20, 5, 10_000),
    controlPoolPerWorker: process.env.CONTROL_DATABASE_URL
      ? boundedIntEnv("CONTROL_DB_POOL_LIMIT", 5, 1, 20)
      : 0,
  };
}

export function validateTenantConnectionBudget(policy = tenantPoolPolicy()): {
  projected: number;
  available: number;
} {
  const available = policy.mysqlMaxConnections - policy.connectionReserve;
  const projected =
    (policy.connectionLimit * policy.maxPoolsPerWorker + policy.controlPoolPerWorker) *
    policy.webWorkers;
  if (available < 1 || projected > available) {
    throw new Error(
      `Tenant DB connection budget exceeds MySQL capacity: ${projected} projected > ${available} available. ` +
        "Reduce DB_POOL_LIMIT, DB_MAX_TENANT_POOLS_PER_WORKER, or WEB_INSTANCES; " +
        "or set verified MYSQL_MAX_CONNECTIONS/DB_CONNECTION_RESERVE values.",
    );
  }
  return { projected, available };
}

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
  const { connectionLimit } = tenantPoolPolicy();
  const pool = mysql.createPool({
    uri: url,
    // المنطقة الزمنية صراحةً = UTC ('Z') بدل افتراض mysql2 الضمني 'local' (منطقة عملية Node).
    // يجعل تحويل JS Date ↔ سلسلة SQL حتمياً ومستقلاً عن منطقة المضيف، ويُصلح انزياح فلترة التواريخ
    // الذي كان يحدث حين تختلف منطقة Node عن جلسة القاعدة قرب حدّ اليوم (علّة inventoryMovements «(د4)»
    // المتقطّعة). يكتمل الضبط بتشغيل Node بـTZ=UTC (سكربتات dev/start/test + pm2) لتتطابق منطقة العملية
    // مع جلسة القاعدة (حاوية MySQL تعمل UTC افتراضاً: NOW()=UTC_TIMESTAMP()) ⇒ اتّساق تامّ. تجنّبنا تثبيت
    // الجلسة عبر معالِج 'connection' لأنه يتسابق مع مُلتقِط الاتصال تحت الحِمل فيُفسد بروتوكول الاتصال.
    timezone: "Z",
    connectionLimit,
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

type TenantPoolEntry = ReturnType<typeof createDb> & {
  activeLeases: number;
  lastUsedAt: number;
};

// المسار متعدد الشركات: تجمعات محدودة العدد، مع lease لكل طلب حتى لا نغلق pool قيد الاستعمال.
const _tenantPools = new Map<number, TenantPoolEntry>();
const _tenantPoolCreates = new Map<number, Promise<TenantPoolEntry>>();
let _tenantBudgetChecked = false;
let _tenantPoolGate: Promise<void> = Promise.resolve();
let _tenantIdleSweepTimer: NodeJS.Timeout | null = null;
let _dbClosing = false;
let _closeDbPromise: Promise<void> | null = null;
let _activeTenantLeases = 0;
const _tenantLeaseDrainWaiters = new Set<() => void>();

function assertTenantConnectionBudget(): void {
  if (_tenantBudgetChecked) return;
  validateTenantConnectionBudget();
  _tenantBudgetChecked = true;
}

async function withTenantPoolGate<T>(fn: () => Promise<T>): Promise<T> {
  const previous = _tenantPoolGate;
  let unlock!: () => void;
  _tenantPoolGate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    unlock();
  }
}

async function closeTenantPool(companyId: number, entry: TenantPoolEntry, reason: string): Promise<boolean> {
  if (_tenantPools.get(companyId) !== entry || entry.activeLeases !== 0) return false;
  try {
    await entry.pool.end();
    if (_tenantPools.get(companyId) === entry) _tenantPools.delete(companyId);
    logger.info({ companyId, reason }, "db.tenant_pool.closed");
    return true;
  } catch (err) {
    // Do not under-count a pool whose close failed. Keeping it in the map makes
    // capacity fail closed instead of opening a replacement above the DB budget.
    logger.warn({ err, companyId, reason }, "db.tenant_pool.close_failed");
    return false;
  }
}

function waitForTenantLeasesToDrain(): Promise<void> {
  if (_activeTenantLeases === 0) return Promise.resolve();
  return new Promise<void>((resolve) => _tenantLeaseDrainWaiters.add(resolve));
}

function notifyTenantLeaseDrain(): void {
  if (_activeTenantLeases !== 0) return;
  for (const resolve of Array.from(_tenantLeaseDrainWaiters)) resolve();
  _tenantLeaseDrainWaiters.clear();
}

async function sweepIdleTenantPools(now = Date.now()): Promise<void> {
  const policy = tenantPoolPolicy();
  for (const [companyId, entry] of Array.from(_tenantPools.entries())) {
    if (entry.activeLeases === 0 && now - entry.lastUsedAt >= policy.idleMs) {
      await closeTenantPool(companyId, entry, "idle_timeout");
    }
  }
}

function ensureTenantIdleSweep(): void {
  if (_tenantIdleSweepTimer) return;
  const policy = tenantPoolPolicy();
  const intervalMs = Math.max(60_000, Math.min(policy.idleMs, 5 * 60_000));
  _tenantIdleSweepTimer = setInterval(() => {
    if (_dbClosing) return;
    void withTenantPoolGate(() => sweepIdleTenantPools()).catch((err) =>
      logger.warn({ err }, "db.tenant_pool.idle_sweep_failed"),
    );
  }, intervalMs);
  _tenantIdleSweepTimer.unref();
}

async function makeTenantPoolRoom(now = Date.now()): Promise<void> {
  const policy = tenantPoolPolicy();
  await sweepIdleTenantPools(now);
  if (_tenantPools.size < policy.maxPoolsPerWorker) return;

  const idle = Array.from(_tenantPools.entries())
    .filter(([, entry]) => entry.activeLeases === 0)
    .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
  if (idle) await closeTenantPool(idle[0], idle[1], "lru_capacity");
  if (_tenantPools.size >= policy.maxPoolsPerWorker) {
    throw new Error(
      `Tenant DB pool capacity is busy (${policy.maxPoolsPerWorker} active pools per worker). ` +
        "Retry shortly or raise the limit only after increasing the verified MySQL connection budget.",
    );
  }
}

async function tenantPoolEntry(companyId: number): Promise<TenantPoolEntry> {
  if (_dbClosing) throw new Error("Tenant DB pools are shutting down.");
  const existing = _tenantPools.get(companyId);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing;
  }
  const pending = _tenantPoolCreates.get(companyId);
  if (pending) return pending;

  const creating = (async () => {
    assertTenantConnectionBudget();
    await makeTenantPoolRoom();
    const company = await resolveCompanyById(companyId);
    if (!company) {
      throw new Error(`لا توجد شركة فعّالة بمعرّف ${companyId} في سجلّ التحكّم (erp_control.companies).`);
    }
    // Recheck after the registry await: another company may have consumed the last slot.
    if (_dbClosing) throw new Error("Tenant DB pools are shutting down.");
    await makeTenantPoolRoom();
    const created = createDb(company.connectionUrl);
    const entry: TenantPoolEntry = { ...created, activeLeases: 0, lastUsedAt: Date.now() };
    _tenantPools.set(companyId, entry);
    ensureTenantIdleSweep();
    return entry;
  })();
  _tenantPoolCreates.set(companyId, creating);
  try {
    return await creating;
  } finally {
    _tenantPoolCreates.delete(companyId);
  }
}

/**
 * يُهيّئ (أو يُرجع من الذاكرة) تجمّع اتصال شركة معيّنة. يُستدعى **قبل** دخول سياق
 * `runWithCompany` (من وسيط server/index.ts بعد فكّ الجلسة، أو من تدفّق الدخول نفسه)
 * — لذا هو async: الاستعلام عن قاعدة التحكّم (`resolveCompanyById`) يحدث فعلياً مرّة
 * واحدة فقط لكل شركة طوال عمر العملية؛ الاستدعاءات اللاحقة تُعيد من الذاكرة مباشرة.
 */
export interface TenantDbLease {
  db: DB;
  release: () => void;
}

/** Keep a tenant pool alive for the complete HTTP request/background operation. */
export async function acquireTenantDb(companyId: number): Promise<TenantDbLease> {
  // A caller that arrived after shutdown began must not sit behind the gate and
  // silently reopen a pool once closeDb finishes.
  if (_dbClosing) throw new Error("Tenant DB pools are shutting down.");
  return withTenantPoolGate(async () => {
    const entry = await tenantPoolEntry(companyId);
    // closeDb may begin while tenantPoolEntry is awaiting registry I/O. Never
    // grant a lease after shutdown has started, even if creation just completed.
    if (_dbClosing) throw new Error("Tenant DB pools are shutting down.");
    // Creation and the first lease reservation are one serialized operation. A cold
    // pool is never visible as evictable between creation and acquisition.
    entry.activeLeases += 1;
    _activeTenantLeases += 1;
    entry.lastUsedAt = Date.now();
    let released = false;
    return {
      db: entry.db,
      release: () => {
        if (released) return;
        released = true;
        entry.activeLeases = Math.max(0, entry.activeLeases - 1);
        _activeTenantLeases = Math.max(0, _activeTenantLeases - 1);
        entry.lastUsedAt = Date.now();
        notifyTenantLeaseDrain();
      },
    };
  });
}

export async function withTenantDb<T>(companyId: number, fn: (db: DB) => Promise<T>): Promise<T> {
  const lease = await acquireTenantDb(companyId);
  try {
    return await fn(lease.db);
  } finally {
    lease.release();
  }
}

/** إغلاق رشيق لكل التجمّعات (أحادي الاستئجار + كل تجمّعات الشركات) — يُستدعى عند SIGTERM/SIGINT. */
export function closeDb(): Promise<void> {
  if (_closeDbPromise) return _closeDbPromise;
  _dbClosing = true;
  const closing = (async () => {
    try {
      await withTenantPoolGate(async () => {
        if (_tenantIdleSweepTimer) {
          clearInterval(_tenantIdleSweepTimer);
          _tenantIdleSweepTimer = null;
        }

        // server.close() drains HTTP first, but background withTenantDb callers may
        // still be finishing. Do not end their pools underneath live operations.
        await waitForTenantLeasesToDrain();

        const closures: Promise<void>[] = [];
        if (_single) {
          const single = _single;
          closures.push(
            single.pool.end().then(() => {
              if (_single === single) _single = null;
            }),
          );
        }
        for (const [companyId, entry] of Array.from(_tenantPools.entries())) {
          closures.push(
            entry.pool.end().then(() => {
              if (_tenantPools.get(companyId) === entry) _tenantPools.delete(companyId);
            }),
          );
        }

        const results = await Promise.allSettled(closures);
        _tenantPoolCreates.clear();
        const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failed) throw failed.reason;
        _tenantPools.clear();
        _tenantBudgetChecked = false;
      });
    } finally {
      _dbClosing = false;
      _closeDbPromise = null;
    }
  })();
  _closeDbPromise = closing;
  return closing;
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
 * مُحضَّر سلفاً عبر `acquireTenantDb` فلا حاجة لأي await هنا (يبقى `getDb()` متزامناً
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
          "استدعِ acquireTenantDb(companyId) قبل runWithCompany وحرّر الـlease بعد العملية؛ لا تعتمد على getPool() لتحضيره."
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
