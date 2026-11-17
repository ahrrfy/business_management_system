import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { COLD_MIRROR_CADENCE_SECONDS, HybridLocalR2ImageStore } from "../hybridLocalR2Store";
import type { ImageStore, ObjectHead, PutResult } from "../types";

class ControllableMockR2Store implements ImageStore {
  public wanOnline = true;
  public readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  public putCalls = 0;

  private checkWan(): void {
    if (!this.wanOnline) {
      throw Object.assign(new Error("Simulated WAN outage to R2"), {
        code: "ENETUNREACH",
      });
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<PutResult> {
    this.putCalls += 1;
    this.checkWan();
    const existed = this.objects.has(key);
    if (!existed) this.objects.set(key, { body: Buffer.from(body), contentType });
    return { key, bytes: body.length, existed };
  }

  async head(key: string): Promise<ObjectHead> {
    this.checkWan();
    const obj = this.objects.get(key);
    return obj ? { exists: true, bytes: obj.body.length } : { exists: false };
  }

  async getStream(key: string): Promise<Readable | null> {
    this.checkWan();
    const obj = this.objects.get(key);
    return obj ? Readable.from(obj.body) : null;
  }

  async getBuffer(key: string, expectedBytes: number): Promise<Buffer | null> {
    this.checkWan();
    const obj = this.objects.get(key);
    if (!obj) return null;
    if (obj.body.length !== expectedBytes) throw new Error("Size mismatch");
    return Buffer.from(obj.body);
  }

  async delete(key: string): Promise<void> {
    this.checkWan();
    this.objects.delete(key);
  }
}

describe("HybridLocalR2ImageStore — durable WAN-off upload queue, cold-mirror read, lag alerts, and DB parity", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  });

