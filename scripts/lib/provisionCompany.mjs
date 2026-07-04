// المنطق المشترك لتوفير شركة جديدة (قاعدة فعلية + مستخدم مخصّص + مخطّط + هجرات + بذرة
// + تسجيل في قاعدة التحكّم) — يستعمله كلاهما: scripts/company-new.mjs (CLI مباشر،
// عامل بشري يملأ كل الوسائط يدوياً) وscripts/company-provision-worker.mjs (عامل آلي
// يستهلك طلبات مُقدَّمة من شاشة /platform-admin). **مصدر حقيقة واحد** لخطوات التوفير
// الفعلية — لا تُكرَّر بين الاثنين.
//
// ⚠️ يتطلّب صلاحيات مرتفعة (docker exec + كلمة سرّ MySQL الجذر) — لا يُستدعى أبداً من
// عملية خادم الويب الحيّ (راجع تعليق companyProvisionRequests في controlSchema.ts).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const CODE_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;

export function parseEnvFile(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

export function hostPortFromUrl(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: Number(u.port) || 3306 };
  } catch {
    return { host: "127.0.0.1", port: 3306 };
  }
}

/**
 * يوفّر شركة جديدة بالكامل: قاعدة MySQL فعلية + مستخدم مخصّص أقلّ امتيازاً + مخطّط +
 * هجرات إضافية + baseline + بذرة + تسجيل في قاعدة التحكّم. يرمي عند أي فشل (لا يلتقط
 * الأخطاء — القرار متروك للمستدعي: CLI يطبع ويخرج بكود ١، العامل يسجّل errorMessage).
 *
 * @param {object} opts
 * @param {string} opts.root - جذر المشروع (process.cwd() عادة)
 * @param {string} opts.code - رمز الشركة (kebab-case، يُفترض مُتحقَّقاً مسبقاً بـCODE_RE)
 * @param {string} opts.name - اسم الشركة
 * @param {string} opts.adminEmail
 * @param {string} opts.adminPassword
 * @param {string} [opts.adminUsername] - افتراضي "admin"
 * @param {boolean} [opts.demo] - بذرة عيّنة بدل إنتاج نظيفة
 * @param {boolean} [opts.adminMustChangePassword] - يُلزم تغيير كلمة المرور عند أول دخول
 * @param {string} opts.dbContainer
 * @param {string} opts.rootPw
 * @param {string} opts.dbHost
 * @param {number} opts.dbPort
 * @param {string} opts.controlUrl
 * @param {(msg: string) => void} [opts.log] - افتراضي console.log
 * @returns {Promise<{ companyId: number, dbName: string, dbUser: string }>}
 */
