import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const DAY_MS = 24 * 60 * 60_000;
const MIN_RETENTION_MS = 90 * DAY_MS;
const MAX_MIRROR_PROOF_AGE_MS = 7 * DAY_MS;
const MAX_DR_PROOF_AGE_MS = 90 * DAY_MS;
const MAX_MANIFEST_BYTES = 50 * 1024 * 1024;
const MAX_DR_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_DR_RESTORED_OBJECT_BYTES = 25 * 1024 * 1024;
const MAX_DR_RESTORED_OBJECTS = 100;
const MANIFEST_FORMAT = "alroya-r2-cold-mirror/v1";
const DR_RECEIPT_FORMAT = "alroya-r2-restore-drill/v1";
const DR_DESTINATION_FORMAT = "alroya-r2-restore-destination/v1";

export const R2_GC_DELETE_CONFIRMATION = "DELETE_RETAINED_R2_OBJECTS";

type StagingState = "PENDING" | "REFERENCED";
type StagingDecision =
  | { action: "MARK_REFERENCED" }
  | { action: "MARK_UNREFERENCED"; retentionStartedAt: Date }
  | { action: "DEFER"; retentionStartedAt: Date }
  | { action: "AUDIT_ELIGIBLE"; retentionStartedAt: Date }
  | { action: "DELETE_ELIGIBLE"; retentionStartedAt: Date };

export class R2RetentionPolicyError extends Error {
  readonly code: string;

