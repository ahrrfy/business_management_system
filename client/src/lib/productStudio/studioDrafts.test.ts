import { describe, expect, it } from "vitest";
import { decryptJsonWithKey, encryptJsonWithKey } from "@/lib/offline/crypto";
import {
  createStudioDraftIdentityStore,
  createStudioDraftStore,
  STUDIO_DRAFT_RESUME_LEASE_MS,
  studioDraftWritesAllowed,
  type StudioDraftPersistence,
  type StudioDraftRecord,
} from "./studioDrafts";

it("يبقي التحرير والحفظ مغلقين حتى تملك الجلسة حق استئناف المسودة", () => {
  expect(studioDraftWritesAllowed({ kind: "NONE" })).toBe(true);
  expect(studioDraftWritesAllowed({ kind: "RESUME", draft: {} as never })).toBe(true);
  expect(studioDraftWritesAllowed({ kind: "ALREADY_RESUMED", draft: {} as never, retryAt: 2_000 })).toBe(false);
  expect(studioDraftWritesAllowed({ kind: "CONFLICT", draft: {} as never })).toBe(false);
});

function memoryPersistence(): StudioDraftPersistence & {
  rows: Map<string, StudioDraftRecord>;
} {
  const rows = new Map<string, StudioDraftRecord>();
  let transaction = Promise.resolve();
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
    readwrite: async (work) => {
      const next = transaction.then(work, work);
      transaction = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}

async function makeHarness(now = 1_000) {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const persistence = memoryPersistence();
  let clock = now;
  const create = () =>
    createStudioDraftStore({
      persistence,
      now: () => clock,
      // محاكاة فهرس HMAC: ثابت عبر إعادة التحميل ولا يحتوي userId/taskId كنص صريح.
      idFor: async (userId, taskId) =>
        `opaque-${(userId * 65_537 + taskId).toString(16)}`,
      encrypt: (value) => encryptJsonWithKey(value, key),
      decrypt: (envelope) => decryptJsonWithKey(envelope, key),
    });
  const identityRows = new Map<string, StudioDraftRecord>();
  const identityPersistence: StudioDraftPersistence = {
    get: async (id) => identityRows.get(id),
    put: async (row) => {
      identityRows.set(row.id, row);
    },
    delete: async (id) => {
      identityRows.delete(id);
    },
    entries: async () => [...identityRows.values()],
    readwrite: async (work) => work(),
  };
  const createIdentity = () =>
    createStudioDraftIdentityStore({
      persistence: identityPersistence,
      now: () => clock,
      encrypt: (value) => encryptJsonWithKey(value, key),
      decrypt: (envelope) => decryptJsonWithKey(envelope, key),
    });
  return {
    persistence,
    create,
    store: create(),
    createIdentity,
    advance: (ms: number) => {
      clock += ms;
    },
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
  originalDataUrl: "data:image/webp;base64,secret-original-bytes",
  processingReceipt: "fc1ee68b-7e4a-461b-8448-25f18a64f8b4",
  taskSnapshot: {
    taskId: 41,
    productName: "قلم أزرق",
    currentDescription: "الوصف قبل التعديل",
    status: "IN_PROGRESS" as const,
    hasOriginal: true,
    hasCandidate: false,
    updatedAt: "2026-08-19T10:00:00.000Z",
  },
  mode: "CUT" as const,
};

describe("encrypted studio drafts", () => {
  it("stores the full resumable state only inside an opaque encrypted record", async () => {
    const { persistence, store } = await makeHarness();
    await store.save(input);

    const row = [...persistence.rows.values()][0];
    expect(row).toBeDefined();
    expect(row?.id).not.toBe("7:41");
    expect(row?.id).not.toContain(":");
    expect(JSON.stringify(row)).not.toContain(input.proposedDescription);
    expect(JSON.stringify(row)).not.toContain(input.imageDataUrl);
    expect(JSON.stringify(row)).not.toContain(input.originalDataUrl);
    expect(JSON.stringify(row)).not.toContain(input.processingReceipt);
    expect(await store.load(7, 41)).toMatchObject(input);
  });

  it("never restores another authenticated employee's draft", async () => {
    const { store } = await makeHarness();
    await store.save(input);
    expect(await store.load(8, 41)).toBeNull();
    expect(await store.load(7, 41)).toMatchObject({ userId: 7, taskId: 41 });
  });

  it("purges a draft after its 24-hour lifetime", async () => {
    const { store } = await makeHarness();
    await store.save(input);
    expect(
      await store.load(7, 41, 1_000 + 24 * 60 * 60 * 1_000 - 1),
    ).not.toBeNull();
    expect(await store.load(7, 41, 1_000 + 24 * 60 * 60 * 1_000)).toBeNull();
  });

  it("purges the local draft after a successful submission", async () => {
    const { store } = await makeHarness();
    await store.save(input);
    await store.purge(input.userId, input.taskId);
    expect(await store.load(input.userId, input.taskId)).toBeNull();
  });

  it("purges all local studio drafts at a logout or session boundary", async () => {
    const { store } = await makeHarness();
    await store.save(input);
    await store.save({ ...input, userId: 8, taskId: 42 });
    await store.purgeAll();
    expect(await store.load(7, 41)).toBeNull();
    expect(await store.load(8, 42)).toBeNull();
  });

  it("retains a conflicting draft after reconnect instead of resuming it", async () => {
    const { store } = await makeHarness();
    await store.save(input);
    expect(
      (
        await store.reconcileAndClaimResume({
          userId: input.userId,
          taskId: input.taskId,
          taskFound: true,
          revision: "2026-08-19T10:01:00.000Z",
          editable: true,
        })
      ).kind,
    ).toBe("CONFLICT");
    expect(await store.load(input.userId, input.taskId)).toMatchObject(input);
  });

  it("holds a reload-safe resume lease only until its retry window expires", async () => {
    const { advance, create, store } = await makeHarness();
    await store.save(input);
    const context = {
      userId: input.userId,
      taskId: input.taskId,
      taskFound: true,
      revision: input.revision,
      editable: true,
    };
    expect((await store.reconcileAndClaimResume(context)).kind).toBe("RESUME");
    const blocked = await create().reconcileAndClaimResume(context);
    expect(blocked).toMatchObject({
      kind: "ALREADY_RESUMED",
      retryAt: 1_000 + STUDIO_DRAFT_RESUME_LEASE_MS,
    });
    advance(STUDIO_DRAFT_RESUME_LEASE_MS + 1);
    expect((await create().reconcileAndClaimResume(context)).kind).toBe(
      "RESUME",
    );
  });

  it("grants a resume lease to only one of two concurrent tabs", async () => {
    const { advance, create, store } = await makeHarness();
    await store.save(input);
    advance(STUDIO_DRAFT_RESUME_LEASE_MS + 1);
    const context = {
      userId: input.userId,
      taskId: input.taskId,
      taskFound: true,
      revision: input.revision,
      editable: true,
    };

    const outcomes = await Promise.all([
      create().reconcileAndClaimResume(context),
      create().reconcileAndClaimResume(context),
    ]);

    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual([
      "ALREADY_RESUMED",
      "RESUME",
    ]);
  });

  it("does not erase a durable resume claim during an unchanged autosave", async () => {
    const { create, store } = await makeHarness();
    await store.save(input);
    const context = {
      userId: input.userId,
      taskId: input.taskId,
      taskFound: true,
      revision: input.revision,
      editable: true,
    };
    await store.reconcileAndClaimResume(context);
    await store.save(input);

    expect((await create().reconcileAndClaimResume(context)).kind).toBe(
      "ALREADY_RESUMED",
    );
  });

  it("does not erase the owning tab's resume claim when an autosave changes content", async () => {
    const { create, store } = await makeHarness();
    await store.save(input);
    const context = {
      userId: input.userId,
      taskId: input.taskId,
      taskFound: true,
      revision: input.revision,
      editable: true,
    };
    await store.reconcileAndClaimResume(context);
    await store.save({ ...input, proposedDescription: "وصف معدّل في التبويب المالك" });

    expect((await create().reconcileAndClaimResume(context)).kind).toBe(
      "ALREADY_RESUMED",
    );
  });

  it("makes the first autosave own a new draft before another tab can resume it", async () => {
    const { create, store } = await makeHarness();
    await store.save(input);
    const result = await create().reconcileAndClaimResume({
      userId: input.userId,
      taskId: input.taskId,
      taskFound: true,
      revision: input.revision,
      editable: true,
    });
    expect(result.kind).toBe("ALREADY_RESUMED");
  });

  it("rejects a stale tab autosave after another tab owns the draft", async () => {
    const { advance, create, store } = await makeHarness();
    await store.save(input);
    advance(60_001);
    const otherTab = create();
    const context = {
      userId: input.userId,
      taskId: input.taskId,
      taskFound: true,
      revision: input.revision,
      editable: true,
    };
    expect((await otherTab.reconcileAndClaimResume(context)).kind).toBe("RESUME");
    await otherTab.save({ ...input, proposedDescription: "تعديل التبويب المالك" });

    await expect(store.save({ ...input, proposedDescription: "كتابة قديمة" })).rejects.toThrow("تبويب آخر");
    expect(await otherTab.load(input.userId, input.taskId)).toMatchObject({
      proposedDescription: "تعديل التبويب المالك",
    });
  });

  it("discovers and restores an offline draft without an in-memory task query", async () => {
    const { create, store } = await makeHarness();
    await store.save(input);
    expect(await create().listForUser(input.userId)).toMatchObject([input]);
  });

  it("restores cold offline ownership and the effective task snapshot without an auth query", async () => {
    const { create, createIdentity, store } = await makeHarness();
    await store.save(input);
    await createIdentity().save(input.userId);

    const coldIdentity = await createIdentity().load();
    expect(coldIdentity).toMatchObject({ userId: input.userId });
    expect(await create().listForUser(coldIdentity!.userId)).toMatchObject([
      {
        taskSnapshot: input.taskSnapshot,
        originalDataUrl: input.originalDataUrl,
        processingReceipt: input.processingReceipt,
      },
    ]);
  });

  it("retains a draft as a conflict when its task disappears after reconnect", async () => {
    const { store } = await makeHarness();
    await store.save(input);
    expect(
      (
        await store.reconcileAndClaimResume({
          userId: input.userId,
          taskId: input.taskId,
          taskFound: false,
          revision: null,
          editable: false,
        })
      ).kind,
    ).toBe("CONFLICT");
    expect(await store.load(input.userId, input.taskId)).toMatchObject(input);
  });
});
