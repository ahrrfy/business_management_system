// خدمة الصيانة: نسخ/استعادة/تصفير + مسار ملفات آمن + حجر الرفع.
// كل العمليات المدمّرة (استعادة/تصفير) تأخذ نسخة أمان تلقائية أولاً (داخل السكربتات).
// الأمان: لا تركيب أوامر شِل (execFile بمصفوفات)، مسار النسخ مُقيَّد داخل مجلّد backups (لا path traversal).
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { lstat, mkdtemp, open, readFile, readdir, rm, rmdir, stat, unlink, utimes } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import { SignJWT, jwtVerify } from "jose";
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
    env: { ...process.env, MAINTENANCE_LOCK_HELD_BY_PARENT: "1" },
    maxBuffer: 1024 * 1024 * 16,
  });
}

/** تصفير «نظام فارغ» (reset.mjs يأخذ نسخة أمان أولاً). ⛔ راجع تحذير runRestore أعلاه — نفس القيد. */
export async function runReset(seed: boolean): Promise<void> {
  const args = [path.join(scriptsDir(), "reset.mjs"), "--confirm", "RESET"];
  if (seed) args.push("--seed");
  await execFileP(process.execPath, args, {
    env: { ...process.env, MAINTENANCE_LOCK_HELD_BY_PARENT: "1" },
    maxBuffer: 1024 * 1024 * 64,
  });
}

export const MAX_RESTORE_UPLOAD_BYTES = 200 * 1024 * 1024;
const MIN_RESTORE_UPLOAD_BYTES = 512;
const RESTORE_TICKET_ISSUER = "business-management-system";
const RESTORE_TICKET_AUDIENCE = "restore-upload";
const RESTORE_LOCK_STALE_MS = 5 * 60 * 1000;
const RESTORE_LOCK_HEARTBEAT_MS = 60 * 1000;
const RESTORE_LOCK_PATH = path.join(
  tmpdir(),
  `erp-restore-${createHash("sha256").update(process.cwd()).digest("hex").slice(0, 12)}.lock`,
);

/** Remove only old, exact restore artifacts left by a killed worker. */
export async function sweepStaleRestoreArtifacts(now = Date.now()): Promise<number> {
  const base = tmpdir();
  const entries = await readdir(base).catch(() => [] as string[]);
  let removed = 0;
  for (const name of entries) {
    const isUploadDir = /^erp-restore-upload-[A-Za-z0-9_-]+$/.test(name);
    const isUsedMarker = /^erp-restore-ticket-[0-9a-f-]{36}\.used$/i.test(name);
    if (!isUploadDir && !isUsedMarker) continue;
    const target = path.join(base, name);
    if (path.dirname(target) !== path.resolve(base)) continue;
    const info = await lstat(target).catch(() => null);
    if (!info || info.isSymbolicLink() || now - info.mtimeMs < 24 * 60 * 60 * 1000) continue;
    if (isUploadDir && !info.isDirectory()) continue;
    if (isUsedMarker && !info.isFile()) continue;
    await rm(target, { recursive: isUploadDir, force: true });
    removed += 1;
  }
  return removed;
}

export function restoreLockPath(): string {
  return RESTORE_LOCK_PATH;
}

export class RestoreUploadValidationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 = 400,
  ) {
    super(message);
    this.name = "RestoreUploadValidationError";
  }
}

function restoreTicketSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error("JWT_SECRET is required for restore upload tickets");
  return new TextEncoder().encode(secret);
}

export function normalizeRestoreFileName(fileName: string): string {
  const name = fileName.trim();
  if (
    name.length < 5 ||
    name.length > 128 ||
    name !== path.basename(name) ||
    name.includes("..") ||
    !/^[A-Za-z0-9._-]+\.sql$/i.test(name)
  ) {
    throw new RestoreUploadValidationError("اسم الملف غير صالح؛ اختر ملف .sql باسم بسيط.");
  }
  return name;
}

export type RestoreUploadTicket = {
  ticketId?: string;
  userId: number;
  sessionId: number;
  dbName: string;
  fileName: string;
  fileSize: number;
};

