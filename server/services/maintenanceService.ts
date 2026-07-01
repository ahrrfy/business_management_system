// خدمة الصيانة: نسخ/استعادة/تصفير + مسار ملفات آمن + حجر الرفع.
// كل العمليات المدمّرة (استعادة/تصفير) تأخذ نسخة أمان تلقائية أولاً (داخل السكربتات).
// الأمان: لا تركيب أوامر شِل (execFile بمصفوفات)، مسار النسخ مُقيَّد داخل مجلّد backups (لا path traversal).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, stat, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { TRPCError } from "@trpc/server";
import { getCurrentCompanyId } from "../tenancy/context";
import { resolveCompanyById } from "../tenancy/registry";

const execFileP = promisify(execFile);

const scriptsDir = () => path.resolve(process.cwd(), "scripts");
export const backupsDir = () => path.resolve(process.cwd(), process.env.BACKUP_DIR ?? "backups");

/**
 * بَيانات اتّصال الشَركة الحالية (تَعدّد الشركات) إن وُجِد سِياق `runWithCompany` — و`null`
 * في النَشر الأُحادي (لا `CONTROL_DATABASE_URL`) فَتَستمرّ كل الدَوال أَدناه بِسُلوكها القَديم
 * تَماماً (قِراءة `DATABASE_URL` مُباشَرةً). مُخزَّن مُؤقَّتاً ٣٠ث داخِل registry.ts نَفسها.
 */
async function currentCompanyInfo() {
  const companyId = getCurrentCompanyId();
  if (companyId == null) return null;
  return resolveCompanyById(companyId);
}

/** اسم القاعدة الحالية (شركة السِياق الحالي، أو DATABASE_URL في النَشر الأُحادي). */
export async function currentDbName(): Promise<string> {
  const company = await currentCompanyInfo();
  if (company) return company.dbName;
  const m = String(process.env.DATABASE_URL ?? "").match(/\/([^/?]+)(\?.*)?$/);
  return m ? decodeURIComponent(m[1]) : "";
}

/** مضيف:منفذ القاعدة الحالية (للعرض في لوحة معلومات النظام). */
export async function currentDbHost(): Promise<string> {
  const company = await currentCompanyInfo();
  if (company) return `${company.dbHost}:${company.dbPort}`;
  const m = String(process.env.DATABASE_URL ?? "").match(/@([^:/]+):(\d+)/);
  return m ? `${m[1]}:${m[2]}` : "—";
}

/** بادِئة اسم ملفّات نَسخ الشَركة الحالية (`<dbName>-...sql`) — `null` = بلا فِلترة (نَشر أُحادي). */
async function backupFilePrefix(): Promise<string | null> {
  const company = await currentCompanyInfo();
  return company ? `${company.dbName}-` : null;
}

export type BackupFile = { name: string; sizeKb: number; createdAt: string };

