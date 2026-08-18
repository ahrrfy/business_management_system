import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  R2_GC_DELETE_CONFIRMATION,
  evaluateStagingRetention,
  loadR2GcDeletionAuthorization,
  resolveR2GcMode,
} from "../r2RetentionPolicy";

const DAY_MS = 24 * 60 * 60_000;
const NOW = new Date("2026-08-18T12:00:00.000Z");
const OBJECT_BYTES = Buffer.from("restored-from-independent-cold-mirror");
const HASH = createHash("sha256").update(OBJECT_BYTES).digest("hex");
const KEY = `single/studio/candidate/${HASH.slice(0, 2)}/${HASH}.png`;
const SOURCE_SCOPE_SHA256 = "c".repeat(64);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function manifest(
  completedAt = new Date(NOW.getTime() - DAY_MS).toISOString(),
  objectKey = KEY,
  sourcePrefix = "single/studio/",
) {
  return {
    format: "alroya-r2-cold-mirror/v1",
    completedAt,
    sourcePrefix,
    sourceScopeSha256: SOURCE_SCOPE_SHA256,
    entries: {
      [objectKey]: {
        sha256: HASH,
        bytes: OBJECT_BYTES.length,
        sourcePresent: true,
        lastSeenAt: completedAt,
        verifiedAt: completedAt,
      },
    },
  };
}

async function deletionEnvironment(options: {
  value?: ReturnType<typeof manifest>;
  receiptCompletedAt?: string;
  restoredBytes?: Buffer;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "r2-gc-proof-"));
  temporaryDirectories.push(dir);
  const mirrorDir = join(dir, "cold-mirror");
  const restoreDir = join(dir, "independent-restore-target");
  await Promise.all([mkdir(mirrorDir), mkdir(restoreDir)]);
  const value = options.value ?? manifest();
  const manifestPath = join(mirrorDir, "manifest.json");
  const manifestBytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  await writeFile(manifestPath, manifestBytes);

  const [objectKey, entry] = Object.entries(value.entries)[0]!;
  const relativePath = join("objects", ...objectKey.split("/"));
  const restoredPath = join(restoreDir, relativePath);
  await mkdir(dirname(restoredPath), { recursive: true });
  await writeFile(restoredPath, options.restoredBytes ?? OBJECT_BYTES);
  const receipt = {
    format: "alroya-r2-restore-drill/v1",
    completedAt: options.receiptCompletedAt ?? new Date(NOW.getTime() - 60 * 60_000).toISOString(),
    manifestSha256,
    sourcePrefix: value.sourcePrefix,
    sourceScopeSha256: value.sourceScopeSha256,
    destination: {
      format: "alroya-r2-restore-destination/v1",
      drillId: "11111111-1111-4111-8111-111111111111",
      entries: [{
        key: objectKey,
        relativePath: relativePath.replaceAll("\\", "/"),
        sha256: entry.sha256,
        bytes: entry.bytes,
      }],
    },
  };
  const receiptPath = join(restoreDir, "receipt.json");
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
  await writeFile(receiptPath, receiptBytes);
  return {
    R2_GC_MODE: "delete",
    R2_GC_DELETE_CONFIRM: R2_GC_DELETE_CONFIRMATION,
    R2_GC_MIRROR_MANIFEST: manifestPath,
    R2_GC_MIRROR_MANIFEST_SHA256: manifestSha256,
    R2_GC_DR_RECEIPT: receiptPath,
    R2_GC_DR_RECEIPT_SHA256: createHash("sha256").update(receiptBytes).digest("hex"),
  };
}

