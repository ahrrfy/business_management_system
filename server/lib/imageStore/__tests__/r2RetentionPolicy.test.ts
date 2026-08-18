import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  R2_GC_DELETE_CONFIRMATION,
  evaluateStagingRetention,
  loadR2GcDeletionAuthorization,
  resolveR2GcMode,
} from "../r2RetentionPolicy";

const DAY_MS = 24 * 60 * 60_000;
const NOW = new Date("2026-08-18T12:00:00.000Z");
const HASH = "a".repeat(64);
const KEY = `single/studio/candidate/aa/${HASH}.png`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function manifest(completedAt = new Date(NOW.getTime() - DAY_MS).toISOString()) {
  return {
    format: "alroya-r2-cold-mirror/v1",
    completedAt,
    entries: {
      [KEY]: {
        sha256: HASH,
        bytes: 123,
        sourcePresent: true,
        lastSeenAt: completedAt,
        verifiedAt: completedAt,
      },
    },
  };
}

async function manifestEnvironment(value = manifest()) {
  const dir = await mkdtemp(join(tmpdir(), "r2-gc-proof-"));
  temporaryDirectories.push(dir);
  const path = join(dir, "manifest.json");
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  await writeFile(path, bytes);
  return {
    R2_GC_MODE: "delete",
    R2_GC_DELETE_CONFIRM: R2_GC_DELETE_CONFIRMATION,
    R2_GC_MIRROR_MANIFEST: path,
    R2_GC_MIRROR_MANIFEST_SHA256: createHash("sha256").update(bytes).digest("hex"),
    R2_GC_DR_VERIFIED_AT: new Date(NOW.getTime() - 10 * DAY_MS).toISOString(),
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
      state: "REFERENCED",
      touchedAt: old,
      referencedAt: old,
      hasReference: false,
      now: NOW,
      deleteRequested: true,
    })).toEqual({ action: "MARK_UNREFERENCED", retentionStartedAt: NOW });

    expect(evaluateStagingRetention({
      state: "PENDING",
      touchedAt: old,
      referencedAt: new Date(NOW.getTime() - 89 * DAY_MS),
      hasReference: false,
      now: NOW,
      deleteRequested: true,
    }).action).toBe("DEFER");

    expect(evaluateStagingRetention({
      state: "PENDING",
      touchedAt: old,
      referencedAt: new Date(NOW.getTime() - 91 * DAY_MS),
      hasReference: false,
      now: NOW,
      deleteRequested: false,
    }).action).toBe("AUDIT_ELIGIBLE");
  });

  it("لا يجيز الحذف بعد 90 يوماً إلا إذا طابق الكائن مرآة حديثة وتمرين DR حديثاً", async () => {
    const authorization = await loadR2GcDeletionAuthorization(await manifestEnvironment(), NOW);
    expect(() => authorization.authorize(KEY)).not.toThrow();
    expect(() => authorization.authorize(`single/studio/candidate/bb/${"b".repeat(64)}.png`))
      .toThrow(/R2_GC_MIRROR_OBJECT_UNPROVEN/);
  });

  it("يفشل مغلقاً عند بصمة manifest خاطئة أو مرآة/DR متقادمة", async () => {
    await expect(loadR2GcDeletionAuthorization({
      ...await manifestEnvironment(),
      R2_GC_MIRROR_MANIFEST_SHA256: "b".repeat(64),
    }, NOW)).rejects.toThrow(/R2_GC_MIRROR_MANIFEST_DIGEST_MISMATCH/);

    await expect(loadR2GcDeletionAuthorization(
      await manifestEnvironment(manifest(new Date(NOW.getTime() - 8 * DAY_MS).toISOString())),
      NOW,
    )).rejects.toThrow(/R2_GC_MIRROR_PROOF_STALE/);

    await expect(loadR2GcDeletionAuthorization({
      ...await manifestEnvironment(),
      R2_GC_DR_VERIFIED_AT: new Date(NOW.getTime() - 91 * DAY_MS).toISOString(),
    }, NOW)).rejects.toThrow(/R2_GC_DR_PROOF_STALE/);
  });
});