export async function listBackupFiles(): Promise<BackupFile[]> {
  let entries: string[];
  try {
    entries = await readdir(backupsDir());
  } catch {
    return []; // المجلّد غير موجود بعد
  }
  // تَعدّد الشركات: كل شَركة تَرى ملَفّاتها فَقط (بادِئة اسم قاعدتها — backup.mjs يُسمّي
  // الملَفّ `<dbName>-<ts>.sql`) — لا تَسريب أَسماء/أَحجام نُسَخ شَركات أُخرى عَبر هذه القائمة.
  const prefix = await backupFilePrefix();
  const out: BackupFile[] = [];
  for (const name of entries.filter((f) => f.endsWith(".sql") && (!prefix || f.startsWith(prefix)))) {
    try {
      const s = await stat(path.join(backupsDir(), name));
      out.push({ name, sizeKb: Math.round(s.size / 1024), createdAt: s.mtime.toISOString() });
    } catch {
      /* تجاهل ملفاً تعذّر فحصه */
    }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

export async function backupsStats() {
  const files = await listBackupFiles();
  return {
    count: files.length,
    totalKb: files.reduce((s, f) => s + f.sizeKb, 0),
    latest: files[0]?.createdAt ?? null,
  };
}

/**
 * يحلّ اسم نسخة إلى مسار مطلق **داخل مجلّد backups فقط**. يعيد null عند أي اسم غير صالح
 * أو غير موجود (دفاع ضد path traversal: لا فواصل، لا «..»، وامتداد .sql، والمجلّد الأب مطابق).
 */
export async function resolveBackupFile(name: string): Promise<string | null> {
  // قائمة بيضاء صارمة: أحرف/أرقام و . _ - فقط ثم .sql ⇒ ترفض صراحةً الفواصل و«..» وأحرف التحكّم والاقتباس و«:».
  if (!name || name.includes("..") || !/^[A-Za-z0-9._-]+\.sql$/.test(name)) {
    return null;
  }
  // تَعدّد الشركات: مَلَفّ لا يَحمِل بادِئة قاعدة الشَركة الحالية ⇒ كَأَنّه غَير مَوجود (لا
  // كَشف وُجود اسم مَلَفّ شَركة أُخرى، ولا حَذف/تَنزيل/استعادة عَبر تَخمين الاسم).
  const prefix = await backupFilePrefix();
  if (prefix && !name.startsWith(prefix)) return null;
  const abs = path.join(backupsDir(), path.basename(name));
  if (path.dirname(abs) !== backupsDir()) return null;
  try {
    const s = await stat(abs);
    if (!s.isFile()) return null;
  } catch {
    return null;
  }
  return abs;
}

export async function deleteBackup(name: string): Promise<boolean> {
  const abs = await resolveBackupFile(name);
  if (!abs) return false;
  await unlink(abs);
  return true;
}

/** نسخة احتياطية الآن (شركة السِياق الحالي، أو DATABASE_URL في النَشر الأُحادي). يعيد الملف المُنشأ. */
export async function runBackup(): Promise<BackupFile | null> {
  const before = new Set((await listBackupFiles()).map((b) => b.name));
  const company = await currentCompanyInfo();
  await execFileP(process.execPath, [path.join(scriptsDir(), "backup.mjs")], {
    env: { ...process.env, BACKUP_TARGET_URL: company ? company.connectionUrl : process.env.DATABASE_URL },
    maxBuffer: 1024 * 1024 * 64,
  });
  const after = await listBackupFiles();
  return after.find((b) => !before.has(b.name)) ?? after[0] ?? null;
}

/**
 * ⛔ مُعطَّلتان بِالكامِل في وَضع تَعدّد الشركات (`isMultiTenantModeActive()`) — يُتحقَّق مِن
 * هذا عِند حَدّ التَصريح (`systemRouter.ts`) قَبل الوُصول لهاتين الدالّتين أَصلاً، لا هُنا.
 *
 * السَبب: `restore.mjs`/`reset.mjs` يُنفّذان عَبر `docker exec ... mysql -uroot` (صَلاحية
 * كامِلة عَلى كُل قَواعِد الخادِم، لا مُقيَّدة بِقاعِدة الشَركة) واستِعادة `restoreUpload`
 * تَحديداً تُنفّذ SQL خام يَحمِل عِبارات `CREATE DATABASE`/`USE` **مِن داخِل الملَفّ نَفسه** لا
 * مِن رابِط الاتّصال المُتوقَّع — أَي مَلَفّ (مَرفوع أَو حَتى نُسخة شَركة أُخرى مَحفوظة سَلَفاً)
 * يُمكِن أَن يَكتُب فِعلياً في قاعِدة شَركة أُخرى عَلى نَفس خادِم MySQL المُشترَك. تَطويق هذا
 * بِفحص اسم مَلَفّ فَقط غَير كافٍ (لا يَضمَن مُحتوى المَلَفّ)، وإصلاحه الحَقيقي (تَبديل
 * المُستخدَم الجَذري بِمُستخدَم الشَركة الأَقلّ امتيازاً عَبر كامِل السِلسِلة، بِما فيها
 * إعادة البَذرة الفَرعية داخِل reset.mjs --seed) خارِج نِطاق هذه المَرحلة — قَرار مَعماري
 * واعٍ لا نَقص مُؤجَّل: عَمَليات إعادة الكِتابة الكامِلة لِقاعِدة بَيانات لا تُناسِب الخِدمة
 * الذاتية في نِظام مُتعدِّد المُستأجِرين أَصلاً؛ تَبقى مُتاحة عَبر أَدوات المُشغِّل المُباشِرة
 * (`pnpm db:backup:all-companies` + استِعادة يَدوية مَوجَّهة لِقاعِدة الشَركة تَحديداً).
 */
export async function runRestore(absFile: string): Promise<void> {
  await execFileP(process.execPath, [path.join(scriptsDir(), "restore.mjs"), absFile, "--confirm", "RESTORE"], {
    env: { ...process.env },
    maxBuffer: 1024 * 1024 * 512,
  });
}

/** تصفير «نظام فارغ» (reset.mjs يأخذ نسخة أمان أولاً). ⛔ راجع تحذير runRestore أعلاه — نفس القيد. */
export async function runReset(seed: boolean): Promise<void> {
  const args = [path.join(scriptsDir(), "reset.mjs"), "--confirm", "RESET"];
  if (seed) args.push("--seed");
  await execFileP(process.execPath, args, {
    env: { ...process.env },
    maxBuffer: 1024 * 1024 * 64,
  });
}

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // سقف أمان للملف المرفوع

/** يحفظ ملف .sql مرفوعاً (base64) في حجر مؤقّت بعد التحقّق من التوقيع والحجم؛ يعيد المسار المؤقّت. */
export async function quarantineUpload(fileB64: string): Promise<string> {
  const buf = Buffer.from(fileB64, "base64"); // فكّ base64 متساهل (لا يرمي)؛ الحُرّاس الفعليون: الحجم + التوقيع.
  if (buf.length < 512) throw new TRPCError({ code: "BAD_REQUEST", message: "الملف صغير/تالف." });
  if (buf.length > MAX_UPLOAD_BYTES) throw new TRPCError({ code: "BAD_REQUEST", message: "الملف أكبر من الحدّ المسموح." });
  const head = buf.subarray(0, 4096).toString("utf8");
  if (!/MySQL dump|CREATE TABLE|INSERT INTO|CREATE DATABASE/i.test(head)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الملف لا يبدو ناتج mysqldump صالحاً (.sql)." });
  }
  const tmp = path.join(tmpdir(), `restore-upload-${process.pid}-${Date.now()}.sql`);
  await writeFile(tmp, buf);
  return tmp;
}

export async function cleanupTmp(p: string): Promise<void> {
  await unlink(p).catch(() => { /* ليس حرجاً */ });
}
