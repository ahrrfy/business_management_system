import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const timestamp = z.string().datetime({ offset: true });
const fingerprint = z.object({
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const manifestSchema = fingerprint.extend({
  version: z.literal(1),
  file: z.string(),
  publishedAt: timestamp,
  source: fingerprint.extend({ file: z.string() }),
});
const attemptSchema = z.object({
  version: z.literal(1),
  file: z.string(),
  status: z.enum(["STARTED", "COMPLETED", "FAILED"]),
  startedAt: timestamp,
  finishedAt: timestamp.nullable(),
});
const attachmentSchema = z.object({
  scope: z.literal("KNOWN_FILE_REFERENCES_V1"),
  references: z.number().int().nonnegative(),
  inlineVerified: z.number().int().nonnegative(),
  mirroredVerified: z.number().int().nonnegative(),
}).refine(({ references, inlineVerified, mirroredVerified }) =>
  inlineVerified + mirroredVerified <= references,
);
const restoreProof = z.object({
  productionContact: z.literal(false),
  finishedAt: timestamp,
  sourceBefore: fingerprint,
  sourceAfter: fingerprint,
});
const restoreSchema = z.discriminatedUnion("status", [
  restoreProof.extend({
    status: z.literal("SQL_RESTORED_CORE_READS_PASSED"),
    stopped: z.literal(true),
    sqlFingerprint: fingerprint,
    attachmentCheck: attachmentSchema.optional().catch(undefined),
  }),
  restoreProof.extend({
    status: z.literal("NOT_RESTORE_VERIFIED"),
    failure: z.string().regex(/^[A-Z0-9_]+$/).max(64),
  }),
]);

const drillVerifiedSchema = z.object({
  status: z.enum(["VERIFIED", "PARTIAL"]),
  tableCount: z.number().int().positive(),
  rowCounts: z.object({
    users: z.number().int().nonnegative(),
    branches: z.number().int().nonnegative(),
    invoices: z.number().int().nonnegative(),
    products: z.number().int().nonnegative(),
  }),
  attachmentCheck: attachmentSchema,
});
const drillResultSchema = z.discriminatedUnion("status", [
  drillVerifiedSchema,
  z.object({ status: z.literal("BLOCKED"), code: z.enum(["KEY_REQUIRED", "ENGINE_REQUIRED", "IMAGE_REQUIRED"]) }),
  z.object({
    status: z.literal("FAILED"),
    code: z.enum(["ARCHIVE_INVALID", "DECRYPTION_FAILED", "IMPORT_FAILED", "ROLLBACK_FAILED", "CLEANUP_FAILED", "FAILED"]),
  }),
]);
const drillAttemptSchema = z.object({
  version: z.literal(1),
  file: z.string(),
  source: fingerprint,
  lease: z.string().regex(/^\d+:[a-f0-9-]{36}$/i),
  startedAt: timestamp,
  finishedAt: timestamp.nullable(),
  result: drillResultSchema.nullable(),
});
const drillProofSchema = drillVerifiedSchema.omit({ status: true }).extend({
  screenExercise: z.literal(true),
  candidateRemoved: z.literal(true),
  encryptedBackup: z.literal("GPG_AUTHENTICATED_DECRYPTION_PASSED"),
  rollback: z.object({ status: z.literal("VERIFIED"), trigger: z.literal("INJECTED_HEALTH_FAILURE") }),
});
type RestoreDrillResult = z.infer<typeof drillResultSchema>;
export type RestoreDrillAttempt = z.infer<typeof drillAttemptSchema>;

export function isBackupSqlName(name: string) {
  return /^[A-Za-z0-9_.$-]+\.sql$/.test(name) && !name.includes("..");
}

export function parseBackupDatabaseName(name: string): string | null {
  if (!isBackupSqlName(name)) return null;
  const match = /^([A-Za-z0-9_$-]+)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3}Z-[a-f0-9]{8})?\.sql$/i.exec(name);
  return match ? match[1] : null;
}

export function matchesBackupPrefix(name: string, prefix: string | null): boolean {
  if (!isBackupSqlName(name)) return false;
  if (!prefix) return true;
  const expectedDb = prefix.endsWith("-") ? prefix.slice(0, -1) : prefix;
  const parsedDb = parseBackupDatabaseName(name);
  return parsedDb !== null ? parsedDb === expectedDb : name.startsWith(prefix);
}

