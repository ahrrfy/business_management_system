import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

const DAY_MS = 24 * 60 * 60_000;
const MIN_RETENTION_MS = 90 * DAY_MS;
const MAX_MIRROR_PROOF_AGE_MS = 7 * DAY_MS;
const MAX_DR_PROOF_AGE_MS = 90 * DAY_MS;
const MAX_MANIFEST_BYTES = 50 * 1024 * 1024;
const MANIFEST_FORMAT = "alroya-r2-cold-mirror/v1";

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
): Promise<{ authorize(objectKey: string): void }> {
  if (resolveR2GcMode(env) !== "delete") throw new R2RetentionPolicyError("R2_GC_DELETE_MODE_REQUIRED");
  const manifestPath = env.R2_GC_MIRROR_MANIFEST?.trim();
  const expectedDigest = env.R2_GC_MIRROR_MANIFEST_SHA256?.trim().toLowerCase();
  if (!manifestPath || !isAbsolute(manifestPath)) {
    throw new R2RetentionPolicyError("R2_GC_MIRROR_MANIFEST_REQUIRED");
  }
  if (!expectedDigest || !/^[0-9a-f]{64}$/.test(expectedDigest)) {
    throw new R2RetentionPolicyError("R2_GC_MIRROR_MANIFEST_DIGEST_REQUIRED");
  }
  parseEvidenceDate(env.R2_GC_DR_VERIFIED_AT, "R2_GC_DR_PROOF_STALE", now, MAX_DR_PROOF_AGE_MS);

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
  parseEvidenceDate(parsed.completedAt, "R2_GC_MIRROR_PROOF_STALE", now, MAX_MIRROR_PROOF_AGE_MS);
  const entries = parsed.entries;

  return {
    authorize(objectKey: string) {
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