/** تذكرة قصيرة العمر: تفصل إعادة التحقّق الصغيرة عن دفق الملف الكبير. */
export async function issueRestoreUploadTicket(input: RestoreUploadTicket): Promise<string> {
  const fileName = normalizeRestoreFileName(input.fileName);
  if (!Number.isSafeInteger(input.fileSize) || input.fileSize < MIN_RESTORE_UPLOAD_BYTES) {
    throw new RestoreUploadValidationError("الملف صغير أو تالف.");
  }
  if (input.fileSize > MAX_RESTORE_UPLOAD_BYTES) {
    throw new RestoreUploadValidationError("الملف أكبر من الحدّ المسموح (200 م.ب).", 413);
  }
  return new SignJWT({
    purpose: RESTORE_TICKET_AUDIENCE,
    uid: input.userId,
    sid: input.sessionId,
    db: input.dbName,
    name: fileName,
    size: input.fileSize,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(RESTORE_TICKET_ISSUER)
    .setAudience(RESTORE_TICKET_AUDIENCE)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(restoreTicketSecret());
}

export async function verifyRestoreUploadTicket(token: string): Promise<RestoreUploadTicket | null> {
  try {
    const { payload } = await jwtVerify(token, restoreTicketSecret(), {
      algorithms: ["HS256"],
      issuer: RESTORE_TICKET_ISSUER,
      audience: RESTORE_TICKET_AUDIENCE,
      clockTolerance: 5,
    });
    if (payload.purpose !== RESTORE_TICKET_AUDIENCE) return null;
    const ticketId = typeof payload.jti === "string" && /^[0-9a-f-]{36}$/i.test(payload.jti)
      ? payload.jti
      : "";
    const userId = Number(payload.uid);
    const rawSid = payload.sid;
    const sessionId = Number(rawSid);
    const dbName = typeof payload.db === "string" ? payload.db : "";
    const fileName = typeof payload.name === "string" ? normalizeRestoreFileName(payload.name) : "";
    const fileSize = Number(payload.size);
    if (!ticketId || !Number.isInteger(userId) || userId <= 0) return null;
    if (!Number.isInteger(sessionId) || sessionId <= 0) return null;
    if (!dbName || !fileName || !Number.isSafeInteger(fileSize)) return null;
    if (fileSize < MIN_RESTORE_UPLOAD_BYTES || fileSize > MAX_RESTORE_UPLOAD_BYTES) return null;
    return { ticketId, userId, sessionId, dbName, fileName, fileSize };
  } catch {
    return null;
  }
}

/** استهلاك ذري للتذكرة بين عمال PM2؛ إعادة تشغيل نفس التذكرة تُرفض. */
export async function consumeRestoreUploadTicket(ticketId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(ticketId)) return false;
  const marker = path.join(tmpdir(), `erp-restore-ticket-${ticketId}.used`);
  try {
    const handle = await open(marker, "wx", 0o600);
    await handle.writeFile(new Date().toISOString());
    await handle.close();
    const timer = setTimeout(() => void unlink(marker).catch(() => {}), 10 * 60 * 1000);
    timer.unref();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/**
 * يحفظ SQL كدفق في ملف حصري خارج webroot. لا Base64 ولا تجميع في الذاكرة؛ الحارس
 * يعدّ البايتات أثناء الكتابة ويحذف أي ملف ناقص/زائد/غير صالح.
 */
export async function quarantineUploadStream(input: Readable, expectedBytes: number): Promise<string> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < MIN_RESTORE_UPLOAD_BYTES) {
    throw new RestoreUploadValidationError("الملف صغير أو تالف.");
  }
  if (expectedBytes > MAX_RESTORE_UPLOAD_BYTES) {
    throw new RestoreUploadValidationError("الملف أكبر من الحدّ المسموح (200 م.ب).", 413);
  }

  const dir = await mkdtemp(path.join(tmpdir(), "erp-restore-upload-"));
  const tmp = path.join(dir, "upload.sql");
  const handle = await open(tmp, "wx", 0o600);
  let bytes = 0;
  let head = Buffer.alloc(0);

  try {
    for await (const rawChunk of input) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      bytes += chunk.length;
      if (bytes > MAX_RESTORE_UPLOAD_BYTES || bytes > expectedBytes) {
        throw new RestoreUploadValidationError("تجاوز دفق الملف الحجم المصرّح به.", 413);
      }
      if (head.length < 4096) {
        head = Buffer.concat([head, chunk.subarray(0, 4096 - head.length)]);
      }
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        if (bytesWritten <= 0) throw new Error("تعذّرت كتابة دفق الاستعادة كاملاً.");
        offset += bytesWritten;
      }
    }
    await handle.sync();
    await handle.close();
    if (bytes !== expectedBytes) {
      throw new RestoreUploadValidationError("حجم الملف المستلم لا يطابق الحجم المصرّح به.");
    }
    if (!/ALROYA_DB_NEUTRAL_BACKUP|MySQL dump|CREATE TABLE|INSERT INTO|CREATE DATABASE/i.test(head.toString("utf8"))) {
      throw new RestoreUploadValidationError("الملف لا يبدو ناتج mysqldump صالحاً (.sql).");
    }
    return tmp;
  } catch (error) {
    await handle.close().catch(() => {});
    await cleanupTmp(tmp);
    throw error;
  }
}

