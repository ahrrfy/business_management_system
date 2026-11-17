/**
 * HybridLocalR2ImageStore — سائق الوسائط الهجين لخادم الفرع الرئيسي المحلي.
 *
 * يعالج فجوة المسح البارد (`alroya-r2-v2` يعمل بفاصل 6 ساعات `21600s` للأرشفة والمرآة الباردة فقط
 * ولا يوفّر مزامنة لحظية ولا يثبت وحده مطابقة مراجع قاعدة البيانات):
 * 1. حفظ ذرّي فوري على تخزين LUKS المحلي المشفّر (`O_CREAT|O_EXCL` + `fsync` للملف والدليل) قبل إقرار الحفظ.
 * 2. طابور رفع/حذف محلي دائم (`outbox/<opId>.json`) بمعرفات ثابتة حتمية (`sha256(op|key|contentHash)`)
 *    وإعادة محاولة بتراجع أُسّي عبر انقطاع WAN أو إعادة تشغيل الخادم، دون حذف أي ملف معلّق عند تنظيف الكاش.
 * 3. قراءة محلية فورية أثناء انقطاع WAN من المخزن المحلي ومن المرآة الباردة (`coldMirrorRoot/objects/<key>`).
 * 4. مصالحة دورية صريحة بين مراجع قاعدة بيانات ERP (`productImages`, `productImageJobs`,
 *    `productImageObjectStaging`) والملفات المحلية وحالة الرفع إلى R2، مع مؤشر تأخر وتنبيه (`HEALTHY`/`WARN`/`CRITICAL`).
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { and, eq, isNotNull, or } from "drizzle-orm";
import {
  productImageJobs,
  productImageObjectStaging,
  productImages,
} from "../../../drizzle/schema";
import { classifyR2Failure, ImageStoreClientAbortError } from "./resilience";
import type { ImageStore, ImageStoreReadOptions, ObjectHead, PutResult } from "./types";

export const COLD_MIRROR_CADENCE_SECONDS = 6 * 3600;
const MAX_HYBRID_OBJECT_BYTES = 25 * 1024 * 1024;
const ALLOWED_HYBRID_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

export type HybridOutboxStatus =
  | "PENDING_UPLOAD"
  | "PENDING_DELETE"
  | "SYNCED_VERIFIED"
  | "FAILED_PERMANENT";

export interface HybridMediaOutboxEntry {
  version: 1;
  opId: string;
  operation: "PUT" | "DELETE";
  key: string;
  contentSha256: string | null;
  bytes: number | null;
  contentType: string | null;
  status: HybridOutboxStatus;
  attempts: number;
  createdAtMs: number;
  updatedAtMs: number;
  nextRetryAtMs: number;
  syncedAtMs: number | null;
  lastErrorCode: string | null;
}

export interface HybridMediaLagThresholds {
  warnPendingAgeSeconds?: number;
  criticalPendingAgeSeconds?: number;
  warnColdScanAgeSeconds?: number;
}

export interface HybridMediaLagSnapshot {
  evaluatedAtUtc: string;
  coldMirrorCadenceSeconds: number;
  coldMirrorIsRealTimeSync: false;
  coldScanLastCompletedUtc: string | null;
  coldScanAgeSeconds: number | null;
  coldScanStatusFromSupervisor: string | null;
  pendingUploadCount: number;
  pendingDeleteCount: number;
  syncedVerifiedCount: number;
  permanentFailureCount: number;
  oldestPendingUploadAgeSeconds: number;
  alertLevel: "HEALTHY" | "WARN" | "CRITICAL";
  alerts: string[];
}

export interface DbMediaReconciliationReport {
  evaluatedAtUtc: string;
  totalDistinctDbReferencedKeys: number;
  syncedLocalAndR2Keys: string[];
  localPresentPendingR2UploadKeys: string[];
  localMirrorPresentUnverifiedR2Keys: string[];
  missingEverywhereKeys: string[];
  integrityMismatchKeys: string[];
  coldBucketScanEquatedWithDbParity: false;
  verdict: "PARITY_VERIFIED" | "LOCAL_SAFE_R2_CATCHUP_PENDING" | "CRITICAL_MEDIA_GAP";
}

function assertSafeHybridKey(key: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/.test(key) ||
    key.includes("..") ||
    key.includes("//") ||
    key.startsWith("/")
  ) {
    throw new Error("HybridLocalR2ImageStore: مفتاح الكائن غير صالح.");
  }
}

function computeStableOpId(op: "PUT" | "DELETE", key: string, contentSha256: string | null): string {
  return createHash("sha256")
    .update(`alroya.hybrid_media_op.v1|${op}|${key}|${contentSha256 ?? "none"}`, "utf8")
    .digest("hex");
}

function safeOutboxErrorCode(err: unknown): string {
  if (!err || typeof err !== "object") return "R2_UNKNOWN_ERROR";
  const e = err as { code?: string; name?: string; $metadata?: { httpStatusCode?: number } };
  if (typeof e.code === "string" && /^[A-Za-z0-9_.-]{1,48}$/.test(e.code)) return e.code;
  if (typeof e.$metadata?.httpStatusCode === "number") return `HTTP_${e.$metadata.httpStatusCode}`;
  if (typeof e.name === "string" && /^[A-Za-z0-9_.-]{1,48}$/.test(e.name)) return e.name;
  return "R2_OPERATION_FAILED";
}

async function writeAtomicFsyncFile(targetPath: string, data: Buffer, mode = 0o600): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(dir, `.tmp-${path.basename(targetPath)}-${process.pid}-${randomUUID()}`);
  const fh = await fs.open(
    tmpPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
    mode,
  );
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmpPath, targetPath);
  const dirFh = await fs.open(dir, fsConstants.O_RDONLY);
  try {
    await dirFh.sync();
  } finally {
    await dirFh.close();
  }
}

export interface HybridLocalR2ImageStoreOptions {
  localRoot: string;
  remoteStore: ImageStore;
  coldMirrorRoot?: string | null;
  coldMirrorStatusFile?: string | null;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
}

export class HybridLocalR2ImageStore implements ImageStore {
  private readonly localRoot: string;
  private readonly objectsRoot: string;
  private readonly outboxRoot: string;
  private readonly coldObjectsRoot: string | null;
  private readonly coldMirrorStatusFile: string | null;
  private readonly remote: ImageStore;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private drainChain: Promise<unknown> = Promise.resolve();

  constructor(opts: HybridLocalR2ImageStoreOptions) {
    this.localRoot = path.resolve(opts.localRoot);
    this.objectsRoot = path.join(this.localRoot, "objects");
    this.outboxRoot = path.join(this.localRoot, "outbox");
    this.coldObjectsRoot = opts.coldMirrorRoot
      ? path.join(path.resolve(opts.coldMirrorRoot), "objects")
      : null;
    this.coldMirrorStatusFile = opts.coldMirrorStatusFile
      ? path.resolve(opts.coldMirrorStatusFile)
      : null;
    this.remote = opts.remoteStore;
    this.baseBackoffMs = opts.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  private resolveSafeUnder(baseDir: string, key: string): string {
    assertSafeHybridKey(key);
    const full = path.resolve(baseDir, key);
    if (full !== baseDir && !full.startsWith(baseDir + path.sep)) {
      throw new Error("HybridLocalR2ImageStore: مسار خارج الجذر المسموح.");
    }
    return full;
  }

  private outboxFilePath(opId: string): string {
    if (!/^[0-9a-f]{64}$/.test(opId)) throw new Error("Invalid opId");
    return path.join(this.outboxRoot, `${opId}.json`);
  }

  private async writeOutboxEntry(entry: HybridMediaOutboxEntry): Promise<void> {
    const buf = Buffer.from(JSON.stringify(entry, null, 2), "utf8");
    await writeAtomicFsyncFile(this.outboxFilePath(entry.opId), buf, 0o600);
  }

  async listOutboxEntries(): Promise<HybridMediaOutboxEntry[]> {
    try {
      const names = await fs.readdir(this.outboxRoot);
      const entries: HybridMediaOutboxEntry[] = [];
      for (const name of names) {
        if (!name.endsWith(".json") || name.startsWith(".tmp-")) continue;
        const raw = await fs.readFile(path.join(this.outboxRoot, name), "utf8");
        const parsed = JSON.parse(raw) as HybridMediaOutboxEntry;
        if (parsed && parsed.version === 1 && typeof parsed.opId === "string") {
          entries.push(parsed);
        }
      }
      entries.sort((a, b) => a.createdAtMs - b.createdAtMs);
      return entries;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw err;
    }
  }

  private async findLocalPathForKey(key: string): Promise<{ path: string; bytes: number; source: "local_primary" | "cold_mirror" } | null> {
    const primaryPath = this.resolveSafeUnder(this.objectsRoot, key);
    try {
      const st = await fs.stat(primaryPath);
      if (st.isFile()) return { path: primaryPath, bytes: st.size, source: "local_primary" };
    } catch {
      /* check cold mirror next */
    }
    if (this.coldObjectsRoot) {
      const mirrorPath = this.resolveSafeUnder(this.coldObjectsRoot, key);
      try {
        const st = await fs.stat(mirrorPath);
        if (st.isFile()) return { path: mirrorPath, bytes: st.size, source: "cold_mirror" };
      } catch {
        /* absent in cold mirror */
      }
    }
    return null;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<PutResult> {
    assertSafeHybridKey(key);
    const mime = contentType.toLowerCase();
    if (!ALLOWED_HYBRID_MIMES.has(mime)) {
      throw new Error("HybridLocalR2ImageStore: نوع الصورة غير مسموح.");
    }
    if (body.length === 0 || body.length > MAX_HYBRID_OBJECT_BYTES) {
      throw new Error("HybridLocalR2ImageStore: حجم الصورة خارج الحد المسموح.");
    }
    const sha256 = createHash("sha256").update(body).digest("hex");
    const primaryPath = this.resolveSafeUnder(this.objectsRoot, key);
    let existedLocally = false;
    try {
      const existingBytes = await fs.readFile(primaryPath);
      const existingSha = createHash("sha256").update(existingBytes).digest("hex");
      if (existingSha !== sha256) {
        throw new Error("HybridLocalR2ImageStore: تعارض بصمة محتوى لمفتاح ثابت موجود مسبقاً.");
      }
      existedLocally = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
      await writeAtomicFsyncFile(primaryPath, body, 0o600);
    }

    const opId = computeStableOpId("PUT", key, sha256);
    const nowMs = this.now();
    let existingEntry: HybridMediaOutboxEntry | null = null;
    try {
      const raw = await fs.readFile(this.outboxFilePath(opId), "utf8");
      existingEntry = JSON.parse(raw) as HybridMediaOutboxEntry;
    } catch {
      existingEntry = null;
    }

    if (existingEntry?.status === "SYNCED_VERIFIED") {
      return { key, bytes: body.length, existed: true };
    }

    const entry: HybridMediaOutboxEntry = existingEntry ?? {
      version: 1,
      opId,
      operation: "PUT",
      key,
      contentSha256: sha256,
      bytes: body.length,
      contentType: mime,
      status: "PENDING_UPLOAD",
      attempts: 0,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      nextRetryAtMs: nowMs,
      syncedAtMs: null,
      lastErrorCode: null,
    };
    await this.writeOutboxEntry(entry);

    // Attempt immediate upload if WAN is available; if WAN is down/transient, keep PENDING_UPLOAD!
    await this.tryExecuteOutboxEntry(entry);
    return { key, bytes: body.length, existed: existedLocally };
  }

  private async tryExecuteOutboxEntry(entry: HybridMediaOutboxEntry): Promise<HybridMediaOutboxEntry> {
    const nowMs = this.now();
    if (entry.status === "SYNCED_VERIFIED" || entry.status === "FAILED_PERMANENT") {
      return entry;
    }
    try {
      if (entry.operation === "PUT") {
        const primaryPath = this.resolveSafeUnder(this.objectsRoot, entry.key);
        const body = await fs.readFile(primaryPath);
        const actualSha = createHash("sha256").update(body).digest("hex");
        if (entry.contentSha256 && actualSha !== entry.contentSha256) {
          const corrupt: HybridMediaOutboxEntry = {
            ...entry,
            status: "FAILED_PERMANENT",
            attempts: entry.attempts + 1,
            updatedAtMs: nowMs,
            lastErrorCode: "LOCAL_HASH_MISMATCH",
          };
          await this.writeOutboxEntry(corrupt);
          return corrupt;
        }
        await this.remote.put(entry.key, body, entry.contentType ?? "image/png");
        const remoteHead = await this.remote.head(entry.key);
        if (!remoteHead.exists || (remoteHead.bytes != null && remoteHead.bytes !== body.length)) {
          throw Object.assign(new Error("Remote R2 head verification failed after put"), {
            code: "R2_HEAD_VERIFY_MISMATCH",
            $metadata: { httpStatusCode: 503 },
          });
        }
      } else {
        await this.remote.delete(entry.key);
      }

      const synced: HybridMediaOutboxEntry = {
        ...entry,
        status: "SYNCED_VERIFIED",
        attempts: entry.attempts + 1,
        updatedAtMs: nowMs,
        syncedAtMs: nowMs,
        lastErrorCode: null,
      };
      await this.writeOutboxEntry(synced);
      return synced;
    } catch (err) {
      const fClass = classifyR2Failure(err);
      const attempts = entry.attempts + 1;
      const delay = Math.min(this.maxBackoffMs, this.baseBackoffMs * Math.pow(2, Math.min(attempts - 1, 10)));
      const updated: HybridMediaOutboxEntry = {
        ...entry,
        status: fClass === "permanent" ? "FAILED_PERMANENT" : "PENDING_UPLOAD",
        ...(entry.operation === "DELETE" && fClass !== "permanent"
          ? { status: "PENDING_DELETE" as const }
          : {}),
        attempts,
        updatedAtMs: nowMs,
        nextRetryAtMs: nowMs + delay,
        lastErrorCode: safeOutboxErrorCode(err),
      };
      await this.writeOutboxEntry(updated);
      return updated;
    }
  }

  async drainPendingOutbox(options?: { ignoreBackoff?: boolean }): Promise<{
    attempted: number;
    synced: number;
    stillPending: number;
    failedPermanent: number;
  }> {
    const run = async () => {
      const entries = await this.listOutboxEntries();
      const nowMs = this.now();
      let attempted = 0;
      let synced = 0;
      let stillPending = 0;
      let failedPermanent = 0;
      for (const entry of entries) {
        if (entry.status === "SYNCED_VERIFIED") continue;
        if (entry.status === "FAILED_PERMANENT") {
          failedPermanent++;
          continue;
        }
        if (!options?.ignoreBackoff && entry.nextRetryAtMs > nowMs) {
          stillPending++;
          continue;
        }
        attempted++;
        const after = await this.tryExecuteOutboxEntry(entry);
        if (after.status === "SYNCED_VERIFIED") synced++;
        else if (after.status === "FAILED_PERMANENT") failedPermanent++;
        else stillPending++;
      }
      return { attempted, synced, stillPending, failedPermanent };
    };
    const next = this.drainChain.then(run, run);
    this.drainChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async head(key: string): Promise<ObjectHead> {
    const local = await this.findLocalPathForKey(key);
    if (local) return { exists: true, bytes: local.bytes };
    try {
      return await this.remote.head(key);
    } catch {
      return { exists: false };
    }
  }

  async getStream(key: string, options: ImageStoreReadOptions = {}): Promise<Readable | null> {
    if (options.signal?.aborted) throw new ImageStoreClientAbortError();
    const local = await this.findLocalPathForKey(key);
    if (local) {
      if (options.signal?.aborted) throw new ImageStoreClientAbortError();
      return createReadStream(local.path);
    }
    return this.remote.getStream(key, options);
  }

  async getBuffer(key: string, expectedBytes: number, options: ImageStoreReadOptions = {}): Promise<Buffer | null> {
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > MAX_HYBRID_OBJECT_BYTES) {
      throw new Error("HybridLocalR2ImageStore: حد القراءة غير صالح.");
    }
    if (options.signal?.aborted) throw new ImageStoreClientAbortError();
    const local = await this.findLocalPathForKey(key);
    if (local) {
      if (local.bytes !== expectedBytes) {
        throw new Error("HybridLocalR2ImageStore: حجم الكائن المحلي لا يطابق metadata المعتمدة.");
      }
      const body = await fs.readFile(local.path);
      if (options.signal?.aborted) throw new ImageStoreClientAbortError();
      if (body.length !== expectedBytes) {
        throw new Error("HybridLocalR2ImageStore: حجم الكائن المحلي لا يطابق metadata المعتمدة.");
      }
      return body;
    }
    const fromRemote = await this.remote.getBuffer(key, expectedBytes, options);
    if (fromRemote) {
      const primaryPath = this.resolveSafeUnder(this.objectsRoot, key);
      await writeAtomicFsyncFile(primaryPath, fromRemote, 0o600).catch(() => {});
    }
    return fromRemote;
  }

  async delete(key: string): Promise<void> {
    assertSafeHybridKey(key);
    const entries = await this.listOutboxEntries();
    const hasPendingUpload = entries.some(
      (e) => e.key === key && e.status === "PENDING_UPLOAD",
    );
    if (hasPendingUpload) {
      throw new Error("HybridLocalR2ImageStore: رفض حذف ملف محلي له عملية رفع معلّقة في الطابور.");
    }
    const primaryPath = this.resolveSafeUnder(this.objectsRoot, key);
    await fs.unlink(primaryPath).catch(() => {});
    const nowMs = this.now();
    const opId = computeStableOpId("DELETE", key, null);
    const delEntry: HybridMediaOutboxEntry = {
      version: 1,
      opId,
      operation: "DELETE",
      key,
      contentSha256: null,
      bytes: null,
      contentType: null,
      status: "PENDING_DELETE",
      attempts: 0,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      nextRetryAtMs: nowMs,
      syncedAtMs: null,
      lastErrorCode: null,
    };
    await this.writeOutboxEntry(delEntry);
    await this.tryExecuteOutboxEntry(delEntry);
  }

  /**
   * تنظيف الملفات المؤقتة أو الكاش المتقادم المزامَن فقط — لا يحذف أبداً أي ملف مرتبط بطابور
   * `PENDING_UPLOAD` أو `FAILED_PERMANENT` أو مذكور في مجموعة المفاتيح المحمية لقاعدة البيانات!
   */
  async pruneStaleTempAndUnreferencedSyncedCache(params: {
    maxAgeMs: number;
    protectedDbKeys: ReadonlySet<string>;
  }): Promise<{ deletedSyncedKeys: string[]; preservedPendingKeys: string[] }> {
    const entries = await this.listOutboxEntries();
    const pendingKeySet = new Set(
      entries
        .filter((e) => e.status === "PENDING_UPLOAD" || e.status === "FAILED_PERMANENT")
        .map((e) => e.key),
    );
    const syncedByKey = new Map<string, HybridMediaOutboxEntry>();
    for (const e of entries) {
      if (e.operation === "PUT" && e.status === "SYNCED_VERIFIED") {
        syncedByKey.set(e.key, e);
      }
    }

    const deletedSyncedKeys: string[] = [];
    const preservedPendingKeys: string[] = Array.from(pendingKeySet);
    const cutoffMs = this.now() - params.maxAgeMs;

    for (const [key, syncedEntry] of Array.from(syncedByKey.entries())) {
      if (pendingKeySet.has(key) || params.protectedDbKeys.has(key)) continue;
      const full = this.resolveSafeUnder(this.objectsRoot, key);
      try {
        const st = await fs.stat(full);
        if (st.mtimeMs < cutoffMs && (syncedEntry.syncedAtMs ?? 0) < cutoffMs) {
          await fs.unlink(full);
          deletedSyncedKeys.push(key);
        }
      } catch {
        /* already absent */
      }
    }
    return { deletedSyncedKeys, preservedPendingKeys };
  }

  async computeLagSnapshot(thresholds?: HybridMediaLagThresholds): Promise<HybridMediaLagSnapshot> {
    const warnPendingSec = thresholds?.warnPendingAgeSeconds ?? 300;
    const critPendingSec = thresholds?.criticalPendingAgeSeconds ?? 1_800;
    const warnColdSec = thresholds?.warnColdScanAgeSeconds ?? 8 * 3_600;
    const nowMs = this.now();
    const entries = await this.listOutboxEntries();

    let pendingUploadCount = 0;
    let pendingDeleteCount = 0;
    let syncedVerifiedCount = 0;
    let permanentFailureCount = 0;
    let oldestPendingCreatedAtMs: number | null = null;

    for (const e of entries) {
      if (e.status === "PENDING_UPLOAD") {
        pendingUploadCount++;
        if (oldestPendingCreatedAtMs == null || e.createdAtMs < oldestPendingCreatedAtMs) {
          oldestPendingCreatedAtMs = e.createdAtMs;
        }
      } else if (e.status === "PENDING_DELETE") {
        pendingDeleteCount++;
      } else if (e.status === "SYNCED_VERIFIED") {
        syncedVerifiedCount++;
      } else if (e.status === "FAILED_PERMANENT") {
        permanentFailureCount++;
      }
    }

    const oldestPendingUploadAgeSeconds =
      oldestPendingCreatedAtMs == null
        ? 0
        : Math.max(0, Math.floor((nowMs - oldestPendingCreatedAtMs) / 1000));

    let coldScanLastCompletedUtc: string | null = null;
    let coldScanAgeSeconds: number | null = null;
    let coldScanStatusFromSupervisor: string | null = null;
    if (this.coldMirrorStatusFile) {
      try {
        const raw = await fs.readFile(this.coldMirrorStatusFile, "utf8");
        const parsed = JSON.parse(raw) as {
          lastCompleted?: { finishedUtc?: string; summary?: { status?: string } };
        };
        coldScanLastCompletedUtc = parsed?.lastCompleted?.finishedUtc ?? null;
        coldScanStatusFromSupervisor = parsed?.lastCompleted?.summary?.status ?? null;
        if (coldScanLastCompletedUtc) {
          const ts = new Date(coldScanLastCompletedUtc).getTime();
          if (Number.isFinite(ts)) {
            coldScanAgeSeconds = Math.max(0, Math.floor((nowMs - ts) / 1000));
          }
        }
      } catch {
        /* status file optional in isolated environments */
      }
    }

    const alerts: string[] = [];
    let alertLevel: "HEALTHY" | "WARN" | "CRITICAL" = "HEALTHY";
    if (permanentFailureCount > 0) {
      alertLevel = "CRITICAL";
      alerts.push(`HYBRID_R2_PERMANENT_FAILURES:${permanentFailureCount}`);
    }
    if (pendingUploadCount > 0 && oldestPendingUploadAgeSeconds >= critPendingSec) {
      alertLevel = "CRITICAL";
      alerts.push(`HYBRID_R2_UPLOAD_LAG_CRITICAL:${oldestPendingUploadAgeSeconds}s`);
    } else if (pendingUploadCount > 0 && oldestPendingUploadAgeSeconds >= warnPendingSec) {
      if (alertLevel === "HEALTHY") alertLevel = "WARN";
      alerts.push(`HYBRID_R2_UPLOAD_LAG_WARN:${oldestPendingUploadAgeSeconds}s`);
    }
    if (coldScanAgeSeconds != null && coldScanAgeSeconds >= warnColdSec) {
      if (alertLevel === "HEALTHY") alertLevel = "WARN";
      alerts.push(`COLD_MIRROR_SCAN_STALE:${coldScanAgeSeconds}s`);
    }

    return {
      evaluatedAtUtc: new Date(nowMs).toISOString(),
      coldMirrorCadenceSeconds: COLD_MIRROR_CADENCE_SECONDS,
      coldMirrorIsRealTimeSync: false,
      coldScanLastCompletedUtc,
      coldScanAgeSeconds,
      coldScanStatusFromSupervisor,
      pendingUploadCount,
      pendingDeleteCount,
      syncedVerifiedCount,
      permanentFailureCount,
      oldestPendingUploadAgeSeconds,
      alertLevel,
      alerts,
    };
  }

  async reconcileWithDatabase(db: {
    select: (...args: any[]) => any;
  }): Promise<DbMediaReconciliationReport> {
    const expected = new Map<string, { sha256: string | null; bytes: number | null }>();

    const imgRows = await db
      .select({
        objectKey: productImages.objectKey,
        originalKey: productImages.originalKey,
        contentHash: productImages.contentHash,
        bytes: productImages.bytes,
      })
      .from(productImages)
      .where(or(isNotNull(productImages.objectKey), isNotNull(productImages.originalKey)));

    for (const r of imgRows) {
      if (r.objectKey) {
        expected.set(String(r.objectKey), {
          sha256: r.contentHash ? String(r.contentHash) : null,
          bytes: r.bytes != null ? Number(r.bytes) : null,
        });
      }
      if (r.originalKey && !expected.has(String(r.originalKey))) {
        expected.set(String(r.originalKey), { sha256: null, bytes: null });
      }
    }

    const jobRows = await db
      .select({
        originalObjectKey: productImageJobs.originalObjectKey,
        processedObjectKey: productImageJobs.processedObjectKey,
        processedContentHash: productImageJobs.processedContentHash,
        processedBytes: productImageJobs.processedBytes,
      })
      .from(productImageJobs)
      .where(
        or(
          isNotNull(productImageJobs.originalObjectKey),
          isNotNull(productImageJobs.processedObjectKey),
        ),
      );

    for (const j of jobRows) {
      if (j.processedObjectKey && !expected.has(String(j.processedObjectKey))) {
        expected.set(String(j.processedObjectKey), {
          sha256: j.processedContentHash ? String(j.processedContentHash) : null,
          bytes: j.processedBytes != null ? Number(j.processedBytes) : null,
        });
      }
      if (j.originalObjectKey && !expected.has(String(j.originalObjectKey))) {
        expected.set(String(j.originalObjectKey), { sha256: null, bytes: null });
      }
    }

    const stageRows = await db
      .select({ objectKey: productImageObjectStaging.objectKey })
      .from(productImageObjectStaging)
      .where(eq(productImageObjectStaging.state, "REFERENCED"));

    for (const st of stageRows) {
      if (st.objectKey && !expected.has(String(st.objectKey))) {
        expected.set(String(st.objectKey), { sha256: null, bytes: null });
      }
    }

    const outboxEntries = await this.listOutboxEntries();
    const outboxByKey = new Map<string, HybridMediaOutboxEntry>();
    for (const e of outboxEntries) {
      if (e.operation === "PUT") outboxByKey.set(e.key, e);
    }

    const syncedLocalAndR2Keys: string[] = [];
    const localPresentPendingR2UploadKeys: string[] = [];
    const localMirrorPresentUnverifiedR2Keys: string[] = [];
    const missingEverywhereKeys: string[] = [];
    const integrityMismatchKeys: string[] = [];

    for (const [key, meta] of Array.from(expected.entries())) {
      const local = await this.findLocalPathForKey(key);
      if (!local) {
        const remoteHead = await this.remote.head(key).catch(() => ({ exists: false } as ObjectHead));
        if (!remoteHead.exists) {
          missingEverywhereKeys.push(key);
        } else {
          localMirrorPresentUnverifiedR2Keys.push(key);
        }
        continue;
      }

      const rawBytes = await fs.readFile(local.path);
      if (meta.bytes != null && rawBytes.length !== meta.bytes) {
        integrityMismatchKeys.push(key);
        continue;
      }
      if (meta.sha256) {
        const actualSha = createHash("sha256").update(rawBytes).digest("hex");
        if (actualSha.toLowerCase() !== meta.sha256.toLowerCase()) {
          integrityMismatchKeys.push(key);
          continue;
        }
      }

      const ob = outboxByKey.get(key);
      if (ob?.status === "PENDING_UPLOAD" || ob?.status === "FAILED_PERMANENT") {
        localPresentPendingR2UploadKeys.push(key);
      } else if (ob?.status === "SYNCED_VERIFIED") {
        syncedLocalAndR2Keys.push(key);
      } else {
        const remoteHead = await this.remote.head(key).catch(() => ({ exists: false } as ObjectHead));
        if (remoteHead.exists) syncedLocalAndR2Keys.push(key);
        else localMirrorPresentUnverifiedR2Keys.push(key);
      }
    }

    const verdict =
      missingEverywhereKeys.length > 0 || integrityMismatchKeys.length > 0
        ? "CRITICAL_MEDIA_GAP"
        : localPresentPendingR2UploadKeys.length > 0 || localMirrorPresentUnverifiedR2Keys.length > 0
          ? "LOCAL_SAFE_R2_CATCHUP_PENDING"
          : "PARITY_VERIFIED";

    return {
      evaluatedAtUtc: new Date(this.now()).toISOString(),
      totalDistinctDbReferencedKeys: expected.size,
      syncedLocalAndR2Keys: syncedLocalAndR2Keys.sort(),
      localPresentPendingR2UploadKeys: localPresentPendingR2UploadKeys.sort(),
      localMirrorPresentUnverifiedR2Keys: localMirrorPresentUnverifiedR2Keys.sort(),
      missingEverywhereKeys: missingEverywhereKeys.sort(),
      integrityMismatchKeys: integrityMismatchKeys.sort(),
      coldBucketScanEquatedWithDbParity: false,
      verdict,
    };
  }
}
