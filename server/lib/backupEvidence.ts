import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const timestamp = z.string().datetime();
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
const restoreSchema = z.object({
  status: z.literal("SQL_RESTORED_CORE_READS_PASSED"),
  productionContact: z.literal(false),
  stopped: z.literal(true),
  finishedAt: timestamp,
  sourceBefore: fingerprint,
  sourceAfter: fingerprint,
  sqlFingerprint: fingerprint,
});

export function isBackupSqlName(name: string) {
  return /^[A-Za-z0-9_.$-]+\.sql$/.test(name) && !name.includes("..");
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

async function readRestoreDate(directory: string, name: string, manifest: Manifest) {
  const file = path.join(directory, `${name}.restore.json`);
  const report = restoreSchema.safeParse(await smallJson(file, await ordinaryFile(file)));
  if (!report.success) return null;
  const { sourceBefore, sourceAfter, sqlFingerprint, finishedAt } = report.data;
  if (!sameFile(sourceBefore, sourceAfter) || !sameFile(sqlFingerprint, manifest.source)) return null;
  return sameFile(sourceBefore, manifest) || sameFile(sourceBefore, manifest.source) ? finishedAt : null;
}

async function inspectBackup(
  name: string,
  directory: string,
  localNames: Set<string>,
  offsiteDirectory: string | null,
  offsiteNames: Set<string>,
  reportDirectory: string,
  reportNames: Set<string>,
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
  const restoredAt = manifest && reportNames.has(`${name}.restore.json`)
    ? await readRestoreDate(reportDirectory, name, manifest)
    : null;
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
    restoredAt,
  };
}

export async function inspectBackupReadiness(directory: string, offsitePath: string | undefined, prefix: string | null) {
  const reportDirectory = path.join(directory, "restore-reports");
  const [localNames, reportNames, localRealPath, externalRealPath] = await Promise.all([
    namesIn(directory),
    namesIn(reportDirectory),
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
    if (isBackupSqlName(base) && (!prefix || base.startsWith(prefix))) candidates.add(base);
  }

  const rows: NonNullable<Awaited<ReturnType<typeof inspectBackup>>>[] = [];
  const names = Array.from(candidates);
  for (let i = 0; i < names.length; i += 16) {
    const group = await Promise.all(names.slice(i, i + 16).map((name) =>
      inspectBackup(name, directory, localNames, offsiteDirectory, offsiteNames, reportDirectory, reportNames),
    ));
    for (const row of group) if (row) rows.push(row);
  }
  rows.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || b.name.localeCompare(a.name));

  let latestAttempt: Attempt | null = null;
  let latestOffsite: { name: string; at: string } | null = null;
  let latestRestore: { name: string; at: string } | null = null;
  for (const row of rows) {
    if (row.attempt && (!latestAttempt || row.attempt.startedAt > latestAttempt.startedAt)) latestAttempt = row.attempt;
    if (row.offsite.at && (!latestOffsite || row.offsite.at > latestOffsite.at)) latestOffsite = { name: row.name, at: row.offsite.at };
    if (row.restoredAt && (!latestRestore || row.restoredAt > latestRestore.at)) latestRestore = { name: row.name, at: row.restoredAt };
  }
  return { backups: rows.slice(0, 50), latestAttempt, latestOffsite, latestRestore };
}