/** قفل ذري مشترك بين عمال PM2؛ يمنع استعادتي قاعدة متزامنتين. */
export async function acquireRestoreLock(): Promise<() => Promise<void>> {
  const owner = `${process.pid}:${randomUUID()}`;
  const acquire = async () => {
    try {
      return await open(RESTORE_LOCK_PATH, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lockStat = await stat(RESTORE_LOCK_PATH).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > RESTORE_LOCK_STALE_MS) {
        console.error(`Stale restore lock requires operator review: ${RESTORE_LOCK_PATH}`);
        // لا نحذف قفلاً stale من داخل طلب ويب: unlink+open بلا CAS يسمح لطلبين متزامنين
        // بحذف قفل بعضهما. موت العملية حالة نادرة ويُعالجها المشغّل بإزالة الملف بعد التحقق
        // من عدم وجود restore، بينما السلامة هنا تفشل مغلقة دائماً.
        throw new RestoreUploadValidationError(
          "يوجد قفل استعادة قديم. تحقّق تشغيلياً من عدم وجود عملية restore ثم أزل ملف القفل يدوياً.",
        );
      }
      throw new RestoreUploadValidationError("توجد عملية استعادة أخرى قيد التنفيذ حالياً.");
    }
  };
  const handle = await acquire();
  await handle.writeFile(`${owner}\n${new Date().toISOString()}\n`);
  await handle.close();
  // نبضة تجعل كشف القفل اليتيم مرتبطاً بحيوية العملية، لا بمدة الاستعادة. لذلك حتى dump
  // بطيء يتجاوز ساعات لا يُحذف قفله، بينما قفل عملية ماتت يُسترد بعد دقائق قليلة.
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(RESTORE_LOCK_PATH, now, now).catch(() => {});
  }, RESTORE_LOCK_HEARTBEAT_MS);
  heartbeat.unref();
  return async () => {
    clearInterval(heartbeat);
    // إن استعاد عامل آخر قفلاً قديماً فلا يحق للمالك القديم حذف القفل الجديد عند انتهائه.
    const currentOwner = (await readFile(RESTORE_LOCK_PATH, "utf8").catch(() => "")).split("\n", 1)[0];
    if (currentOwner !== owner) return;
    await unlink(RESTORE_LOCK_PATH).catch(() => {});
  };
}

export async function cleanupTmp(p: string): Promise<void> {
  await unlink(p).catch(() => { /* ليس حرجاً */ });
  // مجلّد الحجر مولّد وفارغ بعد حذف الملف؛ لا يمسّ أي مسار آخر.
  if (path.basename(p) === "upload.sql" && path.basename(path.dirname(p)).startsWith("erp-restore-upload-")) {
    await rmdir(path.dirname(p)).catch(() => {});
  }
}