describe("R2 retention policy", () => {
  it("يجعل GC تدقيقياً افتراضياً ولا يقبل delete بلا إقرار مطابق", () => {
    expect(resolveR2GcMode({})).toBe("audit");
    expect(resolveR2GcMode({ R2_GC_MODE: "audit" })).toBe("audit");
    expect(() => resolveR2GcMode({ R2_GC_MODE: "delete" })).toThrow(/R2_GC_DELETE_CONFIRM_REQUIRED/);
    expect(resolveR2GcMode({
      R2_GC_MODE: "delete",
      R2_GC_DELETE_CONFIRM: R2_GC_DELETE_CONFIRMATION,
    })).toBe("delete");
  });

  it("يبدأ احتفاظ 90 يوماً من أول إثبات لفقد آخر مرجع", () => {
    const old = new Date(NOW.getTime() - 120 * DAY_MS);
    expect(evaluateStagingRetention({
      state: "REFERENCED", touchedAt: old, referencedAt: old, hasReference: false, now: NOW, deleteRequested: true,
    })).toEqual({ action: "MARK_UNREFERENCED", retentionStartedAt: NOW });
    expect(evaluateStagingRetention({
      state: "PENDING", touchedAt: old, referencedAt: new Date(NOW.getTime() - 89 * DAY_MS),
      hasReference: false, now: NOW, deleteRequested: true,
    }).action).toBe("DEFER");
    expect(evaluateStagingRetention({
      state: "PENDING", touchedAt: old, referencedAt: new Date(NOW.getTime() - 91 * DAY_MS),
      hasReference: false, now: NOW, deleteRequested: false,
    }).action).toBe("AUDIT_ELIGIBLE");
  });

  it("لا يجيز الحذف إلا بعد إيصال تمرين استعادة حقيقي مرتبط بالـmanifest وملفات وجهة سليمة", async () => {
    const authorization = await loadR2GcDeletionAuthorization(await deletionEnvironment(), NOW, "single/studio/");
    expect(() => authorization.authorize(KEY)).not.toThrow();
    expect(() => authorization.authorize(`single/studio/candidate/bb/${"b".repeat(64)}.png`))
      .toThrow(/R2_GC_MIRROR_OBJECT_UNPROVEN/);

    await expect(loadR2GcDeletionAuthorization({
      ...await deletionEnvironment(),
      R2_GC_DR_RECEIPT: undefined,
      R2_GC_DR_RECEIPT_SHA256: undefined,
      R2_GC_DR_VERIFIED_AT: new Date(NOW.getTime() - DAY_MS).toISOString(),
    }, NOW, "single/studio/")).rejects.toThrow(/R2_GC_DR_RECEIPT_REQUIRED/);
  });

  it("يربط التفويض بنطاق Studio المشتق للشركة ولا يقبل manifest من نطاق آخر", async () => {
    const companyKey = `company-42/studio/candidate/${HASH.slice(0, 2)}/${HASH}.png`;
    const authorization = await loadR2GcDeletionAuthorization(
      await deletionEnvironment({ value: manifest(undefined, companyKey, "company-") }),
      NOW,
      "company-42/studio/",
    );
    expect(() => authorization.authorize(companyKey)).not.toThrow();
    expect(() => authorization.authorize(KEY)).toThrow(/R2_GC_OBJECT_TENANT_SCOPE_MISMATCH/);
    await expect(loadR2GcDeletionAuthorization(await deletionEnvironment(), NOW, "company-42/studio/"))
      .rejects.toThrow(/R2_GC_MIRROR_TENANT_SCOPE_MISMATCH/);
  });

  it("يفشل مغلقاً عند بصمة/مرآة/إيصال متقادم أو عند تلف ملفات وجهة الاستعادة", async () => {
    await expect(loadR2GcDeletionAuthorization({
      ...await deletionEnvironment(), R2_GC_MIRROR_MANIFEST_SHA256: "b".repeat(64),
    }, NOW, "single/studio/")).rejects.toThrow(/R2_GC_MIRROR_MANIFEST_DIGEST_MISMATCH/);
    await expect(loadR2GcDeletionAuthorization(
      await deletionEnvironment({ value: manifest(new Date(NOW.getTime() - 8 * DAY_MS).toISOString()) }),
      NOW, "single/studio/",
    )).rejects.toThrow(/R2_GC_MIRROR_PROOF_STALE/);
    await expect(loadR2GcDeletionAuthorization(
      await deletionEnvironment({ receiptCompletedAt: new Date(NOW.getTime() - 91 * DAY_MS).toISOString() }),
      NOW, "single/studio/",
    )).rejects.toThrow(/R2_GC_DR_PROOF_STALE/);
    await expect(loadR2GcDeletionAuthorization(
      await deletionEnvironment({ restoredBytes: Buffer.from("tampered-restore") }),
      NOW, "single/studio/",
    )).rejects.toThrow(/R2_GC_DR_DESTINATION_PROOF_INVALID/);
  });
});
