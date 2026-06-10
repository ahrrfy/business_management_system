// خدمة الصيانة: نسخ/استعادة/تصفير + مسار ملفات آمن + حجر الرفع.
// كل العمليات المدمّرة (استعادة/تصفير) تأخذ نسخة أمان تلقائية أولاً (داخل السكربتات).
// الأمان: لا تركيب أوامر شِل (execFile بمصفوفات)، مسار النسخ مُقيَّد داخل مجلّد backups (لا path traversal).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, stat, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { TRPCError } from "@trpc/server";

const execFileP = promisify(execFile);

const scriptsDir = () => path.resolve(process.cwd(), "scripts");
export const backupsDir = () => path.resolve(process.cwd(), process.env.BACKUP_DIR ?? "backups");

/** اسم القاعدة الحالية من DATABASE_URL (للعرض ولرمز التأكيد). */
export function currentDbName(): string {
  const m = String(process.env.DATABASE_URL ?? "").match(/\/([^/?]+)(\?.*)?$/);
  return m ? decodeURIComponent(m[1]) : "";
}

export type BackupFile = { name: string; sizeKb: number; createdAt: string };

export async function listBackupFiles(): Promise<BackupFile[]> {
  let entries: string[];
  try {
    entries = await readdir(backupsDir());
  } catch {
    return []; // المجلّد غير موجود بعد
  }
  const out: BackupFile[] = [];
  for (const name of entries.filter((f) => f.endsWith(".sql"))) {
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

/** نسخة احتياطية الآن (تطابق DATABASE_URL عبر BACKUP_TARGET_URL). يعيد الملف المُنشأ. */
export async function runBackup(): Promise<BackupFile | null> {
  const before = new Set((await listBackupFiles()).map((b) => b.name));
  await execFileP(process.execPath, [path.join(scriptsDir(), "backup.mjs")], {
    env: { ...process.env, BACKUP_TARGET_URL: process.env.DATABASE_URL },
    maxBuffer: 1024 * 1024 * 64,
  });
  const after = await listBackupFiles();
  return after.find((b) => !before.has(b.name)) ?? after[0] ?? null;
}

/** استعادة من ملف مطلق (restore.mjs يأخذ نسخة أمان أولاً + يتحقّق من الملف). */
export async function runRestore(absFile: string): Promise<void> {
  await execFileP(process.execPath, [path.join(scriptsDir(), "restore.mjs"), absFile, "--confirm", "RESTORE"], {
    env: { ...process.env },
    maxBuffer: 1024 * 1024 * 512,
  });
}

/** تصفير «نظام فارغ» (reset.mjs يأخذ نسخة أمان أولاً). */
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
