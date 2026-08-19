import {
  decryptJson,
  encryptJson,
  type EncryptedEnvelope,
} from "@/lib/offline/crypto";
import { offlineDb } from "@/lib/offline/db";

export const STUDIO_DRAFT_TTL_MS = 24 * 60 * 60 * 1_000;
export const STUDIO_DRAFT_RESUME_LEASE_MS = 60_000;

export type StudioDraftMode = "FLATTEN" | "CUT" | "AI";

export interface StudioDraftTaskSnapshot {
  taskId: number;
  productName: string;
  currentDescription: string | null;
  status: "ASSIGNED" | "IN_PROGRESS" | "REJECTED";
  hasOriginal: boolean;
  hasCandidate: boolean;
  updatedAt: string;
}

export interface StudioDraftInput {
  userId: number;
  taskId: number;
  revision: string;
  proposedName: string;
  proposedDescription: string;
  proposedMarketingCopy: string;
  imageDataUrl: string | null;
  originalDataUrl: string | null;
  processingReceipt: string | null;
  taskSnapshot: StudioDraftTaskSnapshot;
  mode: StudioDraftMode;
}

export interface StudioDraft extends StudioDraftInput {
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  /** lease مشفّر قصير: يصدّ الاستئناف المتزامن ولا يقفل المسودة بعد crash/reload. */
  resumeLease: { sessionId: string; expiresAt: number } | null;
}

/** لا يحمل سجل IndexedDB أي محتوى قابل للقراءة؛ المفتاح فهرسة محلية فقط. */
export interface StudioDraftRecord {
  id: string;
  envelope: EncryptedEnvelope;
}

export interface StudioDraftIdentityRecord {
  id: "studio-identity";
  envelope: EncryptedEnvelope;
}

export interface StudioDraftIdentity {
  userId: number;
  savedAt: number;
}

export interface StudioDraftPersistence {
  get(id: string): Promise<StudioDraftRecord | undefined>;
  put(row: StudioDraftRecord): Promise<unknown>;
  delete(id: string): Promise<unknown>;
  entries(): Promise<StudioDraftRecord[]>;
}

interface StudioDraftStoreOptions {
  persistence: StudioDraftPersistence;
  now?: () => number;
  encrypt?: (value: unknown) => Promise<EncryptedEnvelope>;
  decrypt?: <T>(envelope: EncryptedEnvelope) => Promise<T>;
  /** فهرس معتم قابل لإعادة الحساب؛ لا يضع userId/taskId في مفتاح IndexedDB. */
  idFor?: (userId: number, taskId: number) => Promise<string>;
}

export type StudioDraftReconciliation =
  | { kind: "NONE" }
  | { kind: "RESUME"; draft: StudioDraft }
  | { kind: "ALREADY_RESUMED"; draft: StudioDraft }
  | { kind: "CONFLICT"; draft: StudioDraft };

const STUDIO_DRAFT_INDEX_KEY = "studio-draft-index-hmac";

