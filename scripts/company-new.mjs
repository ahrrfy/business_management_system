// توفير شركة جديدة (schema منفصل على نفس خادم MySQL) — قاعدة فعلية + مستخدم مخصّص
// (أقل امتياز: يصل فقط لقاعدة شركته) + مخطّط + هجرات إضافية + بذرة + تسجيل في قاعدة
// التحكّم erp_control. مبني على نمط scripts/session.mjs (توفير قاعدة idempotent مشابه).
//
// الاستخدام:
//   node scripts/company-new.mjs <رمز-الشركة> "<اسم الشركة>" --admin-email <بريد> --admin-password <كلمة سر> [خيارات]
//
// خيارات:
//   --admin-username <اسم>       افتراضي "admin"
//   --demo                       بذرة عيّنة (منتجات/مورد تجريبي) بدل بذرة إنتاج نظيفة
//   --db-container <حاوية>       افتراضي DB_CONTAINER أو "erp-mysql"
//   --db-root-pw <كلمة سر>       افتراضي DB_ROOT_PW أو "erp_root_pw"
//   --db-host / --db-port        افتراضي مُستخرَج من DATABASE_URL في .env
//   --control-url <عنوان>        افتراضي CONTROL_DATABASE_URL من env
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function fail(msg) { console.error("✗", msg); process.exit(1); }
function ok(msg) { console.log("✓", msg); }

const [, , code, name, ...rest] = process.argv;
const flagVal = (f) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };
const hasFlag = (f) => rest.includes(f);

if (!code || !name) {
  fail('الاستخدام: node scripts/company-new.mjs <رمز> "<اسم الشركة>" --admin-email <بريد> --admin-password <كلمة سر>');
}
if (!/^[a-z0-9][a-z0-9-]{1,38}$/.test(code)) {
  fail("رمز الشركة بحروف صغيرة/أرقام/شُرَط فقط (kebab-case)، بين حرفين و٤٠ حرفاً — مثل alroya أو sister-co.");
}

const adminEmail = flagVal("--admin-email");
const adminPassword = flagVal("--admin-password");
if (!adminEmail || !adminPassword) fail("--admin-email و--admin-password إلزاميان.");

const root = process.cwd();

function parseEnv(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}
const rootEnvFile = path.join(root, ".env");
const rootEnv = existsSync(rootEnvFile) ? parseEnv(readFileSync(rootEnvFile, "utf8")) : new Map();

function hostPortFromUrl(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: Number(u.port) || 3306 };
  } catch {
    return { host: "127.0.0.1", port: 3306 };
  }
}
const baseHostPort = hostPortFromUrl(rootEnv.get("DATABASE_URL") || "mysql://root:erp_root_pw@127.0.0.1:3306/erp");

const dbContainer = flagVal("--db-container") || process.env.DB_CONTAINER || "erp-mysql";
const rootPw = flagVal("--db-root-pw") || process.env.DB_ROOT_PW || "erp_root_pw";
const dbHost = flagVal("--db-host") || baseHostPort.host;
const dbPort = Number(flagVal("--db-port") || baseHostPort.port);
const controlUrl = flagVal("--control-url") || process.env.CONTROL_DATABASE_URL || rootEnv.get("CONTROL_DATABASE_URL");
if (!controlUrl) fail("CONTROL_DATABASE_URL غير محدّد (لا في env ولا --control-url). شغّل scripts/bootstrap-control-db.mjs أولاً.");

const dbName = `erp_co_${code.replace(/-/g, "_")}`;
const dbUser = `u_${code.replace(/-/g, "_")}`.slice(0, 32);
const dbPassword = randomBytes(24).toString("base64url");

function runRootMysql(sql) {
  execFileSync("docker", ["exec", dbContainer, "mysql", "-uroot", `-p${rootPw}`, "-e", sql], { stdio: ["ignore", "ignore", "pipe"] });
}

