// راوتر النظام: فحص صحّة عام + إدارة النسخ الاحتياطي داخل النظام (للمدير فقط).
// backupNow يشغّل scripts/backup.mjs (mysqldump ذرّي) على الخادم ويعيد الملف المُنشأ.
// الاستعادة تبقى عبر CLI (scripts/restore.mjs) لخطورتها — لا تُعرَّض في الواجهة.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { adminProcedure, publicProcedure, router } from "../trpc";

const execFileP = promisify(execFile);

const backupDir = () => path.resolve(process.cwd(), process.env.BACKUP_DIR ?? "backups");

type BackupFile = { name: string; sizeKb: number; createdAt: string };

async function listBackupFiles(): Promise<BackupFile[]> {
  let entries: string[];
  try {
    entries = await readdir(backupDir());
  } catch {
    return []; // المجلّد غير موجود بعد ⇒ لا نسخ
  }
  const out: BackupFile[] = [];
  for (const name of entries.filter((f) => f.endsWith(".sql"))) {
    try {
      const s = await stat(path.join(backupDir(), name));
      out.push({ name, sizeKb: Math.round(s.size / 1024), createdAt: s.mtime.toISOString() });
    } catch {
      /* تجاهل ملفاً تعذّر فحصه */
    }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

export const systemRouter = router({
  health: publicProcedure.query(() => ({ ok: true, time: new Date().toISOString() })),

  /** قائمة آخر النسخ الاحتياطية المحلّية (للمدير). */
  listBackups: adminProcedure.query(async () => ({
    dir: process.env.BACKUP_DIR ?? "backups",
    backups: (await listBackupFiles()).slice(0, 30),
  })),

  /** تشغيل نسخة احتياطية الآن (للمدير) ⇒ يعيد الملف المُنشأ. */
  backupNow: adminProcedure.mutation(async () => {
    const before = new Set((await listBackupFiles()).map((b) => b.name));
    await execFileP(process.execPath, [path.resolve(process.cwd(), "scripts", "backup.mjs")], {
      // BACKUP_TARGET_URL يضمن نسخ قاعدة DATABASE_URL بالضبط على مضيفها (يطابق reset/restore).
      env: { ...process.env, BACKUP_TARGET_URL: process.env.DATABASE_URL },
      maxBuffer: 1024 * 1024 * 64,
    });
    const after = await listBackupFiles();
    const created = after.find((b) => !before.has(b.name)) ?? after[0] ?? null;
    return { ok: true as const, created };
  }),
});
