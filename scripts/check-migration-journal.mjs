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
  const mainTags = (JSON.parse(mainJournalRaw).entries ?? []).map((e) => String(e.tag));
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
} catch {
  // لا origin/main محلياً (CI بعمق ١، أو بلا ريموت) ⇒ تخطٍّ صامت.
}

// ── حجز الرقم في coord (٢٠/٨/٢٦) — تنبيهٌ لا حاجز ────────────────────────────────────────
// `check:migrations` أعلاه يقارن بـ`origin/main` فيمسك التصادم مع **المدموج** فقط، وهو أعمى
// تماماً عن فرعٍ متوازٍ لم يُدمج بعد — وهناك يقع التصادم فعلاً (أربع مرّات في ثلاثة أيام:
// 0204 لثلاثة فروع، ثمّ 0216 و0226 لفرعَين لكلٍّ). الحجز الذرّي في coord يغلق تلك الفجوة.
//
// تنبيهٌ لا حاجز عمداً: الفروع القائمة أُنشئت قبل وجود الحجز، وحاجزٌ هنا كان سيوقفها كلّها بلا
// ذنب. يُشدَّد لاحقاً حين تصير كل الفروع الحيّة محجوزة.
try {
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, ["scripts/coord.mjs", "migration", "list", "--json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  const { ceiling, reservations } = JSON.parse(out);
  if (ceiling) {
    const mine = tags.filter((t) => Number(t.slice(0, 4)) > Number(ceiling.idx));
    const reserved = new Set((reservations ?? []).map((r) => String(r.tag)));
    const unreserved = mine.filter((t) => !reserved.has(t));
    if (unreserved.length) {
      console.warn(
        `⚠  هجراتٌ فوق أرضية origin/main بلا حجزٍ في coord: ${unreserved.join(", ")}
` +
        `   الرقم مورِدٌ مشترَك بين الفروع؛ هذا الفحص لا يرى فرعاً متوازياً لم يُدمج.
` +
        `   احجزه ذرّياً: pnpm coord:migration reserve <slug>   (وحرّره بعد الدمج: --merged)`,
      );
    }
  }
} catch {
  // coord غير مُهيّأ أو غير متاح ⇒ تخطٍّ صامت (حارسٌ يفشل مفتوحاً).
}

console.log(`Migration journal check passed through ${tags.at(-1)}.`);