console.log(`• توفير قاعدة "${dbName}" + مستخدم مخصّص "${dbUser}" (أقل امتياز: هذه القاعدة فقط)…`);
try {
  runRootMysql(
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;` +
    `CREATE USER IF NOT EXISTS '${dbUser}'@'%' IDENTIFIED BY '${dbPassword}';` +
    `ALTER USER '${dbUser}'@'%' IDENTIFIED BY '${dbPassword}';` +
    `GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbUser}'@'%';` +
    `FLUSH PRIVILEGES;`
  );
} catch (e) {
  fail(`فشل إنشاء القاعدة/المستخدم عبر docker exec (${dbContainer}):\n${e?.message ?? e}`);
}
ok("القاعدة والمستخدم المخصّص جاهزان (عزل فعلي: هذا المستخدم لا يصل لأي قاعدة شركة أخرى).");

const dbUrl = `mysql://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPassword)}@${dbHost}:${dbPort}/${dbName}`;

function runWithEnv(cmd, args, extraEnv) {
  execFileSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...extraEnv },
  });
}

console.log("• تطبيق المخطّط (db:push على قاعدة فارغة)…");
runWithEnv("pnpm", ["db:push"], { DATABASE_URL: dbUrl, ALLOW_BARE_PUSH: "1", NODE_ENV: "production" });

console.log("• تطبيق الهجرات الإضافية (GENERATED columns وما شابه لا يفهمها db:push)…");
runWithEnv("pnpm", ["db:migrate:extra"], { DATABASE_URL: dbUrl });

// تأسيس journal الهجرات (baseline): بلا هذا، أوّل db:migrate:safe/all-companies لاحق
// على هذه الشركة يظنّها فارغة تماماً ويحاول تنفيذ كل هجرة من 0000 فيفشل بـ"الجدول
// موجود سلفاً" (db:push لا يسجّل في __drizzle_migrations — تأكَّد فعلياً أثناء البناء).
console.log("• تأسيس journal الهجرات (كي تعمل بوّابة db:migrate:safe لاحقاً على هذه الشركة)…");
runWithEnv("node", ["scripts/baseline-migrations.mjs"], { DATABASE_URL: dbUrl });

console.log(`• بذرة ${hasFlag("--demo") ? "عيّنة (تجريبية)" : "إنتاج نظيفة"}…`);
runWithEnv("pnpm", ["seed"], {
  DATABASE_URL: dbUrl,
  SEED_MODE: hasFlag("--demo") ? "" : "prod",
  ADMIN_EMAIL: adminEmail,
  ADMIN_PASSWORD: adminPassword,
  ADMIN_USERNAME: flagVal("--admin-username") || "admin",
});

console.log("• تسجيل الشركة في قاعدة التحكّم…");
// عبر ملف مؤقّت لا وسيط CLI خام — تمرير JSON (مسافات/عربي) كوسيط عبر execFileSync
// بـshell:true على ويندوز يُفسِد الاقتباس فينتج JSON.parse تالفاً.
const payloadFile = path.join(os.tmpdir(), `erp-company-new-${randomBytes(6).toString("hex")}.json`);
writeFileSync(payloadFile, JSON.stringify({ code, name, dbHost, dbPort, dbName, dbUser, dbPassword }));
let companyId;
try {
  const out = execFileSync(
    "pnpm",
    ["exec", "tsx", "server/tenancy/cli/registerCompany.ts", payloadFile],
    { cwd: root, encoding: "utf8", shell: process.platform === "win32", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl } }
  );
  const lastLine = out.trim().split("\n").filter(Boolean).pop();
  companyId = JSON.parse(lastLine).id;
} catch (e) {
  fail(`فشل التسجيل في قاعدة التحكّم:\n${e?.message ?? e}`);
} finally {
  try { unlinkSync(payloadFile); } catch { /* تجاهل */ }
}

console.log(`\n✓ شركة جاهزة بالكامل: ${name} (رمز: ${code}، معرّف: ${companyId})`);
console.log(`  القاعدة: ${dbName} على ${dbHost}:${dbPort} (مستخدم مخصّص: ${dbUser})`);
console.log(`  مدير الشركة: ${adminEmail}`);
console.log(`\nيدخل المستخدم من شاشة تسجيل الدخول برمز الشركة "${code}" + بريده/كلمة مروره.`);
