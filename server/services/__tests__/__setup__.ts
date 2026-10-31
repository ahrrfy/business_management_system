/**
 * يُشغَّل بَعد **كل اختبار** (setupFiles في vitest.config.ts) لتفريغ كل الجداول ومنع تلوّث الحالة
 * بَين الاختبارات داخل الملف وبَين ملفات الاختبار.
 *
 * **القائمة ذاتية الصيانة:** نقرأ كل الجداول من information_schema لقاعدة الاختبار بدل قائمة ثابتة
 * (الجداول الأحدث — stocktake/production/HR/الأصول/السندات — كانت تَنقص ⇒ ٢٢ فشل عزل في CI، تدقيق
 * ١٤/٦). الاستثناء: __drizzle_migrations.
 *
 * **اتصال تنظيف خاصّ مُكرَّس لكل ملف اختبار (مُستقلّ عن تجمّع Drizzle):** بعض الاختبارات تُغلق تجمّع
 * Drizzle (closeDb عبر truncateTables) أو تُبدّل حالته؛ الاعتماد على getPool() جَعل afterEach يَفشل/
 * يُتخطّى بصمت أحياناً ⇒ branches لا تُحذَف ⇒ DUPLICATE KEY في الملف التالي (تراكم متقطّع). اتصال
 * mysql خاصّ بـ __setup__ يُعاد استعماله عبر اختبارات الملف الواحد (تلافياً لمصافحة TCP+RSA المكلفة
 * في كلّ it) ويُغلَق في afterAll أو فور أي خطأ ليضمن عزلاً تامّاً وصفر اتصالات متسرّبة.
 *
 * **DELETE لا TRUNCATE:** DML تَحترم FK_CHECKS=0 (TRUNCATE وهو DDL لا يَحترمها على الجداول الأمّ).
 * **conn.query (نصّي) لا conn.execute (مُهيَّأ):** العبارة المُهيَّأة المُخبَّأة تَبيت عبر تغيّر
 * metadata الناتج عن DELETE+FK_CHECKS=0 ⇒ ER_TABLE_DEF_CHANGED. النصّي يُعاد تحليله كلَّ مرّة.
 * **فشل صريح لا مُبتلَع:** أي إخفاق DELETE يَرمي باسم الجدول بدل الابتلاع الصامت الذي يُخفي التراكم.
 */
import mysql from "mysql2/promise";
import { afterAll, afterEach, beforeAll } from "vitest";
import { closeDb } from "../../db";

// يُشغَّل كـsetupFile قبل شيفرة كل ملف اختبار (وقبل التقاط ORIGINAL_KEY فيه): يضمن وجود مفتاح
// تشفير صالح دائماً على بيئات لا تضبطه عالمياً (CI). بلا هذا، ملفٌ يعيد المفتاح إلى undefined
// في afterAll يفسده (يصير السلسلة "undefined" — إسناد process.env.X = undefined في Node يُحوَّل
// نصّاً لا يُحذف) لكل ملف لاحق يحتاجه ولا يضبطه بنفسه (broadcastDispatch/waTemplates ⇒ فشل CI).
// `??=` يحترم قيمة CI/‎.env الصريحة إن وُجدت. قيمة اختبار حرفية منخفضة العشوائية عمداً (نمط
// BARCODE_SECRET أعلاه في vitest.config.ts) كي لا يعلّمها GitGuardian كسرٍّ حقيقيّ.
process.env.INTEGRATIONS_ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// M9 (تدقيق ٣/٨): إلزام 2FA الخادميّ للمدير/المشرف يُحجب أي إجراءٍ عبر البوّابات لدورٍ مُلزَمٍ لم
// يُفعّل 2FA. بذور الاختبار تُنشئ admin/manager بلا 2FA (والتشفير مضبوط أعلاه ⇒ isCryptoReady=true)
// فتُحجب مئات الاختبارات عبر createCaller. نُعطّل الإنفاذ افتراضياً هنا (مفتاح الإيقاف نفسه)؛
// الاختبار المخصّص twoFactorEnforcement.test.ts يُفعّله لكلّ حالةٍ للتحقّق. `??=` يحترم قيمة CI الصريحة.
process.env.TWO_FACTOR_ENFORCEMENT ??= "off";

const SKIP = new Set(["__drizzle_migrations"]);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Fail closed before the cleanup hook can open a connection. The hook deletes
 * every row from every application table, so a test-looking environment name
 * alone is not enough: the target must also be local and must not use MySQL's
 * production-default port unless the caller opted in explicitly.
 */
export function assertSafeCleanupTarget(
  rawUrl: string | undefined,
): string | undefined {
  if (!rawUrl) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      "__setup__: refusing cleanup because DATABASE_URL is not a valid URL",
    );
  }

  const host = parsed.hostname.toLowerCase();
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  const port = parsed.port ? Number(parsed.port) : 3306;

  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `__setup__: refusing cleanup on non-loopback database host ${host || "<empty>"}`,
    );
  }
  if (!databaseName || !/test/i.test(databaseName)) {
    throw new Error(
      `__setup__: refusing cleanup because database name ${databaseName || "<empty>"} does not contain "test"`,
    );
  }
  if (port === 3306 && process.env.ALLOW_TEST_DB_PORT_3306 !== "1") {
    throw new Error(
      "__setup__: refusing cleanup on MySQL port 3306; set ALLOW_TEST_DB_PORT_3306=1 only for an explicitly isolated local test database",
    );
  }

  return rawUrl;
}

