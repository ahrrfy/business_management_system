// تهيئة قاعدة التحكّم (erp_control) لتعدّد الشركات — جدول واحد صغير (companies) لا يحتاج
// آلة هجرات كاملة. idempotent (CREATE ... IF NOT EXISTS) — آمن لإعادة التشغيل.
//
// الاستخدام:
//   CONTROL_DATABASE_URL='mysql://root:<pw>@<host>:<port>/erp_control' node scripts/bootstrap-control-db.mjs
//
// إن كانت القاعدة نفسها غير موجودة بعد، مرّر أيضاً عنوان اتصال بلا اسم قاعدة عبر
// CONTROL_ADMIN_URL (نفس الخادم بلا مسار /db) لإنشاء erp_control أولاً.
import "dotenv/config";
import { createConnection } from "mysql2/promise";

function fail(msg) {
  console.error("✗", msg);
  process.exit(1);
}

const controlUrl = process.env.CONTROL_DATABASE_URL;
if (!controlUrl) {
  fail(
    "CONTROL_DATABASE_URL غير محدّد. مثال: " +
      "mysql://root:<كلمة السر>@127.0.0.1:3307/erp_control"
  );
}

const parsed = new URL(controlUrl);
const dbName = parsed.pathname.replace(/^\//, "");
if (!dbName) fail("CONTROL_DATABASE_URL يجب أن يحدّد اسم قاعدة (المسار بعد المنفذ).");

// اتصال بلا اسم قاعدة (على نفس الخادم) لإنشاء erp_control إن لم تكن موجودة.
const adminUrl = new URL(controlUrl);
adminUrl.pathname = "/";
const admin = await createConnection({ uri: adminUrl.toString() });
try {
  await admin.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  console.log(`✓ قاعدة التحكّم جاهزة: ${dbName}`);
} finally {
  await admin.end();
}

const conn = await createConnection({ uri: controlUrl });
try {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(40) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      dbHost VARCHAR(255) NOT NULL,
      dbPort INT NOT NULL,
      dbName VARCHAR(100) NOT NULL,
      dbUser VARCHAR(100) NOT NULL,
      dbPasswordEncrypted VARCHAR(500) NOT NULL,
      isActive TINYINT(1) NOT NULL DEFAULT 1,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  console.log("✓ جدول companies جاهز.");

  await conn.query(`
    CREATE TABLE IF NOT EXISTS platformAdmins (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(320) NOT NULL UNIQUE,
      passwordHash VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      isActive TINYINT(1) NOT NULL DEFAULT 1,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  console.log("✓ جدول platformAdmins جاهز.");

  // F4 (تدقيق ٢/٧): سجلّ تدقيق مدير المنصّة (append-only). يطابق تعريف Drizzle في controlSchema.ts.
  await conn.query(`
    CREATE TABLE IF NOT EXISTS platformAuditLogs (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      platformAdminId BIGINT NULL,
      actorEmail VARCHAR(320) NULL,
      action VARCHAR(64) NOT NULL,
      success TINYINT(1) NOT NULL DEFAULT 1,
      companyId BIGINT NULL,
      details JSON NULL,
      ipAddress VARCHAR(64) NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_platform_audit_admin (platformAdminId, createdAt),
      INDEX idx_platform_audit_action (action, createdAt),
      INDEX idx_platform_audit_company (companyId, createdAt)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  console.log("✓ جدول platformAuditLogs جاهز.");

  // طلبات توفير شركة عبر الويب — طابور بين /platform-admin (بلا صلاحيات مرتفعة) وعامل
  // منفصل (company-provision-worker.mjs بصلاحيات docker+root). يطابق تعريف Drizzle في
  // controlSchema.ts (تطابق يدويّ مزدوج — راجع تعليق الملف).
  //
  // مراجعة عدائية (٣/٧): فحص تفرّد الرمز في createProvisionRequest (SELECT ثم INSERT) كان
  // عرضة لسباق TOCTOU حقيقي — طلبان متزامنان بنفس الرمز يمرّان الفحص معاً فيُنشئان صفّين
  // PENDING، فيُنفَّذ التوفير مرّتين ويُعاد تعيين كلمة مرور قاعدة الشركة الحيّة من المحاولة
  // الثانية (ALTER USER) بعد أن سُجّلت الأولى بكلمة مرور مختلفة ⇒ عطل حقيقي على تلك الشركة.
  // الإصلاح: عمود مولَّد STORED = الرمز فقط أثناء PENDING/PROCESSING (NULL غير ذلك) + فهرس
  // فريد عليه — MySQL يستثني NULL من قيود UNIQUE، فيُسمح بعدّة صفوف FAILED/DONE بنفس الرمز
  // (نمط إعادة المحاولة القائم) لكن **يستحيل** وجود أكثر من صفّ PENDING/PROCESSING واحد بنفس
  // الرمز في آن — قيد DB حقيقي لا فحص تطبيقي قابل للسباق (نفس نمط searchNorm GENERATED STORED).
  await conn.query(`
    CREATE TABLE IF NOT EXISTS companyProvisionRequests (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(40) NOT NULL,
      name VARCHAR(255) NOT NULL,
      adminEmail VARCHAR(320) NOT NULL,
      adminUsername VARCHAR(64) NOT NULL,
      demo TINYINT(1) NOT NULL DEFAULT 0,
      tempPasswordEncrypted VARCHAR(500) NULL,
      status ENUM('PENDING','PROCESSING','DONE','FAILED') NOT NULL DEFAULT 'PENDING',
      resultCompanyId BIGINT NULL,
      errorMessage TEXT NULL,
      requestedByAdminId BIGINT NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      startedAt TIMESTAMP NULL,
      completedAt TIMESTAMP NULL,
      activeCode VARCHAR(40) GENERATED ALWAYS AS (
        CASE WHEN status IN ('PENDING','PROCESSING') THEN code ELSE NULL END
      ) STORED,
      INDEX idx_provision_status (status, createdAt),
      UNIQUE KEY uq_provision_active_code (activeCode)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  console.log("✓ جدول companyProvisionRequests جاهز.");
} finally {
  await conn.end();
}