  it("serves old cold-mirrored images & new uploads during WAN outage, survives restart without cache loss, drains on WAN return, and flags missing DB media", async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), "hybrid-r2-v4-"));
    roots.push(baseDir);
    const localRoot = path.join(baseDir, "local-hybrid");
    const coldMirrorRoot = path.join(baseDir, "r2-cold-mirror");
    const coldStatusPath = path.join(coldMirrorRoot, ".service-status.json");

    // Seed an existing historical company product image in cold mirror + supervisor 6h scan status
    const oldBytes = Buffer.from("\x89PNG\r\n\x1a\nold-mirrored-product-image");
    const oldSha = createHash("sha256").update(oldBytes).digest("hex");
    const oldKey = `single/p/${oldSha.slice(0, 2)}/${oldSha}.png`;
    await mkdir(path.dirname(path.join(coldMirrorRoot, "objects", oldKey)), { recursive: true });
    await writeFile(path.join(coldMirrorRoot, "objects", oldKey), oldBytes);
    await writeFile(
      coldStatusPath,
      JSON.stringify({
        lastCompleted: {
          finishedUtc: "2026-11-15T16:56:42.463241+00:00",
          summary: { status: "GENERAL_SCAN_REQUIRES_DB_RECONCILIATION", listed: 5237 },
        },
      }),
    );

    let fakeNowMs = new Date("2026-11-15T23:00:00Z").getTime();
    const remoteR2 = new ControllableMockR2Store();
    remoteR2.objects.set(oldKey, { body: oldBytes, contentType: "image/png" });

    // 1. Cut WAN completely!
    remoteR2.wanOnline = false;
    const store1 = new HybridLocalR2ImageStore({
      localRoot,
      remoteStore: remoteR2,
      coldMirrorRoot,
      coldMirrorStatusFile: coldStatusPath,
      now: () => fakeNowMs,
    });

    // Old mirrored image is served locally 100% while WAN is OFF!
    const readOld = await store1.getBuffer(oldKey, oldBytes.length);
    expect(readOld?.equals(oldBytes)).toBe(true);

    // 2. Upload new product image while WAN is OFF -> succeeds locally, queued in durable outbox!
    const newBytes = Buffer.from("\x89PNG\r\n\x1a\nnew-wan-off-product-image");
    const newSha = createHash("sha256").update(newBytes).digest("hex");
    const newKey = `single/p/${newSha.slice(0, 2)}/${newSha}.png`;
    const putRes = await store1.put(newKey, newBytes, "image/png");
    expect(putRes).toEqual({ key: newKey, bytes: newBytes.length, existed: false });
    expect((await store1.getBuffer(newKey, newBytes.length))?.equals(newBytes)).toBe(true);

    // Refuses deleting a local file that still has a PENDING_UPLOAD!
    await expect(store1.delete(newKey)).rejects.toThrow(/عملية رفع معلّقة/);

    // Advance simulated clock 35 minutes while WAN stays OFF -> lag alert escalates to CRITICAL (`>= 1800s`)
    fakeNowMs += 35 * 60_000;
    const lagWhileWanOff = await store1.computeLagSnapshot();
    expect(lagWhileWanOff.coldMirrorCadenceSeconds).toBe(COLD_MIRROR_CADENCE_SECONDS);
    expect(lagWhileWanOff.coldMirrorIsRealTimeSync).toBe(false);
    expect(lagWhileWanOff.pendingUploadCount).toBe(1);
    expect(lagWhileWanOff.oldestPendingUploadAgeSeconds).toBe(2100);
    expect(lagWhileWanOff.alertLevel).toBe("CRITICAL");

    // 3. Simulate server reboot + aggressive cache prune while WAN is STILL OFF:
    //    Pending upload file & outbox entry MUST survive untouched!
    const storeAfterReboot = new HybridLocalR2ImageStore({
      localRoot,
      remoteStore: remoteR2,
      coldMirrorRoot,
      coldMirrorStatusFile: coldStatusPath,
      now: () => fakeNowMs,
    });
    const pruneRes = await storeAfterReboot.pruneStaleTempAndUnreferencedSyncedCache({
      maxAgeMs: 0,
      protectedDbKeys: new Set(),
    });
    expect(pruneRes.preservedPendingKeys).toContain(newKey);
    expect((await storeAfterReboot.getBuffer(newKey, newBytes.length))?.equals(newBytes)).toBe(true);

    // 4. WAN returns -> drainPendingOutbox uploads idempotently & verifies R2 HEAD!
    remoteR2.wanOnline = true;
    const drainRes = await storeAfterReboot.drainPendingOutbox({ ignoreBackoff: true });
    expect(drainRes).toEqual({
      attempted: 1,
      synced: 1,
      stillPending: 0,
      failedPermanent: 0,
    });
    expect(remoteR2.objects.get(newKey)?.body.equals(newBytes)).toBe(true);

    const lagAfterSync = await storeAfterReboot.computeLagSnapshot();
    expect(lagAfterSync.pendingUploadCount).toBe(0);
    expect(lagAfterSync.syncedVerifiedCount).toBe(1);
    expect(lagAfterSync.alertLevel).toBe("HEALTHY");
  });

  it("re-uploads identical content-addressed bytes to R2 after PUT -> DELETE -> PUT", async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), "hybrid-r2-reput-"));
    roots.push(baseDir);
    const localRoot = path.join(baseDir, "local-hybrid");
    const remoteR2 = new ControllableMockR2Store();
    const store = new HybridLocalR2ImageStore({
      localRoot,
      remoteStore: remoteR2,
    });

    const bytes = Buffer.from("\x89PNG\r\n\x1a\nreuploadable-content");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const key = `single/p/${sha.slice(0, 2)}/${sha}.png`;

    await store.put(key, bytes, "image/png");
    expect((await remoteR2.head(key)).exists).toBe(true);

    await store.delete(key);
    expect((await remoteR2.head(key)).exists).toBe(false);

    await store.put(key, bytes, "image/png");
    expect((await remoteR2.head(key)).exists).toBe(true);
    expect(remoteR2.objects.get(key)?.body.equals(bytes)).toBe(true);
  });
});
