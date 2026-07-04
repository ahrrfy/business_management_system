// توفير شركة جديدة (schema منفصل على نفس خادم MySQL) — CLI مباشر لعامل بشري يملأ كل
// الوسائط يدوياً. المنطق الفعلي في scripts/lib/provisionCompany.mjs (مُشترَك مع
// scripts/company-provision-worker.mjs — مصدر حقيقة واحد، راجع تعليق تلك الوحدة).
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
import { existsSync, readFileSync } from "node:fs";
import { hostPortFromUrl, parseEnvFile, provisionCompany, CODE_RE } from "./lib/provisionCompany.mjs";

function fail(msg) { console.error("✗", msg); process.exit(1); }
function ok(msg) { console.log("✓", msg); }

const [, , code, name, ...rest] = process.argv;
const flagVal = (f) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };
const hasFlag = (f) => rest.includes(f);

if (!code || !name) {
  fail('الاستخدام: node scripts/company-new.mjs <رمز> "<اسم الشركة>" --admin-email <بريد> --admin-password <كلمة سر>');
}
if (!CODE_RE.test(code)) {
  fail("رمز الشركة بحروف صغيرة/أرقام/شُرَط فقط (kebab-case)، بين حرفين و٤٠ حرفاً — مثل alroya أو sister-co.");
}

const adminEmail = flagVal("--admin-email");
const adminPassword = flagVal("--admin-password");
if (!adminEmail || !adminPassword) fail("--admin-email و--admin-password إلزاميان.");

const root = process.cwd();
const rootEnvFile = `${root}/.env`;
const rootEnv = existsSync(rootEnvFile) ? parseEnvFile(readFileSync(rootEnvFile, "utf8")) : new Map();
const baseHostPort = hostPortFromUrl(rootEnv.get("DATABASE_URL") || "mysql://root:erp_root_pw@127.0.0.1:3306/erp");

const dbContainer = flagVal("--db-container") || process.env.DB_CONTAINER || "erp-mysql";
const rootPw = flagVal("--db-root-pw") || process.env.DB_ROOT_PW || "erp_root_pw";
const dbHost = flagVal("--db-host") || baseHostPort.host;
const dbPort = Number(flagVal("--db-port") || baseHostPort.port);
const controlUrl = flagVal("--control-url") || process.env.CONTROL_DATABASE_URL || rootEnv.get("CONTROL_DATABASE_URL");
if (!controlUrl) fail("CONTROL_DATABASE_URL غير محدّد (لا في env ولا --control-url). شغّل scripts/bootstrap-control-db.mjs أولاً.");

try {
  const { companyId, dbName, dbUser } = await provisionCompany({
    root,
    code,
    name,
    adminEmail,
    adminPassword,
    adminUsername: flagVal("--admin-username") || "admin",
    demo: hasFlag("--demo"),
    dbContainer,
    rootPw,
    dbHost,
    dbPort,
    controlUrl,
  });
  ok("القاعدة والمستخدم المخصّص جاهزان (عزل فعلي: هذا المستخدم لا يصل لأي قاعدة شركة أخرى).");
  console.log(`\n✓ شركة جاهزة بالكامل: ${name} (رمز: ${code}، معرّف: ${companyId})`);
  console.log(`  القاعدة: ${dbName} على ${dbHost}:${dbPort} (مستخدم مخصّص: ${dbUser})`);
  console.log(`  مدير الشركة: ${adminEmail}`);
  console.log(`\nيدخل المستخدم من شاشة تسجيل الدخول برمز الشركة "${code}" + بريده/كلمة مروره.`);
} catch (e) {
  fail(e?.message ?? String(e));
}