type Attempt = z.infer<typeof attemptSchema>;
type Fingerprint = z.infer<typeof fingerprint>;
type Manifest = z.infer<typeof manifestSchema>;
type CopyEvidence =
  | { status: "MISSING" | "UNVERIFIED"; at: null }
  | { status: "RECORDED"; at: string };

function backupNameDate(name: string) {
  const date = /-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3})Z-[a-f0-9]{8})?\.sql$/.exec(name);
  if (!date) return null;
  const [, day, hour, minute, second, millis = "000"] = date;
  const iso = `${day}T${hour}:${minute}:${second}.${millis}Z`;
  return timestamp.safeParse(iso).success ? iso : null;
}

function sameFile(first: Fingerprint, second: Fingerprint) {
  return first.size === second.size && first.sha256 === second.sha256;
}

async function ordinaryFile(file: string) {
  const metadata = await lstat(file).catch(() => null);
  return metadata?.isFile() ? metadata : null;
}

async function smallJson(file: string, metadata: Awaited<ReturnType<typeof ordinaryFile>>) {
  if (!metadata || metadata.size > 64 * 1024) return null;
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function namesIn(directory: string) {
  try {
    return new Set(await readdir(directory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set<string>();
    throw error;
  }
}

export async function readBackupAttempt(directory: string, name: string): Promise<Attempt | null> {
  if (!isBackupSqlName(name)) return null;
  const file = path.join(directory, `${name}.attempt.json`);
  const parsed = attemptSchema.safeParse(await smallJson(file, await ordinaryFile(file)));
  if (!parsed.success || parsed.data.file !== name) return null;
  const attempt = parsed.data;
  if (attempt.status === "STARTED") return attempt.finishedAt === null ? attempt : null;
  return attempt.finishedAt && attempt.finishedAt >= attempt.startedAt ? attempt : null;
}

async function inspectArchive(directory: string, entries: Set<string>, name: string): Promise<{
  evidence: CopyEvidence;
  manifest: Manifest | null;
}> {
  const encryptedName = `${name}.gpg`;
  const markerName = `${encryptedName}.manifest.json`;
  if (!entries.has(encryptedName) && !entries.has(markerName)) {
    return { evidence: { status: "MISSING", at: null }, manifest: null };
  }
  const markerPath = path.join(directory, markerName);
  const [archive, marker] = await Promise.all([
    ordinaryFile(path.join(directory, encryptedName)),
    ordinaryFile(markerPath),
  ]);
  const parsed = manifestSchema.safeParse(await smallJson(markerPath, marker));
  if (!archive || !marker || !parsed.success ||
      parsed.data.file !== encryptedName || parsed.data.source.file !== name ||
      archive.size !== parsed.data.size || archive.mtimeMs > marker.mtimeMs) {
    return { evidence: { status: "UNVERIFIED", at: null }, manifest: null };
  }
  // The marker records verification at publication or copy time. No archive
  // bytes are rehashed in the settings request.
  return { evidence: { status: "RECORDED", at: marker.mtime.toISOString() }, manifest: parsed.data };
}

export async function resolveRecordedArchive(
  directory: string,
  offsitePath: string | undefined,
  archiveName: string,
): Promise<{ file: string; manifest: Manifest } | null> {
  const name = archiveName.endsWith(".gpg") ? archiveName.slice(0, -4) : "";
  if (!isBackupSqlName(name)) return null;
  const entries = new Set([archiveName, `${archiveName}.manifest.json`]);
  for (const root of [directory, offsitePath]) {
    if (!root) continue;
    const canonical = await realpath(root).catch(() => null);
    if (!canonical) continue;
    const { manifest } = await inspectArchive(canonical, entries, name);
    if (manifest) return { file: path.join(canonical, archiveName), manifest };
  }
  return null;
}

export function summarizeRestoreDrill(report: unknown, manifest: Manifest, workerSucceeded: boolean): RestoreDrillResult {
  const parsed = restoreSchema.safeParse(report);
  if (!parsed.success) return { status: "FAILED", code: "FAILED" };
  const proof = parsed.data;
  if (!sameFile(proof.sourceBefore, manifest) || !sameFile(proof.sourceAfter, manifest)) {
    return { status: "FAILED", code: "ARCHIVE_INVALID" };
  }
  if (proof.status === "NOT_RESTORE_VERIFIED") {
    switch (proof.failure) {
      case "BACKUP_KEY_REQUIRED": return { status: "BLOCKED", code: "KEY_REQUIRED" };
      case "DOCKER_CONTEXT_FAILED":
      case "DOCKER_INFO_FAILED":
      case "LOCAL_DOCKER_REQUIRED":
      case "LOCAL_LINUX_DOCKER_REQUIRED": return { status: "BLOCKED", code: "ENGINE_REQUIRED" };
      case "DOCKER_IMAGE_FAILED": return { status: "BLOCKED", code: "IMAGE_REQUIRED" };
      case "BACKUP_MANIFEST_INVALID":
      case "DECRYPTED_SQL_FINGERPRINT_MISMATCH":
      case "SOURCE_CHANGED_DURING_DRILL": return { status: "FAILED", code: "ARCHIVE_INVALID" };
      case "BACKUP_KEY_OR_CIPHERTEXT_FAILED":
      case "BACKUP_RESTORE_DECRYPTION_FAILED": return { status: "FAILED", code: "DECRYPTION_FAILED" };
      case "IMPORT_FAILED":
      case "IMPORT_TIMEOUT": return { status: "FAILED", code: "IMPORT_FAILED" };
      case "DRILL_ROLLBACK_FAILED":
      case "DRILL_CANDIDATE_TARGET_INVALID": return { status: "FAILED", code: "ROLLBACK_FAILED" };
      case "SANDBOX_CLEANUP_FAILED": return { status: "FAILED", code: "CLEANUP_FAILED" };
      default: return { status: "FAILED", code: "FAILED" };
    }
  }
  const exercise = drillProofSchema.safeParse(report);
  if (!workerSucceeded || !exercise.success || !sameFile(proof.sqlFingerprint, manifest.source)) {
    return { status: "FAILED", code: "FAILED" };
  }
  const { tableCount, rowCounts, attachmentCheck } = exercise.data;
  const verified = attachmentCheck.inlineVerified + attachmentCheck.mirroredVerified === attachmentCheck.references;
  return { status: verified ? "VERIFIED" : "PARTIAL", tableCount, rowCounts, attachmentCheck };
}

export async function writeRestoreDrillAttempt(directory: string, attempt: RestoreDrillAttempt) {
  if (!isBackupSqlName(attempt.file)) throw Error("Invalid backup filename");
  const reports = path.join(directory, "restore-reports");
  await mkdir(reports, { recursive: true, mode: 0o700 });
  if (!(await lstat(reports)).isDirectory()) throw Error("Invalid restore report directory");
  const marker = path.join(reports, `${attempt.file}.drill.json`);
  const temporary = `${marker}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(attempt), { flag: "wx", mode: 0o600 });
    await rename(temporary, marker);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function timestampEpochMs(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

function compareTimestampsDesc(a: string | null | undefined, b: string | null | undefined): number {
  const diff = timestampEpochMs(b) - timestampEpochMs(a);
  if (diff !== 0) return diff;
  return (b ?? "").localeCompare(a ?? "");
}

function isNewerTimestamp(candidate: string, existing: string): boolean {
  return compareTimestampsDesc(candidate, existing) < 0;
}

function isNewerOrEqualTimestamp(candidate: string, existing: string): boolean {
  return compareTimestampsDesc(candidate, existing) <= 0;
}

async function readRestoreDrill(directory: string, name: string, manifest: Manifest, activeLease?: string) {
  const marker = path.join(directory, `${name}.drill.json`);
  const parsed = drillAttemptSchema.safeParse(await smallJson(marker, await ordinaryFile(marker)));
  if (!parsed.success) return null;
  const attempt = parsed.data;
  if (attempt.file !== name || !sameFile(attempt.source, manifest)) return null;
  if (attempt.finishedAt && attempt.result && isNewerOrEqualTimestamp(attempt.finishedAt, attempt.startedAt)) {
    return { ...attempt.result, at: attempt.finishedAt };
  }
  if (!attempt.finishedAt && !attempt.result) {
    return { status: attempt.lease === activeLease ? "RUNNING" as const : "INTERRUPTED" as const, at: attempt.startedAt };
  }
  return null;
}

async function readRestoreEvidence(directory: string, name: string, manifest: Manifest) {
  const file = path.join(directory, `${name}.restore.json`);
  const report = restoreSchema.safeParse(await smallJson(file, await ordinaryFile(file)));
  if (!report.success) return null;
  const { sourceBefore, sourceAfter, finishedAt } = report.data;
  if (!sameFile(sourceBefore, sourceAfter) ||
      !(sameFile(sourceBefore, manifest) || sameFile(sourceBefore, manifest.source))) return null;

  if (report.data.status === "NOT_RESTORE_VERIFIED") {
    const code = report.data.failure === "BACKUP_KEY_REQUIRED" ? "KEY_REQUIRED"
      : ["BACKUP_KEY_OR_CIPHERTEXT_FAILED", "BACKUP_RESTORE_DECRYPTION_FAILED"].includes(report.data.failure) ? "DECRYPTION_FAILED"
      : "FAILED";
    return { restoredAt: null, failure: { code, at: finishedAt }, attachments: null } as const;
  }
  if (!sameFile(report.data.sqlFingerprint, manifest.source)) return null;
  return { restoredAt: finishedAt, failure: null, attachments: report.data.attachmentCheck ?? null };
}

async function inspectBackup(
  name: string,
  directory: string,
  localNames: Set<string>,
  offsiteDirectory: string | null,
  offsiteNames: Set<string>,
  reportDirectory: string,
  reportNames: Set<string>,
  activeLease?: string,
) {
  const [sql, attempt, local, offsite] = await Promise.all([
    localNames.has(name) ? ordinaryFile(path.join(directory, name)) : null,
    localNames.has(`${name}.attempt.json`) ? readBackupAttempt(directory, name) : null,
    inspectArchive(directory, localNames, name),
    inspectArchive(offsiteDirectory ?? directory, offsiteNames, name),
  ]);
  const copyConflicts = local.manifest && offsite.manifest &&
    (!sameFile(local.manifest, offsite.manifest) || !sameFile(local.manifest.source, offsite.manifest.source));
  const manifest = local.manifest ?? offsite.manifest;
  const [restore, drill] = await Promise.all([
    manifest && reportNames.has(`${name}.restore.json`) ? readRestoreEvidence(reportDirectory, name, manifest) : null,
    manifest && reportNames.has(`${name}.drill.json`) ? readRestoreDrill(reportDirectory, name, manifest, activeLease) : null,
  ]);
  const verifiedDrill = drill && "attachmentCheck" in drill && (!restore?.restoredAt || isNewerOrEqualTimestamp(drill.at, restore.restoredAt)) ? drill : null;
  if (!sql && !attempt && local.evidence.status === "MISSING" && offsite.evidence.status === "MISSING") return null;
  const sqlAvailable = !!sql && sql.size > 0;
  return {
    name,
    sizeKb: Math.round((sql?.size ?? manifest?.size ?? 0) / 1024),
    createdAt: attempt?.startedAt ?? backupNameDate(name) ?? manifest?.publishedAt ?? sql?.mtime.toISOString() ?? null,
    sqlAvailable,
    attempt,
    encryption: local.evidence,
    offsite: copyConflicts ? { status: "UNVERIFIED", at: null } as const : offsite.evidence,
    restoredAt: verifiedDrill?.at ?? restore?.restoredAt ?? null,
    restoreFailure: restore?.failure ?? null,
    attachmentCheck: verifiedDrill?.attachmentCheck ?? restore?.attachments ?? null,
    drill,
  };
}

const latestRestoreEntrySchema = z.object({
  name: z.string(),
  at: timestamp,
});

const latestRestoreSummarySchema = z.object({
  version: z.literal(1),
  name: z.string(),
  at: timestamp,
  byDatabase: z.record(z.string(), latestRestoreEntrySchema).optional(),
});

const MIN_PROTECTED_ENCRYPTED_BACKUPS = 3;
const MAX_BARE_FAILED_ROWS_IN_SLICE = 10;

export async function inspectBackupReadiness(
  directory: string,
  offsitePath: string | undefined,
  prefix: string | null,
  activeLease?: string,
  { limit = 50 }: { limit?: number | null } = {},
) {
  const reportDirectory = path.join(directory, "restore-reports");
  const retiringDirectory = path.join(directory, ".retiring");
  const [localNames, reportNames, retiringNames, localRealPath, externalRealPath] = await Promise.all([
    namesIn(directory),
    namesIn(reportDirectory),
    namesIn(retiringDirectory),
    realpath(directory).catch(() => directory),
    offsitePath ? realpath(offsitePath).catch(() => null) : null,
  ]);
  const offsiteDirectory = externalRealPath && path.relative(localRealPath, externalRealPath)
    ? externalRealPath
    : null;
  const offsiteNames = offsiteDirectory ? await namesIn(offsiteDirectory).catch(() => new Set<string>()) : new Set<string>();
  const candidates = new Set<string>();
  for (const name of Array.from(localNames).concat(Array.from(offsiteNames))) {
    const base = name.replace(/(?:\.attempt\.json|\.gpg(?:\.manifest\.json)?)$/, "");
    if (!matchesBackupPrefix(base, prefix)) continue;
    if (retiringNames.has(`${base}.retired.json`)) continue;
    candidates.add(base);
  }

  const rows: Array<NonNullable<Awaited<ReturnType<typeof inspectBackup>>> & { protectedRecent?: boolean }> = [];
  const names = Array.from(candidates);
  for (let i = 0; i < names.length; i += 16) {
    const group = await Promise.all(names.slice(i, i + 16).map((name) =>
      inspectBackup(name, directory, localNames, offsiteDirectory, offsiteNames, reportDirectory, reportNames, activeLease),
    ));
    for (const row of group) if (row) rows.push(row);
  }
  rows.sort((a, b) => compareTimestampsDesc(a.createdAt, b.createdAt) || b.name.localeCompare(a.name));

  const verifiedRows = rows.filter(
    (row) => row.encryption.status === "RECORDED" || row.offsite.status === "RECORDED",
  );
  const encryptedCount = verifiedRows.length;
  const protectedNames = new Set<string>();
  const verifiedByDb = new Map<string, typeof verifiedRows>();
  for (const row of verifiedRows) {
    const dbKey = parseBackupDatabaseName(row.name) ?? "";
    const bucket = verifiedByDb.get(dbKey) ?? [];
    bucket.push(row);
    verifiedByDb.set(dbKey, bucket);
  }
  for (const bucket of Array.from(verifiedByDb.values())) {
    const guarded = bucket.length <= MIN_PROTECTED_ENCRYPTED_BACKUPS
      ? bucket
      : bucket.slice(0, MIN_PROTECTED_ENCRYPTED_BACKUPS);
    for (const row of guarded) protectedNames.add(row.name);
  }
  for (const row of rows) {
    row.protectedRecent = protectedNames.has(row.name);
  }

  let latestAttempt: Attempt | null = null;
  let latestOffsite: { name: string; at: string } | null = null;
  let latestRestore: { name: string; at: string } | null = null;
  for (const row of rows) {
    if (row.attempt && (!latestAttempt || isNewerTimestamp(row.attempt.startedAt, latestAttempt.startedAt))) latestAttempt = row.attempt;
    if (row.offsite.at && (!latestOffsite || isNewerTimestamp(row.offsite.at, latestOffsite.at))) latestOffsite = { name: row.name, at: row.offsite.at };
    if (row.restoredAt && (!latestRestore || isNewerTimestamp(row.restoredAt, latestRestore.at))) latestRestore = { name: row.name, at: row.restoredAt };
  }

  if (reportNames.has("latest-verified-restore.json")) {
    const summaryFile = path.join(reportDirectory, "latest-verified-restore.json");
    const parsedSummary = latestRestoreSummarySchema.safeParse(
      await smallJson(summaryFile, await ordinaryFile(summaryFile)),
    );
    if (parsedSummary.success) {
      const summaryCandidates = [
        { name: parsedSummary.data.name, at: parsedSummary.data.at },
        ...Object.values(parsedSummary.data.byDatabase ?? {}),
      ];
      for (const candidate of summaryCandidates) {
        if (
          isBackupSqlName(candidate.name) &&
          matchesBackupPrefix(candidate.name, prefix) &&
          (!latestRestore || isNewerTimestamp(candidate.at, latestRestore.at))
        ) {
          latestRestore = { name: candidate.name, at: candidate.at };
        }
      }
    }
  }

  let visibleRows = rows;
  if (limit !== null) {
    let bareFailedSeen = 0;
    visibleRows = [];
    for (const row of rows) {
      const isBareFailed =
        !row.sqlAvailable &&
        row.encryption.status === "MISSING" &&
        row.offsite.status === "MISSING" &&
        row.attempt?.status === "FAILED";
      if (isBareFailed) {
        if (bareFailedSeen >= MAX_BARE_FAILED_ROWS_IN_SLICE) continue;
        bareFailedSeen += 1;
      }
      visibleRows.push(row);
      if (visibleRows.length >= limit) break;
    }
  }

  return { backups: visibleRows, encryptedCount, latestAttempt, latestOffsite, latestRestore };
}
