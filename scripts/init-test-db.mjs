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
// حرّاس السلامة (خطّ CLAUDE.md الأحمر: erp-mysql-prod@3306 مرآة الإنتاج — لا يُلمس) — تُطبَّق على
// **كلّ** رابط قاعدة يمسّه السكريبت (قاعدة الاختبار، وقاعدة التحكّم إن ضُبطت):
//   - يرفض أيّ مضيف غير محلّي (localhost/127.0.0.1/::1) — لا يمسّ قاعدة بعيدة أبداً.
//   - يرفض المنفذ 3306 (مرآة الإنتاج المحلّية) — تجاوزٌ صريح: ALLOW_PORT_3306=1.
//   - يرفض أيّ اسم قاعدة لا يحوي «test» — كي لا يُسقِط `erp` (قاعدة الإنتاج) أو أيّ قاعدة تطوير بالخطأ.
import "dotenv/config";
import mysql from "mysql2/promise";
import { spawnSync } from "node:child_process";
import { defaultTestDatabaseUrl } from "./lib/test-db-name.mjs";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// يحلّل رابط قاعدة، يفرض حرّاس السلامة، ويعيد أجزاءه — أو يوقف السكريبت برسالة مُعنوَنة.
// يُستدعى لكلّ رابطٍ سيُنشئ/يُسقط/يبذر السكريبت عليه (قاعدة الاختبار وقاعدة التحكّم) كي لا يفلت
// أيّ هدفٍ من الحرّاس (خطأ رابطٍ بعيد/‏3306/بلا «test» قد يمحو قاعدةً حيّة — راجع P1 مراجعة Codex).
function parseAndGuard(rawUrl, label) {
  let p;
  try {
    p = new URL(rawUrl);
  } catch {
    console.error(`⛔ ${label}: رابط قاعدة غير صالح: ${rawUrl}`);
    process.exit(1);
  }
  const host = p.hostname;
  const port = p.port || "3306";
  const user = decodeURIComponent(p.username);
  const password = decodeURIComponent(p.password);
  const dbName = p.pathname.replace(/^\//, "");

  if (!LOCAL_HOSTS.has(host)) {
    console.error(
      `⛔ ${label}: المضيف «${host}» ليس محلّياً. السكريبت يُسقط/يُنشئ/يبذر قواعد — يُمنع على مضيف بعيد.`,
    );
    process.exit(1);
  }
  if (port === "3306" && process.env.ALLOW_PORT_3306 !== "1") {
    console.error(
      `⛔ ${label}: المنفذ 3306 = مرآة الإنتاج المحلّية (erp-mysql-prod) — خطّ أحمر (CLAUDE.md).`,
    );
    console.error(
      "   استعمل صندوق الاختبار على 3310. أمّا قواعد اختبار جلسة (`erp_<اسم>_test`) على 3306 فتجاوزٌ واعٍ: ALLOW_PORT_3306=1",
    );
    process.exit(1);
  }
  if (!/test/i.test(dbName)) {
    console.error(
      `⛔ ${label}: اسم القاعدة «${dbName}» لا يحوي «test» — رفضٌ وقائيّ كي لا نُسقط قاعدة إنتاج/تطوير بالخطأ.`,
    );
    console.error(
      "   قواعد الاختبار يجب أن تحمل «test» في اسمها (erp_test، erp_<شريحة>_test…).",
    );
    process.exit(1);
  }
  return { host, port: Number(port), user, password, dbName };
}

// نفس اشتقاق vitest.config.ts حرفياً (مصدرٌ واحد مشترك: scripts/lib/test-db-name.mjs):
// TEST_DATABASE_URL وإلّا قاعدةٌ **خاصّة بشجرة العمل** على صندوق الاختبار 3310 — كي لا تتقاتل
// جلستان على قاعدةٍ واحدة (٧/٨/٢٦). المستودع الرئيسيّ يبقى على `erp_test` بلا تغيير.
const RAW_URL =
  process.env.TEST_DATABASE_URL ?? defaultTestDatabaseUrl(process.cwd());
const target = parseAndGuard(RAW_URL, "قاعدة الاختبار");

// إن ضُبطت قاعدة التحكّم، افحصها **الآن** (قبل أيّ فعل) بنفس الحرّاس — bootstrap ينشئ القاعدة
// وجداولها، و`pnpm test` اللاحق يفرّغها ⇒ رابطٌ غير آمن يجب أن يُرفض قبل لمسه.
const controlTarget = process.env.TEST_CONTROL_DATABASE_URL
  ? parseAndGuard(
      process.env.TEST_CONTROL_DATABASE_URL,
      "قاعدة التحكّم (TEST_CONTROL_DATABASE_URL)",
    )
  : null;

console.log(
  `→ الهدف: ${target.user}@${target.host}:${target.port}/${target.dbName}`,
);
if (controlTarget)
  console.log(
    `→ قاعدة التحكّم: ${controlTarget.user}@${controlTarget.host}:${controlTarget.port}/${controlTarget.dbName}`,
  );

// ── ① إسقاط وإعادة إنشاء القاعدة فارغةً (يمحو الانجراف نهائياً) ──────────────────
// نتّصل بلا قاعدة مُحدَّدة (خادم فقط) كي نستطيع DROP/CREATE.
let admin;
try {
  admin = await mysql.createConnection({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
  });
} catch (e) {
  console.error(
    `⛔ تعذّر الاتصال بخادم MySQL على ${target.host}:${target.port} — هل حاوية erp-test-db تعمل؟`,
  );
  console.error(
    `   (docker start erp-test-db)   السبب: ${e?.code ?? e?.message ?? e}`,
  );
  process.exit(1);
}
try {
  await admin.query(`DROP DATABASE IF EXISTS \`${target.dbName}\``);
  await admin.query(
    `CREATE DATABASE \`${target.dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  console.log(`✓ ① أُعيد إنشاء «${target.dbName}» فارغةً (utf8mb4).`);
} catch (e) {
  console.error(
    `⛔ فشل إسقاط/إنشاء القاعدة: ${e?.sqlMessage ?? e?.message ?? e}`,
  );
  await admin.end().catch(() => {});
  process.exit(1);
}
await admin.end().catch(() => {});

// البيئة الموروثة للخطوات الفرعية: DATABASE_URL = القاعدة الهدف، NODE_ENV غير إنتاجيّ (حارس db:push).
const childEnv = { ...process.env, DATABASE_URL: RAW_URL, NODE_ENV: "test" };
const isWin = process.platform === "win32";
function run(label, cmd, args, env = childEnv, options = {}) {
  console.log(`→ ${label}…`);
  const result = spawnSync(cmd, args, {
    stdio: ["inherit", "pipe", "pipe"],
    encoding: "utf8",
    env,
    shell: isWin,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const rejectedOutput = options.rejectOutput?.find((pattern) =>
    pattern.test(combinedOutput),
  );
  if (result.error || result.status !== 0 || rejectedOutput) {
    if (rejectedOutput) {
      console.error("⛔ أبلغت الأداة عن خطأ DDL رغم إعادتها exit code صفراً.");
    }
    console.error(`⛔ فشلت خطوة «${label}».`);
    process.exit(1);
  }
}

// ── ② db:push على قاعدة فارغة (لا انجراف ⇒ ينجح على MySQL 8.x بلا مصالحة) ────────
run(
  "② db:push (بناء المخطّط من drizzle/schema.ts)",
  "pnpm",
  ["db:push"],
  childEnv,
  { rejectOutput: [/(?:^|\r?\n)Error:/m, /\bER_[A-Z0-9_]+\b/] },
);

// ── ③ هجرات CI الإضافية (GENERATED columns / CHECK / فهارس لا يمثّلها drizzle-kit) ─
run("③ هجرات إضافية (ci-apply-extra-migrations)", "node", [
  "scripts/ci-apply-extra-migrations.mjs",
]);

// drizzle-kit قد يطبع خطأ DDL ثم يرجع exit code صفراً في بعض إصدارات MySQL/Drizzle.
// لذلك نجاح db:push الشكلي ليس دليلاً على اكتمال القاعدة: افحص المخطط الفعلي قبل إعلان النجاح.
run("④ التحقق الفيزيائي من اكتمال المخطط", "node", [
  "scripts/db-verify-schema.mjs",
]);

// ── ⑤ (اختياريّ) قاعدة التحكّم لتعدّد الشركات — فقط إن ضُبط TEST_CONTROL_DATABASE_URL (وقد فُحص أعلاه) ──
if (controlTarget) {
  run(
    "⑤ تهيئة قاعدة التحكّم (تعدّد الشركات)",
    "node",
    ["scripts/bootstrap-control-db.mjs"],
    {
      ...childEnv,
      CONTROL_DATABASE_URL: process.env.TEST_CONTROL_DATABASE_URL,
    },
  );
} else {
  console.log(
    "• ⑤ تُخطّي قاعدة التحكّم (TEST_CONTROL_DATABASE_URL غير مضبوط — غير مطلوب لأغلب الاختبارات).",
  );
}

console.log(
  `\n✓ جاهزة: ${target.dbName} مُهيَّأة طازجةً بالمخطّط الحاليّ. شغّل الآن: pnpm test`,
);
