import { readFileSync, readdirSync } from "node:fs";

const migrationsDir = "drizzle/migrations";
const journalPath = `${migrationsDir}/meta/_journal.json`;
const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();
const journal = JSON.parse(readFileSync(journalPath, "utf8"));
const entries = journal.entries ?? [];

function fail(message) {
  console.error(`Migration journal check failed: ${message}`);
  process.exit(1);
}

if (!entries.length) fail("the journal has no entries");

const tags = entries.map((entry) => String(entry.tag));
const indexes = entries.map((entry) => Number(entry.idx));
if (new Set(tags).size !== tags.length) fail("duplicate journal tag");
if (new Set(indexes).size !== indexes.length) fail("duplicate journal idx");

const fileTags = new Set(migrationFiles.map((name) => name.replace(/\.sql$/, "")));
// Historical migrations include a small number of deliberately retained legacy
// journal entries/files that predate this guard. Enforce complete registration
// for the latest migration number and everything added after it, which catches
// the concurrent-branch collision that previously left 0122_document_* unapplied.
const latestPrefix = Math.max(...tags.map((tag) => Number(tag.slice(0, 4))));
for (const tag of tags.filter((tag) => Number(tag.slice(0, 4)) >= latestPrefix)) {
  if (!fileTags.has(tag)) fail(`journal entry ${tag} has no SQL file`);
}
const unregisteredCurrent = migrationFiles
  .map((name) => name.replace(/\.sql$/, ""))
  .filter((tag) => Number(tag.slice(0, 4)) >= latestPrefix && !tags.includes(tag));
if (unregisteredCurrent.length) {
  fail(`SQL file is not registered in _journal.json: ${unregisteredCurrent.join(", ")}`);
}

const latestFiles = migrationFiles.filter((name) => Number(name.slice(0, 4)) === latestPrefix);
if (latestFiles.length !== 1) {
  fail(`migration number ${String(latestPrefix).padStart(4, "0")} is used by ${latestFiles.length} files`);
}

// ── تصادم ترقيم الهجرات مع origin/main (استقرار سير العمل، ٧/٨/٢٦) ────────────────────────
// العلّة المتكرّرة: فرعان متوازيان يأخذان الرقم نفسه (0152 مثلاً)، فلا يظهر التصادم إلّا **عند
// الدمج** — تعارضٌ في `_journal.json` يوقف الـPR ويستهلك جلسةً كاملة لحلّه (حدث فعلاً على هذا
// المستودع، راجع commit «حلّ تصادم ترقيم الهجرات»). الفحص المحلّي أعلاه لا يراه لأنّه لا ينظر
// خارج الفرع إطلاقاً. هنا نقارن بالجانب الآخر **قبل** الدفع فيُعاد الترقيم بثوانٍ.
//
// يتخطّى بصمتٍ حين لا يكون `origin/main` متاحاً (بيئة CI ذات fetch-depth=1، أو مستودعٌ بلا
// ريموت) — حارسٌ يفشل مفتوحاً: لا يمنع عملاً مشروعاً بسبب غياب مرجعٍ لا يملكه.
try {
  const { execFileSync } = await import("node:child_process");
  const mainJournalRaw = execFileSync(
    "git",
    ["show", "origin/main:drizzle/migrations/meta/_journal.json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const mainEntries = JSON.parse(mainJournalRaw).entries ?? [];
  const mainTags = mainEntries.map((e) => String(e.tag));
  const mainByPrefix = new Map(mainTags.map((tag) => [tag.slice(0, 4), tag]));
  const collisions = tags
    .map((tag) => ({ tag, prefix: tag.slice(0, 4), main: mainByPrefix.get(tag.slice(0, 4)) }))
    .filter((row) => row.main && row.main !== row.tag);
  if (collisions.length) {
    const lines = collisions.map((c) => `  • ${c.prefix}: فرعك «${c.tag}» ⟂ origin/main «${c.main}»`);
    fail(
      `تصادم ترقيم هجرات مع origin/main (سيتعارض عند الدمج حتماً):\n${lines.join("\n")}\n` +
      `  أعِد ترقيم هجرتك إلى رقمٍ بعد آخر رقمٍ على main، وحدّث اسم الملف ومدخل _journal.json معاً.`,
    );
  }
  // ── الطابع الزمنيّ: العطب الذي يصل الإنتاج صامتاً (٢٠/٨/٢٦) ──────────────────────────
  // تصادمُ **الرقم** أعلاه يوقف الدمج بضجيج، فيُصلَح. أمّا الطابع فيمرّ بلا صوت:
  // drizzle تطبّق الهجرة فقط إن كان `when` أكبر من أكبر `created_at` مُسجَّل
  // (mysql-core/dialect). فهجرةٌ جديدة بطابعٍ أقلّ ممّا طُبِّق سلفاً **تُتخطّى تماماً**:
  // لا خطأ، ولا نشرٌ فاشل، ولا تعارض — فقط جدولٌ/عمودٌ غائبٌ في الإنتاج بينما الشيفرة
  // التي تعتمده تُشحن. حدث ثلاث مرّات في يومٍ واحد على ثلاثة فروع متوازية.
  //
  // المرجع هنا أعلى طابعٍ على `origin/main` — حدٌّ **أشدّ** من الإنتاج (main قد تحمل
  // هجرةً مدموجةً لم تُنشَر بعد)، وهو الحدّ الصحيح لعملٍ جديد.
  const maxMainWhen = mainEntries.reduce((mx, e) => Math.max(mx, Number(e.when) || 0), 0);
  const mainTagSet = new Set(mainTags);
  const stale = entries
    .filter((e) => !mainTagSet.has(String(e.tag)) && Number(e.when) <= maxMainWhen)
    .map((e) => `  • ${e.tag}: when=${e.when} ≤ أعلى طابعٍ على main ${maxMainWhen}`);
  if (stale.length) {
    fail(
      `هجرةٌ بطابعٍ ماضٍ — ستُتخطّى صامتةً ولن تُطبَّق أبداً:
${stale.join(String.fromCharCode(10))}
` +
      `  ارفع \`when\` فوق ${maxMainWhen} (وأبقِ ترتيب الأرقام موافقاً لترتيب when).`,
    );
  }

  // وترتيب الأرقام يجب أن يوافق ترتيب الطوابع في **العمل الجديد** وحده.
  // التاريخ على main غير قابلٍ للإصلاح (مُطبَّقٌ على قواعد حيّة) وفيه مخالفاتٌ قديمة —
  // مطالبةٌ به تُنتج إنذاراً كاذباً، وحارسٌ يُنذر كاذباً يُتجاوَز فيصير مسرحياً.
  const fresh = entries.filter((e) => !mainTagSet.has(String(e.tag)));
  const freshOrdered = [...fresh].sort((x, y) => Number(x.when) - Number(y.when));
  const outOfOrder = freshOrdered.find((e, i) => i > 0 && Number(e.idx) < Number(freshOrdered[i - 1].idx));
  if (outOfOrder) {
    fail(`ترتيب الأرقام يخالف ترتيب when عند ${outOfOrder.tag} — أعِد الترقيم كي يتصاعدا معاً.`);
  }
} catch {
  // لا origin/main محلياً (CI بعمق ١، أو بلا ريموت) ⇒ تخطٍّ صامت.
  // ملاحظة: `fail()` يُنهي العملية بـprocess.exit فوراً، فلا يمرّ من هنا ولا يُبتلع.
}

console.log(`Migration journal check passed through ${tags.at(-1)}.`);
