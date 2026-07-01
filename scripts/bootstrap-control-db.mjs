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
} finally {
  await conn.end();
}
