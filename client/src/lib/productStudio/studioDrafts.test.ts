import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { decryptJsonWithKey, encryptJsonWithKey } from "@/lib/offline/crypto";
import {
  createStudioDraftStore,
  type StudioDraftPersistence,
  type StudioDraftRecord,
} from "./studioDrafts";

function memoryPersistence(): StudioDraftPersistence & {
  rows: Map<string, StudioDraftRecord>;
} {
  const rows = new Map<string, StudioDraftRecord>();
  return {
    rows,
    get: async (id) => rows.get(id),
    put: async (row) => {
      rows.set(row.id, row);
    },
    delete: async (id) => {
      rows.delete(id);
    },
    entries: async () => [...rows.values()],
  };
}

async function makeStore(now = 1_000) {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const persistence = memoryPersistence();
  return {
    persistence,
    store: createStudioDraftStore({
      persistence,
      now: () => now,
      encrypt: (value) => encryptJsonWithKey(value, key),
      decrypt: (envelope) => decryptJsonWithKey(envelope, key),
    }),
  };
}

const input = {
  userId: 7,
  taskId: 41,
  revision: "2026-08-19T10:00:00.000Z",
  proposedName: "قلم أزرق",
  proposedDescription: "وصف خاص للمنتج",
  proposedMarketingCopy: "نسخة تسويقية",
  imageDataUrl: "data:image/webp;base64,secret-image-bytes",
  mode: "CUT" as const,
};

describe("encrypted studio drafts", () => {
  it("stores all editable content only inside a device-encrypted envelope", async () => {
    const { persistence, store } = await makeStore();

    await store.save(input);

    const row = persistence.rows.get("7:41");
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain(input.proposedDescription);
    expect(JSON.stringify(row)).not.toContain(input.imageDataUrl);
    expect(await store.load(7, 41)).toMatchObject(input);
  });

  it("never restores another authenticated employee's draft", async () => {
    const { store } = await makeStore();
    await store.save(input);

    expect(await store.load(8, 41)).toBeNull();
    expect(await store.load(7, 41)).toMatchObject({ userId: 7, taskId: 41 });
  });

  it("purges a draft after its 24-hour lifetime", async () => {
    const { store } = await makeStore();
    await store.save(input);

    expect(
      await store.load(7, 41, 1_000 + 24 * 60 * 60 * 1_000 - 1),
    ).not.toBeNull();
    expect(await store.load(7, 41, 1_000 + 24 * 60 * 60 * 1_000)).toBeNull();
  });

  it("purges the local draft after a successful submission", async () => {
    const { store } = await makeStore();
    await store.save(input);

    await store.purge(input.userId, input.taskId);

    expect(await store.load(input.userId, input.taskId)).toBeNull();
  });

  it("purges all local studio drafts at a logout or session boundary", async () => {
    const { store } = await makeStore();
    await store.save(input);
    await store.save({ ...input, userId: 8, taskId: 42 });

    await store.purgeAll();

    expect(await store.load(7, 41)).toBeNull();
    expect(await store.load(8, 42)).toBeNull();
  });

  it("retains a conflicting draft after reconnect instead of resuming it", async () => {
    const { store } = await makeStore();
    await store.save(input);

    const result = await store.reconcileAndClaimResume({
      userId: input.userId,
      taskId: input.taskId,
      revision: "2026-08-19T10:01:00.000Z",
      editable: true,
    });

    expect(result.kind).toBe("CONFLICT");
    expect(await store.load(input.userId, input.taskId)).toMatchObject(input);
  });

  it("resumes a matching editable draft exactly once after reconnect", async () => {
    const { store } = await makeStore();
    await store.save(input);
    const context = {
      userId: input.userId,
      taskId: input.taskId,
      revision: input.revision,
      editable: true,
    };

    expect((await store.reconcileAndClaimResume(context)).kind).toBe("RESUME");
    expect((await store.reconcileAndClaimResume(context)).kind).toBe(
      "ALREADY_RESUMED",
    );
  });
});

describe("product image studio draft boundary", () => {
  it("autosaves locally and revalidates a restored draft without an offline mutation", () => {
    const page = readFileSync(
      new URL("../../pages/ProductImageStudio.tsx", import.meta.url),
      "utf8",
    );

    expect(page).toContain("saveStudioDraft({");
    expect(page).toContain("reconcileStudioDraftAfterReconnect");
    expect(page).toContain("purgeStudioDraft(");
    expect(page).toContain("navigator.onLine");
    expect(page).toContain("offline={offline}");
    const uploader = readFileSync(
      new URL(
        "../../components/product/ImageStudioUploader.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(uploader).toMatch(/const proAvailable =\s*!offline/);
    expect(uploader).toMatch(/const aiAvailable =\s*!offline/);
  });
});
