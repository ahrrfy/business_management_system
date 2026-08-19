import {
  decryptJson,
  encryptJson,
  type EncryptedEnvelope,
} from "@/lib/offline/crypto";
import { offlineDb } from "@/lib/offline/db";

export const STUDIO_DRAFT_TTL_MS = 24 * 60 * 60 * 1_000;

export type StudioDraftMode = "FLATTEN" | "CUT" | "AI";

export interface StudioDraftInput {
  userId: number;
  taskId: number;
  revision: string;
  proposedName: string;
  proposedDescription: string;
  proposedMarketingCopy: string;
  imageDataUrl: string | null;
  mode: StudioDraftMode;
}

export interface StudioDraft extends StudioDraftInput {
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

/** لا يحمل سجل IndexedDB أي محتوى قابل للقراءة؛ المفتاح فهرسة محلية فقط. */
export interface StudioDraftRecord {
  id: string;
  envelope: EncryptedEnvelope;
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
}

export type StudioDraftReconciliation =
  | { kind: "NONE" }
  | { kind: "RESUME"; draft: StudioDraft }
  | { kind: "ALREADY_RESUMED"; draft: StudioDraft }
  | { kind: "CONFLICT"; draft: StudioDraft };

function draftId(userId: number, taskId: number): string {
  return `${userId}:${taskId}`;
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
    (draft.mode === "FLATTEN" || draft.mode === "CUT" || draft.mode === "AI") &&
    typeof draft.createdAt === "number" &&
    typeof draft.updatedAt === "number" &&
    typeof draft.expiresAt === "number"
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
  const resumed = new Set<string>();

  async function load(
    userId: number,
    taskId: number,
    at = now(),
  ): Promise<StudioDraft | null> {
    const id = draftId(userId, taskId);
    const row = await options.persistence.get(id);
    if (!row) return null;
    try {
      const draft = await decrypt<StudioDraft>(row.envelope);
      if (
        !validDraft(draft) ||
        draft.userId !== userId ||
        draft.taskId !== taskId ||
        draft.expiresAt <= at
      ) {
        await options.persistence.delete(id);
        resumed.delete(id);
        return null;
      }
      return draft;
    } catch {
      // مفتاح جهاز آخر أو سجل تالف: لا نخاطر بعرض محتوى غير موثوق.
      await options.persistence.delete(id);
      resumed.delete(id);
      return null;
    }
  }

  return {
    async save(input: StudioDraftInput): Promise<StudioDraft> {
      const id = draftId(input.userId, input.taskId);
      const existing = await load(input.userId, input.taskId);
      const timestamp = now();
      const draft: StudioDraft = {
        ...input,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        expiresAt: timestamp + STUDIO_DRAFT_TTL_MS,
      };
      await options.persistence.put({ id, envelope: await encrypt(draft) });
      resumed.delete(id);
      return draft;
    },

    load,

    async purge(userId: number, taskId: number): Promise<void> {
      const id = draftId(userId, taskId);
      await options.persistence.delete(id);
      resumed.delete(id);
    },

    async purgeUser(userId: number): Promise<void> {
      const rows = await options.persistence.entries();
      await Promise.all(
        rows.map(async (row) => {
          try {
            const draft = await decrypt<StudioDraft>(row.envelope);
            if (!validDraft(draft) || draft.userId === userId) {
              await options.persistence.delete(row.id);
              resumed.delete(row.id);
            }
          } catch {
            await options.persistence.delete(row.id);
            resumed.delete(row.id);
          }
        }),
      );
    },

    async purgeAll(): Promise<void> {
      const rows = await options.persistence.entries();
      await Promise.all(
        rows.map(async (row) => {
          await options.persistence.delete(row.id);
          resumed.delete(row.id);
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
              resumed.delete(row.id);
            }
          } catch {
            await options.persistence.delete(row.id);
            resumed.delete(row.id);
          }
        }),
      );
    },

    async reconcileAndClaimResume(context: {
      userId: number;
      taskId: number;
      revision: string;
      editable: boolean;
    }): Promise<StudioDraftReconciliation> {
      const draft = await load(context.userId, context.taskId);
      if (!draft) return { kind: "NONE" };
      if (!context.editable || draft.revision !== context.revision)
        return { kind: "CONFLICT", draft };
      const id = draftId(context.userId, context.taskId);
      if (resumed.has(id)) return { kind: "ALREADY_RESUMED", draft };
      resumed.add(id);
      return { kind: "RESUME", draft };
    },
  };
}

const indexedDbPersistence: StudioDraftPersistence = {
  get: (id) => offlineDb.studioDrafts.get(id),
  put: (row) => offlineDb.studioDrafts.put(row),
  delete: (id) => offlineDb.studioDrafts.delete(id),
  entries: () => offlineDb.studioDrafts.toArray(),
};

const deviceStudioDrafts = createStudioDraftStore({
  persistence: indexedDbPersistence,
});

export const saveStudioDraft = deviceStudioDrafts.save;
export const loadStudioDraft = deviceStudioDrafts.load;
export const purgeStudioDraft = deviceStudioDrafts.purge;
export const purgeStudioDraftsForUser = deviceStudioDrafts.purgeUser;
export const purgeAllStudioDrafts = deviceStudioDrafts.purgeAll;
export const purgeExpiredStudioDrafts = deviceStudioDrafts.purgeExpired;
export const reconcileStudioDraftAfterReconnect =
  deviceStudioDrafts.reconcileAndClaimResume;

export function studioTaskRevision(updatedAt: Date | string): string {
  return updatedAt instanceof Date
    ? updatedAt.toISOString()
    : String(updatedAt);
}
