// تدوير النسخ الاحتياطية: يُبقي سياسة احتفاظ متدرّجة ويحذف الباقي، ثم ينسخ خارجياً.
//
// السياسة (قابلة للضبط عبر .env):
//   BACKUP_KEEP_DAILY   = 7   آخر ٧ نسخ يومية
//   BACKUP_KEEP_WEEKLY  = 4   نسخة من كل أسبوع لآخر ٤ أسابيع (أحدث نسخة في الأسبوع)
//   BACKUP_KEEP_MONTHLY = 3   نسخة من كل شهر لآخر ٣ أشهر (أحدث نسخة في الشهر)
//
// النسخة تُحتفَظ إن طابقت أيّ فئة. الباقي يُحذف. ثم تُنسخ النسخ المُبقاة إلى BACKUP_OFFSITE_DIR
// (OneDrive/USB) إن ضُبط — فقد الجهاز لا يعني فقد البيانات.
import { readdirSync, statSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const backupDir = process.env.BACKUP_DIR ?? "backups";
const db = process.env.DB_NAME ?? "erp";
const keepDaily = int(process.env.BACKUP_KEEP_DAILY, 7);
const keepWeekly = int(process.env.BACKUP_KEEP_WEEKLY, 4);
const keepMonthly = int(process.env.BACKUP_KEEP_MONTHLY, 3);
const offsite = process.env.BACKUP_OFFSITE_DIR;

function int(v, d) {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

// اسم الملف: <db>-YYYY-MM-DDTHH-MM-SS.sql — نشتقّ التاريخ منه (لا من mtime الذي قد يتغيّر بالنسخ).
function parseStamp(name) {
  const m = name.match(/-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})\.sql$/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S] = m;
  return new Date(`${Y}-${Mo}-${D}T${H}:${Mi}:${S}`);
}

// مفتاح الأسبوع ISO (سنة-أسبوع) لتجميع نسخ الأسبوع الواحد.
function weekKey(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let files;
try {
  files = readdirSync(backupDir)
    .filter((f) => f.startsWith(`${db}-`) && f.endsWith(".sql"))
    .map((name) => ({ name, date: parseStamp(name) }))
    .filter((f) => f.date)
    .sort((a, b) => b.date - a.date); // الأحدث أولاً
} catch {
  console.log("لا مجلّد نسخ بعد — لا شيء للتدوير.");
  process.exit(0);
}

if (files.length === 0) {
  console.log("لا نسخ للتدوير.");
  process.exit(0);
}

const keep = new Set();

// أحدث نسخة لكل يوم/أسبوع/شهر (الملفات مرتّبة تنازلياً فأوّل ظهور = الأحدث).
const seenDay = new Map();
const seenWeek = new Map();
const seenMonth = new Map();
for (const f of files) {
  const dk = dayKey(f.date);
  if (!seenDay.has(dk)) seenDay.set(dk, f.name);
  const wk = weekKey(f.date);
  if (!seenWeek.has(wk)) seenWeek.set(wk, f.name);
  const mk = monthKey(f.date);
  if (!seenMonth.has(mk)) seenMonth.set(mk, f.name);
}

[...seenDay.values()].slice(0, keepDaily).forEach((n) => keep.add(n));
[...seenWeek.values()].slice(0, keepWeekly).forEach((n) => keep.add(n));
[...seenMonth.values()].slice(0, keepMonthly).forEach((n) => keep.add(n));

let deleted = 0;
for (const f of files) {
  if (keep.has(f.name)) continue;
  try {
    unlinkSync(join(backupDir, f.name));
    deleted++;
  } catch (e) {
    console.error(`⚠ تعذّر حذف ${f.name}: ${e?.message ?? e}`);
  }
}

console.log(`✓ تدوير: ${keep.size} نسخة محفوظة (يومية≤${keepDaily}/أسبوعية≤${keepWeekly}/شهرية≤${keepMonthly})، حُذف ${deleted}.`);

// نسخ خارجي مشفّر للنسخ المُبقاة (BC-02).
// النسخة النصّية تحوي جدول users + تجزئات scrypt لكلمات المرور + كامل بيانات العملاء/الموردين ⇒
// **ممنوع** أن تغادر الجهاز نصّاً صريحاً (OneDrive/USB ضائع = تسريب اعتمادات + PII). نُشفّر عند النسخ
// بـgpg AES256 (العبارة عبر stdin --passphrase-fd 0، لا تظهر في ps)، ونرفض النسخ الخارجي إن غابت العبارة.
if (offsite) {
  const passphrase = process.env.BACKUP_GPG_PASSPHRASE;
  if (!passphrase) {
    console.error(
      "⛔ BC-02: BACKUP_OFFSITE_DIR مضبوط لكن BACKUP_GPG_PASSPHRASE غائب ⇒ رُفِض النسخ الخارجي" +
        " (لا نُسرّب نسخاً نصّية تحوي تجزئات كلمات المرور و PII). اضبط العبارة السرّية لتفعيل نسخ خارجي مشفّر.",
    );
  } else {
    try {
      mkdirSync(offsite, { recursive: true });
      let copied = 0;
      for (const name of keep) {
        const dest = join(offsite, `${name}.gpg`);
        if (existsSync(dest)) continue; // موجود مسبقاً — تخطَّ
        const r = spawnSync(
          "gpg",
          ["--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase-fd", "0", "--symmetric", "--cipher-algo", "AES256", "-o", dest, join(backupDir, name)],
          { input: passphrase },
        );
        if (r.status === 0 && existsSync(dest)) {
          copied++;
        } else {
          const err = (r.stderr?.toString() ?? r.error?.message ?? "").split("\n").filter(Boolean).slice(-1)[0] ?? "";
          console.error(`⚠ تعذّر تشفير ${name} للنسخ الخارجي${err ? `: ${err}` : ""}.`);
        }
      }
      console.log(`✓ نسخ خارجي مشفّر (gpg AES256) إلى ${offsite}: ${copied} ملف جديد.`);
    } catch (e) {
      console.error(`⚠ تعذّر النسخ الخارجي المشفّر إلى ${offsite}: ${e?.message ?? e}`);
    }
  }
}