// نلتقط رابط قاعدة الاختبار **مرّةً عند التحميل** قبل أيّ اختبار: بعض الاختبارات
// (maintenanceService.currentDbName) تُبدّل process.env.DATABASE_URL مؤقّتاً لفحص التحليل؛
// لو قرأ التنظيف الرابط الحيّ لاتّصل بقاعدة وهمية (Access denied/SSL). الرابط الملتقَط ثابت وصحيح.
const TEST_DB_URL = assertSafeCleanupTarget(process.env.DATABASE_URL);

let cachedTables: string[] | null = null;
let cachedDeleteTriggeredTables: Set<string> | null = null;
let cleanupConn: mysql.Connection | null = null;

function setSocketRef(conn: mysql.Connection, referenced: boolean) {
  const stream = (
    conn as unknown as {
      connection?: { stream?: { ref?: () => void; unref?: () => void } };
    }
  ).connection?.stream;
  if (referenced) stream?.ref?.();
  else stream?.unref?.();
}

export async function closeCleanupConn() {
  const conn = cleanupConn;
  cleanupConn = null;
  if (!conn) return;
  setSocketRef(conn, true);
  await conn.end().catch(() => {});
}

async function acquireCleanupConn(
  url: string,
  createConnection: typeof mysql.createConnection = mysql.createConnection,
): Promise<mysql.Connection> {
  if (cleanupConn) {
    setSocketRef(cleanupConn, true);
    return cleanupConn;
  }
  cleanupConn = await createConnection(url);
  return cleanupConn;
}

async function discoverTables(conn: mysql.Connection): Promise<string[]> {
  if (cachedTables) return cachedTables;
  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'",
  );
  const tables = rows.map((r) => r.name as string).filter((n) => !SKIP.has(n));
  // فشل-سريع: قاعدة اختبار بصفر جداول ⇒ مخطّط غير مُهيَّأ (نسي pnpm db:push) — لا نمضي صامتاً.
  if (!tables.length) {
    throw new Error(
      "__setup__: zero tables discovered — DATABASE() empty or schema not pushed; aborting to avoid silent isolation failure",
    );
  }
  cachedTables = tables;
  return tables;
}

async function discoverDeleteTriggeredTables(
  conn: mysql.Connection,
): Promise<Set<string>> {
  if (cachedDeleteTriggeredTables) return cachedDeleteTriggeredTables;
  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT DISTINCT EVENT_OBJECT_TABLE AS name FROM information_schema.TRIGGERS " +
      "WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_MANIPULATION = 'DELETE'",
  );
  cachedDeleteTriggeredTables = new Set(rows.map((row) => row.name as string));
  return cachedDeleteTriggeredTables;
}

/** Empty immutable tables need no DDL; populated ones still require the guarded TRUNCATE path. */
export async function populatedTestTables(
  conn: mysql.Connection,
  tables: string[],
) {
  if (!tables.length) return [];
  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    tables
      .map(
        (table) =>
          `SELECT ${conn.escape(table)} AS name WHERE EXISTS (SELECT 1 FROM \`${table.replace(/`/g, "``")}\` LIMIT 1)`,
      )
      .join(" UNION ALL "),
  );
  const known = new Set(tables);
  if (rows.some((row) => !known.has(row.name)))
    throw new Error("Unknown table in test cleanup snapshot");
  return rows.map((row) => row.name as string);
}

export async function clearTestTable(
  conn: mysql.Connection,
  table: string,
  deleteProtected: boolean,
  alreadyProvedPopulated = false,
) {
  if (deleteProtected) {
    if (!alreadyProvedPopulated) {
      const [existing] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT 1 FROM \`${table}\` LIMIT 1`,
      );
      if (existing.length === 0) return;
    }
    await conn.query(`TRUNCATE TABLE \`${table}\``);
  } else {
    await conn.query(`DELETE FROM \`${table}\``);
  }
}

export async function readSnapshotWithReconnect(
  url: string,
  createConnection: typeof mysql.createConnection = mysql.createConnection,
): Promise<{
  conn: mysql.Connection;
  populated: string[];
  deleteTriggeredTables: Set<string>;
}> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const hadCachedConn = cleanupConn !== null;
    const conn = await acquireCleanupConn(url, createConnection);
    try {
      const tables = await discoverTables(conn);
      const deleteTriggeredTables = await discoverDeleteTriggeredTables(conn);
      const populated = await populatedTestTables(conn, tables);
      return { conn, populated, deleteTriggeredTables };
    } catch (err) {
      await closeCleanupConn();
      if (!hadCachedConn || attempt === 1) throw err;
    }
  }
  throw new Error("__setup__: unreachable cleanup snapshot retry");
}

