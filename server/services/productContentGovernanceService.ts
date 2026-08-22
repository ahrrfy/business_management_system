import { TRPCError } from "@trpc/server";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import {
  auditLogs,
  productContentApprovalEvents,
  productContentDrafts,
  products,
} from "../../drizzle/schema";
import type {
  ProductChannelContentInput,
  ProductContentValidationSnapshot,
} from "../../shared/productContentAi";
import { redactAuditValue } from "./auditService";
import { withTx } from "./tx";

export type ProductContentActor = {
  userId: number;
  branchId?: number | null;
};

export type SaveProductContentDraftInput = {
  productId: number;
  sourceFacts: Record<string, unknown>;
  sourceFactsHash: string;
  content: ProductChannelContentInput;
  validation: ProductContentValidationSnapshot;
  promptVersion: string;
  model: string;
};

export type ProductContentDecision = "APPROVED" | "REJECTED";

function auditPayload(content: ProductChannelContentInput): ProductChannelContentInput {
  return redactAuditValue(content) as ProductChannelContentInput;
}

/** حفظ مسودة جديدة، وإبطال المسودات المفتوحة السابقة للمنتج داخل معاملة واحدة. */
export async function saveProductContentDraft(
  input: SaveProductContentDraftInput,
  actor: ProductContentActor,
) {
  if (!Number.isSafeInteger(input.productId) || input.productId <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "معرّف المنتج غير صالح.",
    });
  }
  if (!input.validation.ok) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا يمكن حفظ مسودة تحتوي على أخطاء تحقق حرجة.",
    });
  }

  return withTx(
    async (tx) => {
      const product = await tx
        .select({ id: products.id })
        .from(products)
        .where(eq(products.id, input.productId))
        .limit(1);
      if (!product[0]) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "المنتج غير موجود.",
        });
      }

      const previous = await tx
        .select({ id: productContentDrafts.id })
        .from(productContentDrafts)
        .where(
          and(
            eq(productContentDrafts.productId, input.productId),
            eq(productContentDrafts.status, "DRAFT"),
          ),
        );

      if (previous.length) {
        await tx
          .update(productContentDrafts)
          .set({ status: "SUPERSEDED", decisionNote: "استُبدلت بمسودة أحدث." })
          .where(
            and(
              eq(productContentDrafts.productId, input.productId),
              eq(productContentDrafts.status, "DRAFT"),
            ),
          );
        await tx.insert(productContentApprovalEvents).values(
          previous.map((row) => ({
            draftId: Number(row.id),
            productId: input.productId,
            action: "SUPERSEDED" as const,
            actorUserId: actor.userId,
            branchId: actor.branchId ?? null,
            sourceFactsHash: input.sourceFactsHash,
            note: "استُبدلت بمسودة أحدث.",
          })),
        );
      }

      const inserted = await tx.insert(productContentDrafts).values({
        productId: input.productId,
        sourceFacts: input.sourceFacts,
        sourceFactsHash: input.sourceFactsHash,
        content: input.content,
        validation: input.validation,
        status: "DRAFT",
        promptVersion: input.promptVersion,
        model: input.model,
        createdBy: actor.userId,
      });
      const draftId = Number(inserted[0]?.insertId ?? 0);
      if (!draftId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "تعذر إنشاء مسودة المحتوى.",
        });
      }

      await tx.insert(productContentApprovalEvents).values({
        draftId,
        productId: input.productId,
        action: "SUBMITTED",
        actorUserId: actor.userId,
        branchId: actor.branchId ?? null,
        sourceFactsHash: input.sourceFactsHash,
        afterContent: auditPayload(input.content),
        note: "إنشاء مسودة محتوى.",
      });

      await tx.insert(auditLogs).values({
        userId: actor.userId,
        branchId: actor.branchId ?? null,
        action: "productContent.draft.submitted",
        entityType: "productContentDraft",
        entityId: String(draftId),
        oldValue: null,
        newValue: auditPayload({
          productId: input.productId,
          sourceFactsHash: input.sourceFactsHash,
        }),
        ipAddress: null,
      });

      return { draftId };
    },
    { gate: "NONE" },
  );
}

export async function listProductContentDrafts(productId: number, limit = 30) {
  const databaseLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  return withTx(
    async (tx) =>
      tx
        .select()
        .from(productContentDrafts)
        .where(eq(productContentDrafts.productId, productId))
        .orderBy(
          desc(productContentDrafts.createdAt),
          desc(productContentDrafts.id),
        )
        .limit(databaseLimit),
    { gate: "NONE" },
  );
}

/** اعتماد/رفض مسودة فقط؛ التطبيق على products سيكون إجراءً مستقلاً في مرحلة النشر. */
export async function decideProductContentDraft(
  draftId: number,
  decision: ProductContentDecision,
  note: string | null,
  actor: ProductContentActor,
) {
  return withTx(
    async (tx) => {
      const draft = (
        await tx
          .select()
          .from(productContentDrafts)
          .where(eq(productContentDrafts.id, draftId))
          .limit(1)
      )[0];
      if (!draft) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "مسودة المحتوى غير موجودة.",
        });
      }
      if (draft.status !== "DRAFT") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "هذه المسودة اتُخذ بشأنها قرار سابق ولا يمكن تغييره.",
        });
      }

      const status = decision === "APPROVED" ? "APPROVED" : "REJECTED";
      await tx
        .update(productContentDrafts)
        .set({
          status,
          reviewedBy: actor.userId,
          reviewedAt: new Date(),
          decisionNote: note?.trim() || null,
        })
        .where(eq(productContentDrafts.id, draftId));

      await tx.insert(productContentApprovalEvents).values({
        draftId,
        productId: draft.productId,
        action: decision,
        actorUserId: actor.userId,
        branchId: actor.branchId ?? null,
        sourceFactsHash: draft.sourceFactsHash,
        beforeContent: draft.content,
        afterContent: decision === "APPROVED" ? draft.content : null,
        note: note?.trim() || null,
      });

      await tx.insert(auditLogs).values({
        userId: actor.userId,
        branchId: actor.branchId ?? null,
        action: `productContent.draft.${decision.toLowerCase()}`,
        entityType: "productContentDraft",
        entityId: String(draftId),
        oldValue: auditPayload({
          status: draft.status,
          content: draft.content,
        }),
        newValue: auditPayload({ status, note: note?.trim() || null }),
        ipAddress: null,
      });

      return { draftId, status };
    },
    { gate: "NONE" },
  );
}
