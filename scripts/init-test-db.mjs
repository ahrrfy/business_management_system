// init-test-db.mjs — تهيئة قاعدة اختبار محلّية **طازجة** من الصفر (تطابق مسار CI بالضبط).
//
// المشكلة التي يحلّها: `pnpm test` الكاملة و‎.husky/pre-commit (`pnpm check && pnpm test`)
// يفترضان أنّ قاعدة الاختبار المحلّية مُهيَّأة بالمخطّط الحاليّ. لكن `pnpm db:push` **التزايديّ**
// على قاعدة قديمة منجرفة يفشل على MySQL 8.4 (ER_DROP_INDEX_FK عند مصالحة الانجراف)، فتبقى القاعدة
// متجمّدة أشهراً خلف `main` وتسقط الاختبارات بـ«Unknown column» لا علاقة لها بالكود المُختبَر.
//
// الحلّ الموثوق (نفس ما يفعله CI على قاعدة mysql:8 طازجة): **أسقط القاعدة وأعِد إنشاءها فارغةً**
// ثم `db:push` (على فارغٍ لا انجراف ⇒ لا مصالحة ⇒ لا فشل) ثم هجرات CI الإضافية. لا push تزايديّ أبداً.
//
// الاستعمال:
//   pnpm test:db:init                         # يعيد بناء erp_test على 3310 (الافتراضي، نفس vitest.config.ts)
//   TEST_DATABASE_URL=mysql://root:pw@127.0.0.1:3310/erp_myslice_test pnpm test:db:init
//
// حرّاس السلامة (خطّ CLAUDE.md الأحمر: erp-mysql-prod@3306 مرآة الإنتاج — لا يُلمس):
//   - يرفض أيّ مضيف غير محلّي (localhost/127.0.0.1/::1) — لا يمسّ قاعدة بعيدة أبداً.
//   - يرفض المنفذ 3306 (مرآة الإنتاج المحلّية) — تجاوزٌ صريح: ALLOW_PORT_3306=1.
//   - يرفض أيّ اسم قاعدة لا يحوي «test» — كي لا يُسقِط `erp` (قاعدة الإنتاج) أو أيّ قاعدة تطوير بالخطأ.
import "dotenv/config";
import mysql from "mysql2/promise";
import { execFileSync } from "node:child_process";

// نفس اشتقاق vitest.config.ts: TEST_DATABASE_URL وإلّا الافتراضي على صندوق الاختبار 3310.
const RAW_URL = process.env.TEST_DATABASE_URL ?? "mysql://root:testpw@127.0.0.1:3310/erp_test";

let u;
try {
  u = new URL(RAW_URL);
} catch {
  console.error(`⛔ رابط قاعدة الاختبار غير صالح: ${RAW_URL}`);
  process.exit(1);
}

const host = u.hostname;
const port = u.port || "3306";
const user = decodeURIComponent(u.username);
const password = decodeURIComponent(u.password);
const dbName = u.pathname.replace(/^\//, "");

// ── حرّاس السلامة ──────────────────────────────────────────────────────────────
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
if (!LOCAL_HOSTS.has(host)) {
  console.error(`⛔ المضيف «${host}» ليس محلّياً. هذا السكريبت يُسقط ويعيد إنشاء القاعدة — يُمنع على مضيف بعيد.`);
  process.exit(1);
}
if (port === "3306" && process.env.ALLOW_PORT_3306 !== "1") {
  console.error("⛔ المنفذ 3306 = مرآة الإنتاج المحلّية (erp-mysql-prod) — خطّ أحمر (CLAUDE.md).");
  console.error("   استعمل صندوق الاختبار erp-test-db على 3310. (تجاوز واعٍ فقط: ALLOW_PORT_3306=1)");
  process.exit(1);
}
if (!/test/i.test(dbName)) {
  console.error(`⛔ اسم القاعدة «${dbName}» لا يحوي «test» — رفضٌ وقائيّ كي لا نُسقط قاعدة إنتاج/تطوير بالخطأ.`);
  console.error("   قواعد الاختبار يجب أن تحمل «test» في اسمها (erp_test، erp_<شريحة>_test…).");
  process.exit(1);
}

console.log(`→ الهدف: ${user}@${host}:${port}/${dbName}`);

// ── ① إسقاط وإعادة إنشاء القاعدة فارغةً (يمحو الانجراف نهائياً) ──────────────────
// نتّصل بلا قاعدة مُحدَّدة (خادم فقط) كي نستطيع DROP/CREATE.
let admin;
try {
  admin = await mysql.createConnection({ host, port: Number(port), user, password });
} catch (e) {
  console.error(`⛔ تعذّر الاتصال بخادم MySQL على ${host}:${port} — هل حاوية erp-test-db تعمل؟`);
  console.error(`   (docker start erp-test-db)   السبب: ${e?.code ?? e?.message ?? e}`);
  process.exit(1);
}
try {
  await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  console.log(`✓ ① أُعيد إنشاء «${dbName}» فارغةً (utf8mb4).`);
} catch (e) {
  console.error(`⛔ فشل إسقاط/إنشاء القاعدة: ${e?.sqlMessage ?? e?.message ?? e}`);
  await admin.end().catch(() => {});
  process.exit(1);
}
await admin.end().catch(() => {});

// البيئة الموروثة للخطوات الفرعية: DATABASE_URL = القاعدة الهدف، NODE_ENV غير إنتاجيّ (حارس db:push).
const childEnv = { ...process.env, DATABASE_URL: RAW_URL, NODE_ENV: "test" };
const isWin = process.platform === "win32";
function run(label, cmd, args) {
  console.log(`→ ${label}…`);
  try {
    execFileSync(cmd, args, { stdio: "inherit", env: childEnv, shell: isWin });
  } catch {
    console.error(`⛔ فشلت خطوة «${label}».`);
    process.exit(1);
  }
}

// ── ② db:push على قاعدة فارغة (لا انجراف ⇒ ينجح على MySQL 8.x بلا مصالحة) ────────
run("② db:push (بناء المخطّط من drizzle/schema.ts)", "pnpm", ["db:push"]);

// ── ③ هجرات CI الإضافية (GENERATED columns / CHECK / فهارس لا يمثّلها drizzle-kit) ─
run("③ هجرات إضافية (ci-apply-extra-migrations)", "node", ["scripts/ci-apply-extra-migrations.mjs"]);

// ── ④ (اختياريّ) قاعدة التحكّم لتعدّد الشركات — فقط إن ضُبط TEST_CONTROL_DATABASE_URL ──
if (process.env.TEST_CONTROL_DATABASE_URL) {
  console.log("→ ④ تهيئة قاعدة التحكّم (تعدّد الشركات)…");
  try {
    execFileSync("node", ["scripts/bootstrap-control-db.mjs"], {
      stdio: "inherit",
      env: { ...childEnv, CONTROL_DATABASE_URL: process.env.TEST_CONTROL_DATABASE_URL },
      shell: isWin,
    });
  } catch {
    console.error("⛔ فشلت تهيئة قاعدة التحكّم.");
    process.exit(1);
  }
} else {
  console.log("• ④ تُخطّي قاعدة التحكّم (TEST_CONTROL_DATABASE_URL غير مضبوط — غير مطلوب لأغلب الاختبارات).");
}

console.log(`\n✓ جاهزة: ${dbName} مُهيَّأة طازجةً بالمخطّط الحاليّ. شغّل الآن: pnpm test`);