async function studioDraftOpaqueId(
  userId: number,
  taskId: number,
): Promise<string> {
  let key = (await offlineDb.keys.get(STUDIO_DRAFT_INDEX_KEY))?.key;
  if (!key) {
    key = await crypto.subtle.generateKey(
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    await offlineDb.keys.put({ name: STUDIO_DRAFT_INDEX_KEY, key });
  }
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${userId}:${taskId}`),
    ),
  );
  return `sd-${Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function validDraft(value: unknown): value is StudioDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<StudioDraft>;
  return (
    Number.isInteger(draft.userId) &&
    Number.isInteger(draft.taskId) &&
    typeof draft.revision === "string" &&
    typeof draft.proposedName === "string" &&
    typeof draft.proposedDescription === "string" &&
    typeof draft.proposedMarketingCopy === "string" &&
    (typeof draft.imageDataUrl === "string" || draft.imageDataUrl === null) &&
    (typeof draft.originalDataUrl === "string" ||
      draft.originalDataUrl === null) &&
    (typeof draft.processingReceipt === "string" ||
      draft.processingReceipt === null) &&
    typeof draft.taskSnapshot === "object" &&
    draft.taskSnapshot !== null &&
    Number.isInteger(draft.taskSnapshot.taskId) &&
    typeof draft.taskSnapshot.productName === "string" &&
    (typeof draft.taskSnapshot.currentDescription === "string" ||
      draft.taskSnapshot.currentDescription === null) &&
    ["ASSIGNED", "IN_PROGRESS", "REJECTED"].includes(
      draft.taskSnapshot.status ?? "",
    ) &&
    typeof draft.taskSnapshot.hasOriginal === "boolean" &&
    typeof draft.taskSnapshot.hasCandidate === "boolean" &&
    typeof draft.taskSnapshot.updatedAt === "string" &&
    (draft.mode === "FLATTEN" || draft.mode === "CUT" || draft.mode === "AI") &&
    typeof draft.createdAt === "number" &&
    typeof draft.updatedAt === "number" &&
    typeof draft.expiresAt === "number" &&
    (draft.resumeLease === null ||
      (typeof draft.resumeLease === "object" &&
        typeof draft.resumeLease.sessionId === "string" &&
        typeof draft.resumeLease.expiresAt === "number"))
  );
}

/**
 * مخزن صغير قابل للحقن: التشفير ومخزن IndexedDB خارج المنطق كي تُختبر حماية المسودات
 * فعلياً بلا قاعدة أو متصفح. المفتاح المقيم في WebCrypto هو ما يربطها بالجهاز.
 */
export function createStudioDraftStore(options: StudioDraftStoreOptions) {
  const now = options.now ?? Date.now;
  const encrypt = options.encrypt ?? encryptJson;
  const decrypt = options.decrypt ?? decryptJson;
  const idFor = options.idFor ?? studioDraftOpaqueId;
  const sessionId = crypto.randomUUID();

  async function readRow(
    row: StudioDraftRecord,
    at: number,
  ): Promise<StudioDraft | null> {
    try {
      const draft = await decrypt<StudioDraft>(row.envelope);
      if (!validDraft(draft) || draft.expiresAt <= at) {
        await options.persistence.delete(row.id);
        return null;
      }
      return draft;
    } catch {
      await options.persistence.delete(row.id);
      return null;
    }
  }

  async function load(
    userId: number,
    taskId: number,
    at = now(),
  ): Promise<StudioDraft | null> {
    const id = await idFor(userId, taskId);
    const row = await options.persistence.get(id);
    if (!row) return null;
    const draft = await readRow(row, at);
    if (!draft || draft.userId !== userId || draft.taskId !== taskId) {
      await options.persistence.delete(id);
      return null;
    }
    return draft;
  }

  return {
    async save(input: StudioDraftInput): Promise<StudioDraft> {
      const id = await idFor(input.userId, input.taskId);
      const existing = await load(input.userId, input.taskId);
      const timestamp = now();
      const unchanged =
        existing != null &&
        existing.revision === input.revision &&
        existing.proposedName === input.proposedName &&
        existing.proposedDescription === input.proposedDescription &&
        existing.proposedMarketingCopy === input.proposedMarketingCopy &&
        existing.imageDataUrl === input.imageDataUrl &&
        existing.originalDataUrl === input.originalDataUrl &&
        existing.processingReceipt === input.processingReceipt &&
        existing.mode === input.mode;
      const draft: StudioDraft = {
        ...input,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        expiresAt: timestamp + STUDIO_DRAFT_TTL_MS,
        resumeLease: unchanged ? existing.resumeLease : null,
      };
      await options.persistence.put({ id, envelope: await encrypt(draft) });
      return draft;
    },

    load,

    async purge(userId: number, taskId: number): Promise<void> {
      const id = await idFor(userId, taskId);
      await options.persistence.delete(id);
    },

    async purgeUser(userId: number): Promise<void> {
      const rows = await options.persistence.entries();
      await Promise.all(
        rows.map(async (row) => {
          try {
            const draft = await decrypt<StudioDraft>(row.envelope);
            if (!validDraft(draft) || draft.userId === userId) {
              await options.persistence.delete(row.id);
            }
          } catch {
            await options.persistence.delete(row.id);
          }
        }),
      );
    },

    async purgeAll(): Promise<void> {
      const rows = await options.persistence.entries();
      await Promise.all(
        rows.map(async (row) => {
          await options.persistence.delete(row.id);
        }),
      );
    },

    async purgeExpired(at = now()): Promise<void> {
      const rows = await options.persistence.entries();
      await Promise.all(
        rows.map(async (row) => {
          try {
            const draft = await decrypt<StudioDraft>(row.envelope);
            if (!validDraft(draft) || draft.expiresAt <= at) {
              await options.persistence.delete(row.id);
            }
          } catch {
            await options.persistence.delete(row.id);
          }
        }),
      );
    },

    async listForUser(userId: number, at = now()): Promise<StudioDraft[]> {
      const rows = await options.persistence.entries();
      const drafts = await Promise.all(rows.map((row) => readRow(row, at)));
      return drafts
        .filter((draft): draft is StudioDraft => draft?.userId === userId)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async reconcileAndClaimResume(context: {
      userId: number;
      taskId: number;
      taskFound: boolean;
      revision: string | null;
      editable: boolean;
    }): Promise<StudioDraftReconciliation> {
      const draft = await load(context.userId, context.taskId);
      if (!draft) return { kind: "NONE" };
      if (
        !context.taskFound ||
        !context.editable ||
        draft.revision !== context.revision
      )
        return { kind: "CONFLICT", draft };
      if (draft.resumeLease && draft.resumeLease.expiresAt > now())
        return { kind: "ALREADY_RESUMED", draft };
      const claimed = {
        ...draft,
        resumeLease: {
          sessionId,
          expiresAt: now() + STUDIO_DRAFT_RESUME_LEASE_MS,
        },
      };
      await options.persistence.put({
        id: await idFor(context.userId, context.taskId),
        envelope: await encrypt(claimed),
      });
      return { kind: "RESUME", draft: claimed };
    },
  };
}

interface StudioDraftIdentityStoreOptions {
  persistence: Pick<StudioDraftPersistence, "get" | "put" | "delete">;
  now?: () => number;
  encrypt?: (value: unknown) => Promise<EncryptedEnvelope>;
  decrypt?: <T>(envelope: EncryptedEnvelope) => Promise<T>;
}

/** هوية محلية مشفرة للاستعادة الباردة فقط؛ لا تصلح أبداً كإثبات صلاحية أو إذن شبكة. */
export function createStudioDraftIdentityStore(
  options: StudioDraftIdentityStoreOptions,
) {
  const now = options.now ?? Date.now;
  const encrypt = options.encrypt ?? encryptJson;
  const decrypt = options.decrypt ?? decryptJson;
  const id = "studio-identity" as const;
  return {
    async save(userId: number): Promise<StudioDraftIdentity> {
      const identity = { userId, savedAt: now() };
      await options.persistence.put({ id, envelope: await encrypt(identity) });
      return identity;
    },
    async load(): Promise<StudioDraftIdentity | null> {
      const row = await options.persistence.get(id);
      if (!row) return null;
      try {
        const identity = await decrypt<StudioDraftIdentity>(row.envelope);
        if (
          !Number.isInteger(identity?.userId) ||
          identity.userId <= 0 ||
          typeof identity.savedAt !== "number"
        ) {
          await options.persistence.delete(id);
          return null;
        }
        return identity;
      } catch {
        await options.persistence.delete(id);
        return null;
      }
    },
    clear: () => options.persistence.delete(id),
  };
}

const indexedDbPersistence: StudioDraftPersistence = {
  get: (id) => offlineDb.studioDrafts.get(id),
  put: (row) => offlineDb.studioDrafts.put(row),
  delete: (id) => offlineDb.studioDrafts.delete(id),
  entries: () => offlineDb.studioDrafts.toArray(),
};

const indexedDbIdentityPersistence: StudioDraftIdentityStoreOptions["persistence"] =
  {
    get: (id) => offlineDb.studioDraftIdentity.get(id),
    put: (row) =>
      offlineDb.studioDraftIdentity.put(row as StudioDraftIdentityRecord),
    delete: (id) => offlineDb.studioDraftIdentity.delete(id),
  };

const deviceStudioDrafts = createStudioDraftStore({
  persistence: indexedDbPersistence,
});
const deviceStudioDraftIdentity = createStudioDraftIdentityStore({
  persistence: indexedDbIdentityPersistence,
});

export const saveStudioDraft = deviceStudioDrafts.save;
export const loadStudioDraft = deviceStudioDrafts.load;
export const purgeStudioDraft = deviceStudioDrafts.purge;
export const purgeStudioDraftsForUser = deviceStudioDrafts.purgeUser;
export async function purgeAllStudioDrafts(): Promise<void> {
  await deviceStudioDrafts.purgeAll();
  await deviceStudioDraftIdentity.clear();
}
export const purgeExpiredStudioDrafts = deviceStudioDrafts.purgeExpired;
export const listStudioDraftsForUser = deviceStudioDrafts.listForUser;
export const saveStudioDraftIdentity = deviceStudioDraftIdentity.save;
export const loadStudioDraftIdentity = deviceStudioDraftIdentity.load;
export const reconcileStudioDraftAfterReconnect =
  deviceStudioDrafts.reconcileAndClaimResume;

export function studioTaskRevision(updatedAt: Date | string): string {
  return updatedAt instanceof Date
    ? updatedAt.toISOString()
    : String(updatedAt);
}