export async function provisionCompany(opts) {
  const log = opts.log ?? ((msg) => console.log(msg));
  const root = opts.root;
  const code = opts.code;

  const dbName = `erp_co_${code.replace(/-/g, "_")}`;
  const dbUser = `u_${code.replace(/-/g, "_")}`.slice(0, 32);
  const dbPassword = randomBytes(24).toString("base64url");

  function runRootMysql(sql) {
    execFileSync("docker", ["exec", opts.dbContainer, "mysql", "-uroot", `-p${opts.rootPw}`, "-e", sql], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  }

  log(`• توفير قاعدة "${dbName}" + مستخدم مخصّص "${dbUser}" (أقل امتياز: هذه القاعدة فقط)…`);
  try {
    runRootMysql(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;` +
        `CREATE USER IF NOT EXISTS '${dbUser}'@'%' IDENTIFIED BY '${dbPassword}';` +
        `ALTER USER '${dbUser}'@'%' IDENTIFIED BY '${dbPassword}';` +
        `GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbUser}'@'%';` +
        `FLUSH PRIVILEGES;`
    );
  } catch (e) {
    throw new Error(`فشل إنشاء القاعدة/المستخدم عبر docker exec (${opts.dbContainer}):\n${e?.message ?? e}`);
  }
  log("✓ القاعدة والمستخدم المخصّص جاهزان.");

  const dbUrl = `mysql://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPassword)}@${opts.dbHost}:${opts.dbPort}/${dbName}`;

  // مراجعة حيّة (٤/٧): db:push/db:migrate:extra/baseline-migrations/seed يجب أن تعمل كلها في
  // وضع "شركة واحدة عادية" على قاعدة الشركة الجديدة الفارغة — لا معنى لتعدّد الشركات هنا (لا
  // سياق AsyncLocalStorage يغلّفها، هي عمليات خام مستقلّة). لكن CONTROL_DATABASE_URL غالباً
  // مضبوط في env هذه العملية نفسها (مطلوب لاستدعاء company-new.mjs/العامل ولتسجيل الشركة لاحقاً)
  // — تسرّبه بالخطأ لهذه العمليات الفرعية يجعل getDb() (server/db.ts) يظنّ تعدّد الشركات مفعّلاً
  // فيرفض العمل بلا سياق شركة (seed.ts لا يملك أي سياق) فيفشل seed دائماً.
  // ⚠️ حذف المفتاح من الكائن **لا يكفي**: server/seed.ts نفسه يستورد dotenv/config، وdotenv
  // بشكل افتراضي "يملأ الفراغ" لأي مفتاح **غائب** من process.env بقراءته مباشرةً من ملف .env
  // على القرص — فيُعاد تسريب القيمة من الملف حتى لو حُذفت من كائن env هنا. الحلّ: تعيينه
  // صراحةً لسلسلة فارغة (قيمة "موجودة" فعلاً ⇒ dotenv يتخطّاها ولا يقرأ الملف؛ وفارغة ⇒
  // isMultiTenantModeActive() تُقيِّمها false تماماً كغيابها). اكتُشفت فعلياً بتشغيل توفير حيّ.
  const cleanEnv = { ...process.env, CONTROL_DATABASE_URL: "" };

  function runWithEnv(cmd, args, extraEnv) {
    execFileSync(cmd, args, {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...cleanEnv, ...extraEnv },
    });
  }

  log("• تطبيق المخطّط (db:push على قاعدة فارغة)…");
  runWithEnv("pnpm", ["db:push"], { DATABASE_URL: dbUrl, ALLOW_BARE_PUSH: "1", NODE_ENV: "production" });

  log("• تطبيق الهجرات الإضافية (GENERATED columns وما شابه لا يفهمها db:push)…");
  runWithEnv("pnpm", ["db:migrate:extra"], { DATABASE_URL: dbUrl });

  log("• تأسيس journal الهجرات (كي تعمل بوّابة db:migrate:safe لاحقاً على هذه الشركة)…");
  runWithEnv("node", ["scripts/baseline-migrations.mjs"], { DATABASE_URL: dbUrl });

  log(`• بذرة ${opts.demo ? "عيّنة (تجريبية)" : "إنتاج نظيفة"}…`);
  runWithEnv("pnpm", ["seed"], {
    DATABASE_URL: dbUrl,
    SEED_MODE: opts.demo ? "" : "prod",
    ADMIN_EMAIL: opts.adminEmail,
    ADMIN_PASSWORD: opts.adminPassword,
    ADMIN_USERNAME: opts.adminUsername || "admin",
    ADMIN_MUST_CHANGE_PASSWORD: opts.adminMustChangePassword ? "1" : "",
  });

  log("• تسجيل الشركة في قاعدة التحكّم…");
  const payloadFile = path.join(os.tmpdir(), `erp-company-new-${randomBytes(6).toString("hex")}.json`);
  writeFileSync(payloadFile, JSON.stringify({ code, name: opts.name, dbHost: opts.dbHost, dbPort: opts.dbPort, dbName, dbUser, dbPassword }));
  let companyId;
  try {
    const out = execFileSync(
      "pnpm",
      ["exec", "tsx", "server/tenancy/cli/registerCompany.ts", payloadFile],
      { cwd: root, encoding: "utf8", shell: process.platform === "win32", env: { ...process.env, CONTROL_DATABASE_URL: opts.controlUrl } }
    );
    const lastLine = out.trim().split("\n").filter(Boolean).pop();
    companyId = JSON.parse(lastLine).id;
  } catch (e) {
    throw new Error(`فشل التسجيل في قاعدة التحكّم:\n${e?.message ?? e}`);
  } finally {
    try { unlinkSync(payloadFile); } catch { /* تجاهل */ }
  }

  return { companyId, dbName, dbUser };
}
