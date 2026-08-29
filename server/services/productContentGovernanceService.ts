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

function auditPayload<T>(value: T): T {
  return redactAuditValue(value) as T;
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

export type PendingContentDraftRow = {
  id: number;
  productId: number;
  productName: string;
  productImageId: number | null;
  productImageHash: string | null;
  content: unknown; // ProductChannelContentInput (JSON as stored)
  validation: ProductContentValidationSnapshot;
  promptVersion: string;
  model: string;
  createdAt: Date;
};

/**
 * الطابور المسطَّح: كل مسودّات DRAFT عبر كل المنتجات، مع اسم المنتج ومعرّف الصورة الرئيسيّة إن
 * وُجدت. مصمَّم للشاشة الموحّدة «/products/content-drafts» يفتحها المدير مرّةً ويعتمد الكلّ.
 */
export async function listPendingContentDrafts(limit = 100): Promise<PendingContentDraftRow[]> {
  const databaseLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
  return withTx(
    async (tx) => {
      // نجلب الصور المعتمَدة primary لكل منتجٍ في المسودّات كاستعلامٍ فرعيّ لاحق (اختياريّ في
      // الواجهة كمصغَّرة تعرض للمدير أيّ صورة أنتجت المسودّة).
      const rows = await tx
        .select({
          id: productContentDrafts.id,
          productId: productContentDrafts.productId,
          content: productContentDrafts.content,
          validation: productContentDrafts.validation,
          promptVersion: productContentDrafts.promptVersion,
          model: productContentDrafts.model,
          createdAt: productContentDrafts.createdAt,
          productName: products.name,
        })
        .from(productContentDrafts)
        .innerJoin(products, eq(products.id, productContentDrafts.productId))
        .where(eq(productContentDrafts.status, "DRAFT"))
        .orderBy(desc(productContentDrafts.createdAt), desc(productContentDrafts.id))
        .limit(databaseLimit);

      return rows.map((r) => ({
        id: Number(r.id),
        productId: Number(r.productId),
        productName: String(r.productName ?? ""),
        productImageId: null,
        productImageHash: null,
        content: r.content,
        validation: r.validation as ProductContentValidationSnapshot,
        promptVersion: String(r.promptVersion),
        model: String(r.model),
        createdAt: r.createdAt as Date,
      }));
    },
    { gate: "NONE" },
  );
}

const APPLICABLE_CONTENT_FIELDS: Array<keyof ProductChannelContentInput> = [
  "internalName",
  "storeTitle",
  "seoTitle",
  "shortTitle",
  "posLabel",
  "invoiceLabel",
  "marketingCopy",
  "description",
];

/**
 * يطبّق مسودّةً على أعمدة المنتج (name+description+seoTitle+shortTitle+posLabel+invoiceLabel+
 * marketingCopy+storeTitle+internalName)، ويعلّم المسودّة APPLIED. يُقبَل من حالة DRAFT مباشرةً
 * (اعتماد+تطبيق في خطوة) أو من APPROVED (تطبيقُ ما اعتمده مراجعٌ سابق).
 * ⛔ الحقول الفارغة في content تُتجاهَل — لا نطمس قيمةً بشرطة نصّية.
 * name يُملأ من seoTitle إن كان غير موجودٍ في content — لأنّ الاسم مطلوبٌ notNull.
 */
export async function applyContentDraft(
  draftId: number,
  actor: ProductContentActor,
) {
  return withTx(
    async (tx) => {
      const [draft] = await tx
        .select()
        .from(productContentDrafts)
        .where(eq(productContentDrafts.id, draftId))
        .limit(1);
      if (!draft) {
        throw new TRPCError({ code: "NOT_FOUND", message: "مسودة المحتوى غير موجودة." });
      }
      if (draft.status !== "DRAFT" && draft.status !== "APPROVED") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "هذه المسودة لا تسمح بالتطبيق (حالتها الحاليّة تمنع التغيير).",
        });
      }
      const productId = Number(draft.productId ?? 0);
      if (!Number.isSafeInteger(productId) || productId <= 0) {
        throw new TRPCError({ code: "CONFLICT", message: "مسودة بلا منتجٍ مرتبط." });
      }
      const content = (draft.content ?? {}) as Partial<Record<keyof ProductChannelContentInput, string | null>>;

      const productPatch: Record<string, string> = {};
      for (const field of APPLICABLE_CONTENT_FIELDS) {
        const value = content[field];
        if (typeof value === "string" && value.trim().length > 0) {
          productPatch[field as string] = value.trim();
        }
      }
      // اسم المنتج notNull — إن اعتمدنا seoTitle كمصدرٍ افتراضيّ للاسم عند غيابه في content ⇒ نضمن
      // ألّا يبقى المنتج بعنوانٍ قديمٍ فارغاً بعد التطبيق.
      const seoTitle = content.seoTitle?.trim();
      if (seoTitle) productPatch.name = seoTitle;

      if (Object.keys(productPatch).length > 0) {
        await tx
          .update(products)
          .set(productPatch)
          .where(eq(products.id, productId));
      }

      await tx
        .update(productContentDrafts)
        .set({
          status: "APPLIED",
          reviewedBy: actor.userId,
          reviewedAt: new Date(),
          decisionNote: draft.status === "APPROVED" ? draft.decisionNote : "تطبيقٌ مباشر بعد المراجعة.",
        })
        .where(eq(productContentDrafts.id, draftId));

      await tx.insert(productContentApprovalEvents).values({
        draftId,
        productId,
        action: "APPLIED",
        actorUserId: actor.userId,
        branchId: actor.branchId ?? null,
        sourceFactsHash: draft.sourceFactsHash,
        beforeContent: null,
        afterContent: auditPayload(content),
        note: `تطبيق مسودّة على المنتج (${Object.keys(productPatch).length} حقلاً).`,
      });

      await tx.insert(auditLogs).values({
        userId: actor.userId,
        branchId: actor.branchId ?? null,
        action: "productContent.draft.applied",
        entityType: "productContentDraft",
        entityId: String(draftId),
        oldValue: auditPayload({ status: draft.status }),
        newValue: auditPayload({
          status: "APPLIED",
          appliedFields: Object.keys(productPatch),
        }),
        ipAddress: null,
      });

      return { draftId, productId, appliedFields: Object.keys(productPatch) };
    },
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