export class NonEmptyTestDatabaseError extends Error {
  constructor(readonly populatedTables: string[]) {
    super(
      `Refusing projection bootstrap: complete test database is not empty (${populatedTables.join(", ")})`,
    );
    this.name = "NonEmptyTestDatabaseError";
  }
}

interface LateCleanupRetryOptions {
  bootstrap: () => Promise<void>;
  drain: () => Promise<void>;
  clearLateTables: (tables: string[]) => Promise<void>;
  maxRetries?: number;
}

/**
 * A background best-effort writer may commit after the cleanup snapshot. Retry
 * only that exceptional path; the final bootstrap attempt remains the
 * independent whole-database invariant and fails closed after the cap.
 */
export async function retryLateTestCleanup({
  bootstrap,
  drain,
  clearLateTables,
  maxRetries = 3,
}: LateCleanupRetryOptions): Promise<void> {
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("__setup__: maxRetries must be a non-negative integer");
  }
  for (let retry = 0; ; retry++) {
    try {
      await bootstrap();
      return;
    } catch (error) {
      if (!(error instanceof NonEmptyTestDatabaseError) || retry >= maxRetries) {
        throw error;
      }
      await drain();
      await clearLateTables(error.populatedTables);
    }
  }
}

async function clearPopulatedSnapshot(
  conn: mysql.Connection,
  populated: string[],
  deleteTriggeredTables: Set<string>,
): Promise<void> {
  for (const table of populated) {
    // جداول الأثر غير القابل للمحو تحرس DELETE بتريغر مقصود في الإنتاج. تنظيف الاختبار وحده
    // يستعمل TRUNCATE عليها (مع تعطيل FK) كي لا نضع منفذ bypass داخل التريغر الإنتاجي.
    // بقية الجداول تبقى على DELETE للأسباب الموثقة أعلى الملف.
    try {
      await clearTestTable(
        conn,
        table,
        deleteTriggeredTables.has(table),
        true,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const operation = deleteTriggeredTables.has(table)
        ? "TRUNCATE TABLE"
        : "DELETE FROM";
      throw new Error(`__setup__ cleanup: ${operation} ${table} failed: ${message}`);
    }
  }
}

/** Only complete harness cleanup may call this; it verifies every application table is empty. */
export async function bootstrapEmptyInventoryProjection(
  conn: mysql.Connection,
  rawUrl: string,
): Promise<void> {
  assertSafeCleanupTarget(rawUrl);
  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'",
  );
  const tables = rows
    .map((row) => String(row.name))
    .filter((name) => !SKIP.has(name));
  if (
    !tables.includes("inventoryProjectionState") ||
    !tables.includes("productVariants")
  )
    throw new Error("Test projection schema missing");
  const populated = await populatedTestTables(conn, tables);
  if (populated.length)
    throw new NonEmptyTestDatabaseError(populated);
  await conn.query(
    "INSERT INTO inventoryProjectionState (id, readyVersion) VALUES (1, 1)",
  );
}

export async function cleanCompleteTestDatabase() {
  if (!TEST_DB_URL) return;
  // Drain the application pool before taking the point-in-time snapshot. Best-effort
  // notifications are intentionally detached from request completion and otherwise
  // can commit a row while the dedicated cleanup connection is deleting the snapshot.
  await closeDb();
  const { conn, populated, deleteTriggeredTables } =
    await readSnapshotWithReconnect(TEST_DB_URL);

  try {
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    // One exact existence snapshot avoids hundreds of empty DELETE round trips per pure unit test.
    await clearPopulatedSnapshot(conn, populated, deleteTriggeredTables);
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
    await retryLateTestCleanup({
      bootstrap: () => bootstrapEmptyInventoryProjection(conn, TEST_DB_URL),
      drain: closeDb,
      clearLateTables: async (lateTables) => {
        await conn.query("SET FOREIGN_KEY_CHECKS = 0");
        await clearPopulatedSnapshot(conn, lateTables, deleteTriggeredTables);
        await conn.query("SET FOREIGN_KEY_CHECKS = 1");
      },
    });
    setSocketRef(conn, false);
  } catch (err) {
    await closeCleanupConn();
    await closeDb();
    throw err;
  }
  // أعد ضبط تجمّع Drizzle: الحذف مع FK_CHECKS=0 يَزيد نسخة metadata للجداول ⇒ العبارات المُهيَّأة
  // المُخبَّأة على اتصالات التجمّع تَبيت ⇒ ER_TABLE_DEF_CHANGED متقطّع في reset/seed الملف التالي.
  // الإغلاق يُجبر getDb() التالي على تجمّع جديد بعبارات نظيفة (نفس نمط truncateTables) ⇒ عزل موثوق.
  await closeDb();
}

if (process.env.VITEST_UNIT_SUITE !== "1") {
  beforeAll(cleanCompleteTestDatabase);
  afterEach(cleanCompleteTestDatabase);
  afterAll(async () => {
    await closeCleanupConn();
    if (TEST_DB_URL) {
      await closeDb();
    }
  });
}