  constructor(code: string, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "R2RetentionPolicyError";
    this.code = code;
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseEvidenceDate(value: unknown, code: string, now: Date, maximumAgeMs: number): Date {
  if (typeof value !== "string") throw new R2RetentionPolicyError(code);
  const parsed = new Date(value);
  const age = now.getTime() - parsed.getTime();
  if (!Number.isFinite(parsed.getTime()) || age < 0 || age > maximumAgeMs) {
    throw new R2RetentionPolicyError(code);
  }
  return parsed;
}

function hashFromObjectKey(key: string): string | null {
  const match = /\/([0-9a-f]{64})\.[a-z0-9]{2,5}$/i.exec(key);
  return match?.[1]?.toLowerCase() ?? null;
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function assertTenantStudioPrefix(value: string): void {
  if (value !== "single/studio/" && !/^company-[1-9][0-9]*\/studio\/$/.test(value)) {
    throw new R2RetentionPolicyError("R2_GC_TENANT_SCOPE_INVALID");
  }
}

function manifestCoversTenant(sourcePrefix: unknown, tenantStudioPrefix: string): sourcePrefix is string {
  if (tenantStudioPrefix === "single/studio/") return sourcePrefix === tenantStudioPrefix;
  return sourcePrefix === tenantStudioPrefix || sourcePrefix === "company-";
}

function pathContains(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

async function assertNoSymlinkComponents(root: string, destination: string): Promise<void> {
  const relation = relative(root, destination);
  if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
    throw new R2RetentionPolicyError("R2_GC_DR_DESTINATION_PROOF_INVALID");
  }
  let current = root;
  for (const segment of relation.split(/[\\/]/)) {
    current = resolve(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      throw new R2RetentionPolicyError("R2_GC_DR_DESTINATION_PROOF_INVALID", error);
    }
    if (info.isSymbolicLink()) {
      throw new R2RetentionPolicyError("R2_GC_DR_DESTINATION_PROOF_INVALID");
    }
  }
}

export function resolveR2GcMode(env: NodeJS.ProcessEnv): "audit" | "delete" {
  const mode = env.R2_GC_MODE?.trim().toLowerCase() || "audit";
  if (mode === "audit") return "audit";
  if (mode !== "delete") throw new R2RetentionPolicyError("R2_GC_MODE_INVALID");
  if (env.R2_GC_DELETE_CONFIRM !== R2_GC_DELETE_CONFIRMATION) {
    throw new R2RetentionPolicyError("R2_GC_DELETE_CONFIRM_REQUIRED");
  }
  return "delete";
}

export function evaluateStagingRetention(input: {
  state: StagingState;
  touchedAt: Date;
  referencedAt: Date | null;
  hasReference: boolean;
  now: Date;
  deleteRequested: boolean;
}): StagingDecision {
  if (input.hasReference) return { action: "MARK_REFERENCED" };
  if (input.state === "REFERENCED") {
    return { action: "MARK_UNREFERENCED", retentionStartedAt: input.now };
  }
  const retentionStartedAt = input.referencedAt ?? input.touchedAt;
  const ageMs = input.now.getTime() - retentionStartedAt.getTime();
  if (!Number.isFinite(ageMs) || ageMs < MIN_RETENTION_MS) {
    return { action: "DEFER", retentionStartedAt };
  }
  return input.deleteRequested
    ? { action: "DELETE_ELIGIBLE", retentionStartedAt }
    : { action: "AUDIT_ELIGIBLE", retentionStartedAt };
}

export async function loadR2GcDeletionAuthorization(
  env: NodeJS.ProcessEnv,
  now = new Date(),
  tenantStudioPrefix: string,
): Promise<{ authorize(objectKey: string): void }> {
  if (resolveR2GcMode(env) !== "delete") throw new R2RetentionPolicyError("R2_GC_DELETE_MODE_REQUIRED");
  assertTenantStudioPrefix(tenantStudioPrefix);
  const manifestPath = env.R2_GC_MIRROR_MANIFEST?.trim();
  const expectedDigest = env.R2_GC_MIRROR_MANIFEST_SHA256?.trim().toLowerCase();
  if (!manifestPath || !isAbsolute(manifestPath)) {
    throw new R2RetentionPolicyError("R2_GC_MIRROR_MANIFEST_REQUIRED");
  }
  if (!expectedDigest || !/^[0-9a-f]{64}$/.test(expectedDigest)) {
    throw new R2RetentionPolicyError("R2_GC_MIRROR_MANIFEST_DIGEST_REQUIRED");
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(manifestPath);
  } catch (error) {
    throw new R2RetentionPolicyError("R2_GC_MIRROR_MANIFEST_UNREADABLE", error);
  }
  if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
    throw new R2RetentionPolicyError("R2_GC_MIRROR_MANIFEST_INVALID");
  }
  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  if (actualDigest !== expectedDigest) {
    throw new R2RetentionPolicyError("R2_GC_MIRROR_MANIFEST_DIGEST_MISMATCH");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new R2RetentionPolicyError("R2_GC_MIRROR_MANIFEST_INVALID", error);
  }
  if (!plainObject(parsed) || parsed.format !== MANIFEST_FORMAT || !plainObject(parsed.entries)) {
    throw new R2RetentionPolicyError("R2_GC_MIRROR_MANIFEST_INVALID");
  }
  const manifestCompletedAt = parseEvidenceDate(
    parsed.completedAt,
    "R2_GC_MIRROR_PROOF_STALE",
    now,
    MAX_MIRROR_PROOF_AGE_MS,
  );
  if (!manifestCoversTenant(parsed.sourcePrefix, tenantStudioPrefix)) {
    throw new R2RetentionPolicyError("R2_GC_MIRROR_TENANT_SCOPE_MISMATCH");
  }
  if (!validSha256(parsed.sourceScopeSha256)) {
    throw new R2RetentionPolicyError("R2_GC_MIRROR_MANIFEST_INVALID");
  }
  const entries = parsed.entries;

  const receiptPath = env.R2_GC_DR_RECEIPT?.trim();
  const expectedReceiptDigest = env.R2_GC_DR_RECEIPT_SHA256?.trim().toLowerCase();
  if (!receiptPath || !isAbsolute(receiptPath)) {
    throw new R2RetentionPolicyError("R2_GC_DR_RECEIPT_REQUIRED");
  }
  if (!expectedReceiptDigest || !validSha256(expectedReceiptDigest)) {
    throw new R2RetentionPolicyError("R2_GC_DR_RECEIPT_DIGEST_REQUIRED");
  }
  let receiptBytes: Buffer;
  try {
    receiptBytes = await readFile(receiptPath);
  } catch (error) {
    throw new R2RetentionPolicyError("R2_GC_DR_RECEIPT_UNREADABLE", error);
  }
  if (receiptBytes.length === 0 || receiptBytes.length > MAX_DR_RECEIPT_BYTES) {
    throw new R2RetentionPolicyError("R2_GC_DR_RECEIPT_INVALID");
  }
  if (createHash("sha256").update(receiptBytes).digest("hex") !== expectedReceiptDigest) {
    throw new R2RetentionPolicyError("R2_GC_DR_RECEIPT_DIGEST_MISMATCH");
  }
  let receipt: unknown;
  try {
    receipt = JSON.parse(receiptBytes.toString("utf8"));
  } catch (error) {
    throw new R2RetentionPolicyError("R2_GC_DR_RECEIPT_INVALID", error);
  }
  if (!plainObject(receipt) || receipt.format !== DR_RECEIPT_FORMAT || receipt.manifestSha256 !== expectedDigest ||
      receipt.sourcePrefix !== parsed.sourcePrefix || receipt.sourceScopeSha256 !== parsed.sourceScopeSha256 ||
      !plainObject(receipt.destination) || receipt.destination.format !== DR_DESTINATION_FORMAT ||
      typeof receipt.destination.drillId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receipt.destination.drillId) ||
      !Array.isArray(receipt.destination.entries) || receipt.destination.entries.length === 0 ||
      receipt.destination.entries.length > MAX_DR_RESTORED_OBJECTS) {
    throw new R2RetentionPolicyError("R2_GC_DR_RECEIPT_INVALID");
  }
  const receiptCompletedAt = parseEvidenceDate(
    receipt.completedAt,
    "R2_GC_DR_PROOF_STALE",
    now,
    MAX_DR_PROOF_AGE_MS,
  );
  if (receiptCompletedAt < manifestCompletedAt) {
    throw new R2RetentionPolicyError("R2_GC_DR_RECEIPT_MANIFEST_MISMATCH");
  }

  let manifestRoot: string;
  let restoreRoot: string;
  try {
    [manifestRoot, restoreRoot] = await Promise.all([
      realpath(dirname(manifestPath)),
      realpath(dirname(receiptPath)),
    ]);
  } catch (error) {
    throw new R2RetentionPolicyError("R2_GC_DR_DESTINATION_PROOF_INVALID", error);
  }
  if (pathContains(manifestRoot, restoreRoot) || pathContains(restoreRoot, manifestRoot)) {
    throw new R2RetentionPolicyError("R2_GC_DR_DESTINATION_NOT_INDEPENDENT");
  }

  const restoredKeys = new Set<string>();
  for (const restored of receipt.destination.entries) {
    if (!plainObject(restored) || typeof restored.key !== "string" || typeof restored.relativePath !== "string" ||
        !validSha256(restored.sha256) || !Number.isSafeInteger(restored.bytes) || Number(restored.bytes) <= 0 ||
        Number(restored.bytes) > MAX_DR_RESTORED_OBJECT_BYTES || restoredKeys.has(restored.key)) {
      throw new R2RetentionPolicyError("R2_GC_DR_DESTINATION_PROOF_INVALID");
    }
    restoredKeys.add(restored.key);
    const manifestEntry = entries[restored.key];
    const expectedRelativePath = `objects/${restored.key}`;
    if (!plainObject(manifestEntry) || restored.relativePath !== expectedRelativePath ||
        manifestEntry.sha256 !== restored.sha256 || manifestEntry.bytes !== restored.bytes) {
      throw new R2RetentionPolicyError("R2_GC_DR_DESTINATION_PROOF_INVALID");
    }
    const destinationPath = resolve(restoreRoot, ...expectedRelativePath.split("/"));
    await assertNoSymlinkComponents(restoreRoot, destinationPath);
    let destinationBytes: Buffer;
    try {
      const info = await stat(destinationPath);
      if (!info.isFile() || info.size !== restored.bytes) {
        throw new R2RetentionPolicyError("R2_GC_DR_DESTINATION_PROOF_INVALID");
      }
      destinationBytes = await readFile(destinationPath);
    } catch (error) {
      if (error instanceof R2RetentionPolicyError) throw error;
      throw new R2RetentionPolicyError("R2_GC_DR_DESTINATION_PROOF_INVALID", error);
    }
    if (createHash("sha256").update(destinationBytes).digest("hex") !== restored.sha256) {
      throw new R2RetentionPolicyError("R2_GC_DR_DESTINATION_PROOF_INVALID");
    }
  }

  return {
    authorize(objectKey: string) {
      if (!objectKey.startsWith(tenantStudioPrefix)) {
        throw new R2RetentionPolicyError("R2_GC_OBJECT_TENANT_SCOPE_MISMATCH");
      }
      const expectedObjectHash = hashFromObjectKey(objectKey);
      const entry = entries[objectKey];
      if (!expectedObjectHash || !plainObject(entry) || entry.sourcePresent !== true ||
          typeof entry.sha256 !== "string" || entry.sha256.toLowerCase() !== expectedObjectHash ||
          !Number.isSafeInteger(entry.bytes) || Number(entry.bytes) <= 0) {
        throw new R2RetentionPolicyError("R2_GC_MIRROR_OBJECT_UNPROVEN");
      }
      parseEvidenceDate(entry.verifiedAt, "R2_GC_MIRROR_OBJECT_UNPROVEN", now, MAX_MIRROR_PROOF_AGE_MS);
    },
  };
}
