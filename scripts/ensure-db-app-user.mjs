#!/usr/bin/env node
// ينشئ/يدوّر مستخدم التطبيق المحصور بقاعدة واحدة. يُشغّل يدوياً أثناء النشر؛
// لا يستدعيه خادم الويب ولا يمرّر كلمة root أو كلمة التطبيق في argv.
import "dotenv/config";
import { spawn } from "node:child_process";

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const container = process.env.DB_CONTAINER ?? "erp-mysql";
const db = process.env.DB_NAME ?? "erp";
const user = process.env.DB_APP_USER ?? "erp_app";
const rootPassword = process.env.DB_ROOT_PW ?? "";
const appPassword = process.env.DB_APP_PW ?? "";
const controlUrl = process.env.CONTROL_DATABASE_URL?.trim() ?? "";
const controlDb = process.env.DB_CONTROL_NAME?.trim() ?? "";
const controlUser = process.env.DB_CONTROL_USER?.trim() ?? "";
const controlPassword = process.env.DB_CONTROL_PW?.trim() ?? "";

if (!/^[A-Za-z0-9_.-]+$/.test(container)) fail("DB_CONTAINER غير صالح.");
if (!/^[A-Za-z0-9_]+$/.test(db)) fail("DB_NAME غير صالح.");
if (!/^[A-Za-z0-9_]+$/.test(user) || user === "root") fail("DB_APP_USER غير صالح.");
if (!rootPassword || rootPassword === "CHANGE_ME") fail("DB_ROOT_PW مفقودة أو افتراضية.");
if (!/^[a-f0-9]{48,128}$/i.test(appPassword)) {
  fail("DB_APP_PW يجب أن تكون 48–128 خانة hex (مثال: openssl rand -hex 24).");
}
if (appPassword === rootPassword) fail("DB_APP_PW يجب أن تختلف عن DB_ROOT_PW.");

let mainUrl;
try { mainUrl = new URL(process.env.DATABASE_URL ?? ""); }
catch { fail("DATABASE_URL غير صالح."); }
if (
  decodeURIComponent(mainUrl.username) !== user ||
  decodeURIComponent(mainUrl.password) !== appPassword ||
  mainUrl.pathname.replace(/^\//, "") !== db
) {
  fail("DATABASE_URL يجب أن يطابق DB_APP_USER/DB_APP_PW/DB_NAME، لا حساب root.");
}

const controlRequested = Boolean(controlUrl || controlDb || controlUser || controlPassword);
if (controlRequested) {
  if (!controlUrl || !controlDb || !controlUser || !controlPassword) {
    fail("تفعيل تعدد الشركات يتطلب CONTROL_DATABASE_URL وDB_CONTROL_NAME/USER/PW معاً.");
  }
  if (!/^[A-Za-z0-9_]+$/.test(controlDb)) fail("DB_CONTROL_NAME غير صالح.");
  if (!/^[A-Za-z0-9_]+$/.test(controlUser) || controlUser === "root") fail("DB_CONTROL_USER غير صالح.");
  if (!/^[a-f0-9]{48,128}$/i.test(controlPassword)) fail("DB_CONTROL_PW يجب أن تكون 48–128 خانة hex.");
  if (controlPassword === rootPassword || controlPassword === appPassword) {
    fail("DB_CONTROL_PW يجب أن تختلف عن كلمتي root والتطبيق.");
  }
  let parsedControl;
  try { parsedControl = new URL(controlUrl); }
  catch { fail("CONTROL_DATABASE_URL غير صالح."); }
  if (
    decodeURIComponent(parsedControl.username) !== controlUser ||
    decodeURIComponent(parsedControl.password) !== controlPassword ||
    parsedControl.pathname.replace(/^\//, "") !== controlDb
  ) {
    fail("CONTROL_DATABASE_URL يجب أن يطابق DB_CONTROL_USER/PW/NAME، لا حساب root.");
  }
}

const statements = [
  `CREATE USER IF NOT EXISTS '${user}'@'%' IDENTIFIED BY '${appPassword}';`,
  `ALTER USER '${user}'@'%' IDENTIFIED BY '${appPassword}';`,
  `GRANT ALL PRIVILEGES ON \`${db}\`.* TO '${user}'@'%';`,
];
if (controlRequested) {
  statements.push(
    `CREATE DATABASE IF NOT EXISTS \`${controlDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    `CREATE USER IF NOT EXISTS '${controlUser}'@'%' IDENTIFIED BY '${controlPassword}';`,
    `ALTER USER '${controlUser}'@'%' IDENTIFIED BY '${controlPassword}';`,
    `GRANT ALL PRIVILEGES ON \`${controlDb}\`.* TO '${controlUser}'@'%';`,
  );
}
statements.push("FLUSH PRIVILEGES;");
const sql = statements.join("\n");

const child = spawn(
  "docker",
  ["exec", "-i", "-e", "MYSQL_PWD", container, "mysql", "-uroot", "--binary-mode=1"],
  { stdio: ["pipe", "inherit", "inherit"], env: { ...process.env, MYSQL_PWD: rootPassword } },
);

child.on("error", (error) => fail(`تعذّر تشغيل docker: ${error.message}`));
child.stdin.end(sql);
child.on("exit", (code) => {
  if (code !== 0) fail(`فشل إنشاء مستخدم التطبيق (رمز ${code ?? "unknown"}).`);
  console.log(`✓ المستخدم ${user} محصور بقاعدة ${db} وجاهز لـDATABASE_URL.`);
  if (controlRequested) console.log(`✓ المستخدم ${controlUser} محصور بقاعدة ${controlDb} وجاهز لـCONTROL_DATABASE_URL.`);
});
