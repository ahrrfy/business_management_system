import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { and, desc, eq, inArray, like, lt, sql } from "drizzle-orm";
import {
  branches,
  purchaseControlSettings,
  purchaseOrderRequisitionAllocations,
  purchaseOrderRevisionItems,
  purchaseRequisitionControlRequests,
  purchaseRequisitionItems,
  purchaseRequisitions,
} from "../../../drizzle/schema";
import { purchaseRequisitionControlTrigger } from "@shared/approvalTriggers";
import { extractInsertId } from "../../lib/insertId";
import type { DB, Tx } from "../../db";
import { assertApprover, resolveApprovalActor } from "../approval/ownerGate";
import {
  checkIdempotency,
  idempotencyHash,
  payloadHashMatches,
  recordIdempotencyKey,
} from "../idempotency";
import { toDateStr } from "../money";
import { requireDb, withTx, type Actor } from "../tx";
import type { PurchaseRevisionAllocationDraft } from "./revisions";

export type PurchaseRequisitionItemDraft = {
  variantId: number;
  productUnitId?: number | null;
  requestedBaseQuantity: number;
  estimatedUnitPrice?: string | null;
  preferredSupplierId?: number | null;
  justification: string;
};

export type PurchaseRequisitionDraft = {
  branchId: number;
  neededBy?: string | null;
  purpose: string;
  costCenter?: string | null;
  priority?: "LOW" | "NORMAL" | "URGENT";
  items: PurchaseRequisitionItemDraft[];
};

function assertBranch(branchId: number, actor: Actor): void {
  if (actor.role !== "admin" && branchId !== actor.branchId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر إدارة طلب الشراء",
        why: `الفرع (${branchId}) لا يخصّك — دورك يعمل على فرع (${actor.branchId})`,
        doThis: "افتح الطلب من فرعك، أو اطلب من مدير الفرع المعنيّ إدارته",
      }),
    });
  }
}

function validateDraft(input: PurchaseRequisitionDraft): void {
  const purpose = input.purpose.trim();
  if (purpose.length < 3 || purpose.length > 500) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حفظ طلب الشراء",
        why: `طول غرض الطلب ${purpose.length} محرفاً والمطلوب بين 3 و500`,
        doThis: "اكتب غرض الطلب بجملةٍ واضحة بين 3 و500 محرف، ثم أعد الحفظ",
      }),
    });
  }
  if (!input.items.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حفظ طلب الشراء",
        why: "الطلب بلا أصناف — لا يمكن رفع طلب فارغ",
        doThis: "أضف صنفاً واحداً على الأقلّ بالكمية والمبرّر، ثم أعد الحفظ",
      }),
    });
  }
  const seen = new Set<string>();
  for (const item of input.items) {
    if (
      !Number.isInteger(item.requestedBaseQuantity) ||
      item.requestedBaseQuantity <= 0
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر حفظ طلب الشراء",
          why: `كمية أحد الأصناف (${item.requestedBaseQuantity}) غير صحيحة — يجب أن تكون عدداً صحيحاً موجباً`,
          doThis: "صحّح كميات الأصناف (بأعدادٍ صحيحة موجبة) ثم أعد الحفظ",
        }),
      });
    }
    if (
      item.justification.trim().length < 3 ||
      item.justification.trim().length > 500
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر حفظ طلب الشراء",
          why: `مبرّر أحد البنود بطول ${item.justification.trim().length} محرفاً والمطلوب بين 3 و500`,
          doThis: "اكتب مبرّراً واضحاً لكل بند بين 3 و500 محرف، ثم أعد الحفظ",
        }),
      });
    }
    const key = `${item.variantId}:${item.productUnitId ?? 0}`;
    if (seen.has(key)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر حفظ طلب الشراء",
          why: "الصنف والوحدة تكرّرا في الطلب نفسه — لا يجوز تكرار البند",
          doThis: "ادمج البنود المكرّرة في سطرٍ واحد بالكمّية الإجمالية، أو غيّر الوحدة",
        }),
      });
    }
    seen.add(key);
  }
}

export async function getPurchaseControlSettingsTx(
  tx: Tx | DB,
  branchId: number,
) {
  const [settings] = await tx
    .select()
    .from(purchaseControlSettings)
    .where(eq(purchaseControlSettings.branchId, branchId))
    .limit(1);
  return (
    settings ?? {
      branchId,
      requireRequisition: false,
      allowEmergencyOrder: true,
      requireEmergencyApproval: true,
      priceTolerancePercent: "0.0000",
      totalToleranceAmount: "0.00",
      blockUninvoicedReceiptsAtClose: true,
      version: 0,
      updatedBy: null,
      updatedAt: null,
    }
  );
}

function dateInput(value: string | null | undefined): Date | null {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

export async function getPurchaseControlSettings(
  branchId: number,
  actor: Actor,
) {
  assertBranch(branchId, actor);
  const db = requireDb();
  return getPurchaseControlSettingsTx(db, branchId);
}

export async function updatePurchaseControlSettings(
  input: {
    branchId: number;
    expectedVersion: number;
    requireRequisition: boolean;
    allowEmergencyOrder: boolean;
    requireEmergencyApproval: boolean;
    priceTolerancePercent: string;
    totalToleranceAmount: string;
    blockUninvoicedReceiptsAtClose: boolean;
  },
  actor: Actor,
) {
  assertBranch(input.branchId, actor);
  return withTx(async (tx) => {
    const [branch] = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(eq(branches.id, input.branchId))
      .for("update")
      .limit(1);
    if (!branch)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر متابعة العملية",
          why: "الفرع المحدَّد غير موجود — قد يكون رقمه مغلوطاً أو حُذف الفرع",
          doThis: "افتح قائمة الفروع واختر فرعاً صالحاً، ثم أعد المحاولة",
        }),
      });
    const [current] = await tx
      .select()
      .from(purchaseControlSettings)
      .where(eq(purchaseControlSettings.branchId, input.branchId))
      .for("update")
      .limit(1);
    const currentVersion = Number(current?.version ?? 0);
    if (currentVersion !== input.expectedVersion) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر حفظ إعدادات المشتريات",
          why: `تغيّرت الإعدادات من نسخة ${input.expectedVersion} إلى ${currentVersion} بينما تعدّل`,
          doThis: "حدِّث الصفحة لجلب الإعدادات الحالية ثم أعد إدخال تعديلاتك",
        }),
      });
    }
    const values = {
      requireRequisition: input.requireRequisition,
      allowEmergencyOrder: input.allowEmergencyOrder,
      requireEmergencyApproval: input.requireEmergencyApproval,
      priceTolerancePercent: input.priceTolerancePercent,
      totalToleranceAmount: input.totalToleranceAmount,
      blockUninvoicedReceiptsAtClose: input.blockUninvoicedReceiptsAtClose,
      version: currentVersion + 1,
      updatedBy: actor.userId,
    };
    if (current) {
      await tx
        .update(purchaseControlSettings)
        .set(values)
        .where(eq(purchaseControlSettings.branchId, input.branchId));
    } else {
      await tx
        .insert(purchaseControlSettings)
        .values({ branchId: input.branchId, ...values });
    }
    return { branchId: input.branchId, version: currentVersion + 1 };
  });
}

async function insertRequisitionItemsTx(
  tx: Tx,
  requisitionId: number,
  items: PurchaseRequisitionItemDraft[],
) {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    await tx.insert(purchaseRequisitionItems).values({
      requisitionId,
      lineNo: index + 1,
      variantId: item.variantId,
      productUnitId: item.productUnitId ?? null,
      requestedBaseQuantity: item.requestedBaseQuantity,
      approvedBaseQuantity: 0,
      orderedBaseQuantity: 0,
      receivedBaseQuantity: 0,
      estimatedUnitPrice: item.estimatedUnitPrice ?? null,
      preferredSupplierId: item.preferredSupplierId ?? null,
      justification: item.justification.trim(),
    });
  }
}

export async function createPurchaseRequisition(
  input: PurchaseRequisitionDraft & { clientRequestId: string },
  actor: Actor,
) {
  assertBranch(input.branchId, actor);
  validateDraft(input);
  const payloadHash = idempotencyHash(input);
  return withTx(async (tx) => {
    const existing = await checkIdempotency(
      tx,
      "purchase.requisition.create",
      input.clientRequestId,
      payloadHash,
      { requireStoredHash: true },
    );
    if (existing != null)
      return { requisitionId: existing, idempotent: true as const };
    const [branch] = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(eq(branches.id, input.branchId))
      .for("update")
      .limit(1);
    if (!branch)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر متابعة العملية",
          why: "الفرع المحدَّد غير موجود — قد يكون رقمه مغلوطاً أو حُذف الفرع",
          doThis: "افتح قائمة الفروع واختر فرعاً صالحاً، ثم أعد المحاولة",
        }),
      });
    const prefix = `PR-${input.branchId}-${toDateStr().replace(/-/g, "")}-`;
    const [last] = await tx
      .select({ requisitionNumber: purchaseRequisitions.requisitionNumber })
      .from(purchaseRequisitions)
      .where(like(purchaseRequisitions.requisitionNumber, `${prefix}%`))
      .orderBy(desc(purchaseRequisitions.id))
      .for("update")
      .limit(1);
    const sequence = last
      ? Number.parseInt(last.requisitionNumber.slice(prefix.length), 10) + 1
      : 1;
    const requisitionNumber = `${prefix}${String(sequence).padStart(5, "0")}`;
    const result = await tx.insert(purchaseRequisitions).values({
      requisitionNumber,
      branchId: input.branchId,
      neededBy: dateInput(input.neededBy),
      purpose: input.purpose.trim(),
      costCenter: input.costCenter?.trim() || null,
      priority: input.priority ?? "NORMAL",
      status: "DRAFT",
      version: 1,
      createdBy: actor.userId,
    });
    const requisitionId = extractInsertId(result);
    await insertRequisitionItemsTx(tx, requisitionId, input.items);
    await recordIdempotencyKey(
      tx,
      "purchase.requisition.create",
      input.clientRequestId,
      requisitionId,
      payloadHash,
    );
    return {
      requisitionId,
      requisitionNumber,
      version: 1,
      status: "DRAFT" as const,
      idempotent: false as const,
    };
  });
}

export async function updatePurchaseRequisition(
  input: PurchaseRequisitionDraft & {
    requisitionId: number;
    expectedVersion: number;
  },
  actor: Actor,
) {
  validateDraft(input);
  return withTx(async (tx) => {
    const [requisition] = await tx
      .select()
      .from(purchaseRequisitions)
      .where(eq(purchaseRequisitions.id, input.requisitionId))
      .for("update")
      .limit(1);
    if (!requisition)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر متابعة العملية",
          why: `طلب الشراء بالرقم ${input.requisitionId} غير موجود — قد يكون حُذف أو الرقم مغلوط`,
          doThis: "افتح قائمة طلبات الشراء واختر الطلب من هناك، أو تحقّق من رقمه",
        }),
      });
    assertBranch(Number(requisition.branchId), actor);
    if (Number(requisition.branchId) !== input.branchId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تعديل طلب الشراء",
          why: `الطلب في فرعٍ (${requisition.branchId}) مختلف عن الفرع المرسَل (${input.branchId})`,
          doThis: "لا تُغيِّر فرع الطلب — أنشئ طلباً جديداً في الفرع الآخر إن لزم",
        }),
      });
    }
    if (requisition.status !== "DRAFT" && requisition.status !== "REJECTED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تعديل طلب الشراء",
          why: `حالة الطلب ${requisition.status} — التعديل مسموحٌ لمسوّدةٍ (DRAFT) أو طلب مرفوض (REJECTED) فقط`,
          doThis: "أنشئ طلباً جديداً بمواصفاتك، أو اطلب من المدير إعادة الطلب إلى المسوّدة",
        }),
      });
    }
    if (Number(requisition.version) !== input.expectedVersion) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر حفظ التعديلات",
          why: `نسخة الطلب تغيّرت من ${input.expectedVersion} إلى ${requisition.version} بينما تعدّل`,
          doThis: "حدِّث الصفحة لجلب النسخة الحالية ثم أعد إدخال تعديلاتك",
        }),
      });
    }
    await tx
      .delete(purchaseRequisitionItems)
      .where(eq(purchaseRequisitionItems.requisitionId, input.requisitionId));
    await insertRequisitionItemsTx(tx, input.requisitionId, input.items);
    await tx
      .update(purchaseRequisitions)
      .set({
        neededBy: dateInput(input.neededBy),
        purpose: input.purpose.trim(),
        costCenter: input.costCenter?.trim() || null,
        priority: input.priority ?? "NORMAL",
        status: "DRAFT",
        submittedBy: null,
        submittedAt: null,
        approvedBy: null,
        approvedAt: null,
        version: input.expectedVersion + 1,
      })
      .where(eq(purchaseRequisitions.id, input.requisitionId));
    return {
      requisitionId: input.requisitionId,
      version: input.expectedVersion + 1,
      status: "DRAFT" as const,
    };
  });
}

async function createRequisitionControlRequestTx(
  tx: Tx,
  input: {
    requisitionId: number;
    expectedVersion: number;
    kind: "APPROVE" | "CANCEL";
    requestKey: string;
    reason: string;
    payload: unknown;
  },
  actor: Actor,
) {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تسجيل طلب القرار",
        why: `سبب الطلب بطول ${reason.length} محرفاً والمطلوب بين 3 و500`,
        doThis: "اكتب سبباً واضحاً بين 3 و500 محرف، ثم أعد الإرسال",
      }),
    });
  }
  const payloadHash = idempotencyHash({
    requisitionId: input.requisitionId,
    expectedVersion: input.expectedVersion,
    kind: input.kind,
    reason,
    payload: input.payload,
  });
  const [requisition] = await tx
    .select()
    .from(purchaseRequisitions)
    .where(eq(purchaseRequisitions.id, input.requisitionId))
    .for("update")
    .limit(1);
  if (!requisition)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر متابعة العملية",
        why: `طلب الشراء بالرقم ${input.requisitionId} غير موجود — قد يكون حُذف أو الرقم مغلوط`,
        doThis: "افتح قائمة طلبات الشراء واختر الطلب من هناك، أو تحقّق من رقمه",
      }),
    });
  assertBranch(Number(requisition.branchId), actor);
  const [existing] = await tx
    .select()
    .from(purchaseRequisitionControlRequests)
    .where(eq(purchaseRequisitionControlRequests.requestKey, input.requestKey))
    .limit(1);
  if (existing) {
    if (
      !payloadHashMatches(payloadHash, existing.payloadHash) ||
      Number(existing.requisitionId) !== input.requisitionId ||
      existing.kind !== input.kind
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر تسجيل طلب القرار",
          why: "مفتاح طلب القرار مستعمل بحمولةٍ مختلفة عن الحمولة الحالية — التزامن يمنع إعادة استعمال نفس المفتاح لطلبين",
          doThis: "أنشئ طلب قرار جديداً بمفتاح فريد، أو استرجع نتيجة الطلب السابق بمفتاحه الأصليّ",
        }),
      });
    }
    return {
      requestId: Number(existing.id),
      status: existing.status,
      idempotent: true as const,
    };
  }
  if (Number(requisition.version) !== input.expectedVersion) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر متابعة العملية",
        why: `نسخة طلب الشراء تغيّرت من ${input.expectedVersion} إلى ${requisition.version} بينما تعمل`,
        doThis: "حدِّث الصفحة لجلب النسخة الحالية ثم أعد المحاولة",
      }),
    });
  }
  if (input.kind === "APPROVE" && requisition.status !== "SUBMITTED") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر طلب اعتماد الطلب",
        why: `حالة الطلب ${requisition.status} — الاعتماد يُطلب لطلبٍ مُرسَل (SUBMITTED) فقط`,
        doThis: "أرسل الطلب أوّلاً (SUBMIT) ثم اطلب اعتماده",
      }),
    });
  }
  if (
    input.kind === "CANCEL" &&
    !["DRAFT", "SUBMITTED", "APPROVED", "PARTIALLY_ORDERED"].includes(
      requisition.status,
    )
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر طلب إلغاء الطلب",
        why: `حالة الطلب ${requisition.status} — الإلغاء يُطلب لمسوّدةٍ أو مُرسَل أو معتمد أو جزئيّ الأمر فقط`,
        doThis: "افحص حالة الطلب في القائمة — إن كان مكتملاً أو ملغى فلا يقبل طلب إلغاء جديد",
      }),
    });
  }
  if (input.kind === "CANCEL") {
    const [ordered] = await tx
      .select({
        total: sql<number>`COALESCE(SUM(${purchaseRequisitionItems.orderedBaseQuantity}), 0)`,
      })
      .from(purchaseRequisitionItems)
      .where(eq(purchaseRequisitionItems.requisitionId, input.requisitionId));
    if (Number(ordered?.total ?? 0) > 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر طلب إلغاء طلب الشراء",
          why: `كمياته مربوطةٌ بأمر شراء (${Number(ordered?.total ?? 0)} وحدة) — لا يُلغى ما رُبط بمستند لاحق`,
          doThis: "افتح أمر الشراء المرتبط وعدّل كمياته أو ألغه أوّلاً، ثم أعد طلب إلغاء الطلب",
        }),
      });
    }
  }
  const pendingGuard = `${input.requisitionId}:${input.kind}`;
  const result = await tx.insert(purchaseRequisitionControlRequests).values({
    requestKey: input.requestKey,
    requisitionId: input.requisitionId,
    branchId: requisition.branchId,
    kind: input.kind,
    baseVersion: input.expectedVersion,
    payload: input.payload,
    payloadHash,
    reason,
    pendingGuard,
    requestedBy: actor.userId,
  });
  return {
    requestId: extractInsertId(result),
    status: "PENDING" as const,
    idempotent: false as const,
  };
}

export async function submitPurchaseRequisition(
  input: {
    requisitionId: number;
    expectedVersion: number;
    requestKey: string;
    reason: string;
  },
  actor: Actor,
) {
  return withTx(async (tx) => {
    const [requisition] = await tx
      .select()
      .from(purchaseRequisitions)
      .where(eq(purchaseRequisitions.id, input.requisitionId))
      .for("update")
      .limit(1);
    if (!requisition)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر متابعة العملية",
          why: `طلب الشراء بالرقم ${input.requisitionId} غير موجود — قد يكون حُذف أو الرقم مغلوط`,
          doThis: "افتح قائمة طلبات الشراء واختر الطلب من هناك، أو تحقّق من رقمه",
        }),
      });
    assertBranch(Number(requisition.branchId), actor);
    const [existing] = await tx
      .select()
      .from(purchaseRequisitionControlRequests)
      .where(
        eq(purchaseRequisitionControlRequests.requestKey, input.requestKey),
      )
      .limit(1);
    if (existing) {
      const expectedHash = idempotencyHash({
        requisitionId: input.requisitionId,
        expectedVersion: input.expectedVersion + 1,
        kind: "APPROVE",
        reason: input.reason.trim(),
        payload: existing.payload,
      });
      if (
        Number(existing.requisitionId) !== input.requisitionId ||
        existing.kind !== "APPROVE" ||
        !payloadHashMatches(expectedHash, existing.payloadHash)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر إرسال طلب الشراء",
            why: "مفتاح إرسال الطلب مستعمل بحمولةٍ مختلفة عن الحمولة الحالية — التزامن يمنع إعادة استعمال نفس المفتاح لطلبين",
            doThis: "أنشئ إرسالاً جديداً بمفتاح فريد، أو استرجع نتيجة الإرسال السابق بمفتاحه الأصليّ",
          }),
        });
      }
      return {
        requisitionId: input.requisitionId,
        requestId: Number(existing.id),
        status: "SUBMITTED" as const,
        idempotent: true as const,
      };
    }
    if (requisition.status !== "DRAFT") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إرسال الطلب",
          why: `حالة الطلب ${requisition.status} — الإرسال مسموحٌ لمسوّدةٍ (DRAFT) فقط`,
          doThis: "افتح قائمة طلبات الشراء وتحقّق من الحالة — الطلب المرسَل أو المعتمد لا يحتاج إعادة إرسال",
        }),
      });
    }
    if (Number(requisition.version) !== input.expectedVersion) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر إرسال الطلب",
          why: `نسخة الطلب تغيّرت من ${input.expectedVersion} إلى ${requisition.version} بينما تعمل`,
          doThis: "حدِّث الصفحة لجلب النسخة الحالية ثم أعد الإرسال",
        }),
      });
    }
    const items = await tx
      .select({
        id: purchaseRequisitionItems.id,
        requestedBaseQuantity: purchaseRequisitionItems.requestedBaseQuantity,
      })
      .from(purchaseRequisitionItems)
      .where(eq(purchaseRequisitionItems.requisitionId, input.requisitionId))
      .orderBy(purchaseRequisitionItems.lineNo);
    if (!items.length)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إرسال الطلب",
          why: "الطلب بلا أصناف — لا يمكن إرسال طلب فارغ",
          doThis: "افتح الطلب وأضف صنفاً واحداً على الأقلّ ثم أعد الإرسال",
        }),
      });
    const nextVersion = input.expectedVersion + 1;
    await tx
      .update(purchaseRequisitions)
      .set({
        status: "SUBMITTED",
        version: nextVersion,
        submittedBy: actor.userId,
        submittedAt: new Date(),
      })
      .where(eq(purchaseRequisitions.id, input.requisitionId));
    const request = await createRequisitionControlRequestTx(
      tx,
      {
        requisitionId: input.requisitionId,
        expectedVersion: nextVersion,
        kind: "APPROVE",
        requestKey: input.requestKey,
        reason: input.reason,
        payload: {
          approvedLines: items.map((item) => ({
            requisitionItemId: Number(item.id),
            approvedBaseQuantity: Number(item.requestedBaseQuantity),
          })),
        },
      },
      actor,
    );
    return {
      requisitionId: input.requisitionId,
      requestId: request.requestId,
      status: "SUBMITTED" as const,
      version: nextVersion,
      idempotent: false as const,
    };
  });
}

export async function requestPurchaseRequisitionCancellation(
  input: {
    requisitionId: number;
    expectedVersion: number;
    requestKey: string;
    reason: string;
  },
  actor: Actor,
) {
  return withTx((tx) =>
    createRequisitionControlRequestTx(
      tx,
      { ...input, kind: "CANCEL", payload: { cancel: true } },
      actor,
    ),
  );
}

export async function decidePurchaseRequisitionControl(
  input: {
    requestId: number;
    decisionKey: string;
    approve: boolean;
    reason: string;
  },
  actor: Actor,
) {
  const preview = (
    await requireDb()
      .select({
        requisitionId: purchaseRequisitionControlRequests.requisitionId,
      })
      .from(purchaseRequisitionControlRequests)
      .where(eq(purchaseRequisitionControlRequests.id, input.requestId))
      .limit(1)
  )[0];
  if (!preview)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر حسم طلب القرار",
        why: `طلب القرار بالرقم ${input.requestId} غير موجود — قد يكون حُذف أو الرقم مغلوط`,
        doThis: "افتح قائمة طلبات القرار المعلَّقة واختر الطلب من هناك",
      }),
    });
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حسم طلب القرار",
        why: `سبب القرار بطول ${reason.length} محرفاً والمطلوب بين 3 و500`,
        doThis: "اكتب سبباً واضحاً للقرار بين 3 و500 محرف، ثم أعد الإرسال",
      }),
    });
  }
  const payloadHash = idempotencyHash({
    requestId: input.requestId,
    approve: input.approve,
    reason,
  });
  return withTx(async (tx) => {
    const [requisition] = await tx
      .select()
      .from(purchaseRequisitions)
      .where(eq(purchaseRequisitions.id, preview.requisitionId))
      .for("update")
      .limit(1);
    if (!requisition)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر متابعة العملية",
          why: `طلب الشراء المرتبط بطلب القرار ${input.requestId} غير موجود — قد يكون حُذف`,
          doThis: "افتح قائمة طلبات القرار المعلَّقة واختر طلباً موجوداً",
        }),
      });
    assertBranch(Number(requisition.branchId), actor);
    const [request] = await tx
      .select()
      .from(purchaseRequisitionControlRequests)
      .where(eq(purchaseRequisitionControlRequests.id, input.requestId))
      .for("update")
      .limit(1);
    if (!request)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر حسم طلب القرار",
          why: `طلب القرار بالرقم ${input.requestId} غير موجود (قد يكون حُذف تحت التزامن)`,
          doThis: "أعد تحميل قائمة الطلبات المعلَّقة واختر طلباً موجوداً",
        }),
      });
    const existing = await checkIdempotency(
      tx,
      "purchase.requisition.decide",
      input.decisionKey,
      payloadHash,
      { requireStoredHash: true },
    );
    if (existing != null) {
      if (existing !== input.requestId)
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر حسم القرار",
            why: `مفتاح القرار سبق استعماله لطلبٍ آخر رقمه ${existing} — نفس المفتاح لا يخدم طلبين`,
            doThis: "أعد إرسال القرار بمفتاحٍ فريد جديد يخصّ هذا الطلب وحده",
          }),
        });
      return {
        requestId: input.requestId,
        status: request.status,
        idempotent: true as const,
      };
    }
    if (request.status !== "PENDING") {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر حسم القرار",
          why: `الطلب سبق حسمه بحالة ${request.status} — لا يقبل قراراً ثانياً`,
          doThis: "افتح قائمة الطلبات لعرض القرار السابق، وابدأ طلباً جديداً إن لزم",
        }),
      });
    }
    // طلبُ الشراء الداخليّ هو **الوحيد** في المشتريات الذي صمد تصنيفُه أمام التفنيد العدائيّ:
    // لا خروجَ مالٍ ولا محوَ أثر — يكتب كمّياتٍ معتمَدة وحالةً داخل مستنده، والالتزامُ
    // التعاقديّ (أمر الشراء) لاحقٌ له. ⇒ بوّابتُه تسقط كاملةً بالسياسة الجديدة.
    assertApprover({
      actor: await resolveApprovalActor(tx, actor),
      trigger: purchaseRequisitionControlTrigger(),
      subject: `طلب الشراء ${requisition.requisitionNumber}`,
      legacy: () => {
        if (
          actor.userId === Number(request.requestedBy) ||
          actor.userId === Number(requisition.createdBy) ||
          actor.userId === Number(requisition.submittedBy)
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: "تعذّر اعتماد الطلب",
              why: "فصل المهام: يلزم معتمدٌ مستقلّ عن المنشئ والمرسل وصاحب الطلب",
              doThis: "أحل الطلب إلى مدير آخر أو مراجعٍ مخوَّل ليعتمده",
            }),
          });
        }
      },
    });
    if (Number(request.baseVersion) !== Number(requisition.version)) {
      await tx
        .update(purchaseRequisitionControlRequests)
        .set({
          status: "STALE",
          pendingGuard: null,
          reviewedBy: actor.userId,
          reviewedAt: new Date(),
          reviewReason: "تغيّر طلب الشراء بعد إنشاء طلب القرار",
        })
        .where(eq(purchaseRequisitionControlRequests.id, input.requestId));
      await recordIdempotencyKey(
        tx,
        "purchase.requisition.decide",
        input.decisionKey,
        input.requestId,
        payloadHash,
      );
      return {
        requestId: input.requestId,
        status: "STALE" as const,
        idempotent: false as const,
      };
    }
    if (!input.approve) {
      await tx
        .update(purchaseRequisitionControlRequests)
        .set({
          status: "REJECTED",
          pendingGuard: null,
          reviewedBy: actor.userId,
          reviewedAt: new Date(),
          reviewReason: reason,
        })
        .where(eq(purchaseRequisitionControlRequests.id, input.requestId));
      if (request.kind === "APPROVE") {
        await tx
          .update(purchaseRequisitions)
          .set({ status: "REJECTED", version: Number(requisition.version) + 1 })
          .where(eq(purchaseRequisitions.id, requisition.id));
      }
      await recordIdempotencyKey(
        tx,
        "purchase.requisition.decide",
        input.decisionKey,
        input.requestId,
        payloadHash,
      );
      return {
        requestId: input.requestId,
        status: "REJECTED" as const,
        idempotent: false as const,
      };
    }
    if (request.kind === "APPROVE") {
      const approvedLines =
        (
          request.payload as {
            approvedLines?: Array<{
              requisitionItemId: number;
              approvedBaseQuantity: number;
            }>;
          }
        ).approvedLines ?? [];
      const items = await tx
        .select()
        .from(purchaseRequisitionItems)
        .where(eq(purchaseRequisitionItems.requisitionId, requisition.id))
        .for("update");
      const approvalById = new Map(
        approvedLines.map((line) => [
          line.requisitionItemId,
          line.approvedBaseQuantity,
        ]),
      );
      for (const item of items) {
        const quantity = Number(approvalById.get(Number(item.id)) ?? 0);
        if (
          !Number.isInteger(quantity) ||
          quantity < 0 ||
          quantity > Number(item.requestedBaseQuantity)
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "تعذّر اعتماد الطلب",
              why: `كمية الاعتماد (${quantity}) خارج المدى المسموح — يجب أن تكون بين 0 و${item.requestedBaseQuantity}`,
              doThis: "صحّح كميات الاعتماد لكل بند بحيث لا تتجاوز الكمية المطلوبة، ثم أعد الاعتماد",
            }),
          });
        }
        await tx
          .update(purchaseRequisitionItems)
          .set({ approvedBaseQuantity: quantity })
          .where(eq(purchaseRequisitionItems.id, item.id));
      }
      await tx
        .update(purchaseRequisitions)
        .set({
          status: "APPROVED",
          version: Number(requisition.version) + 1,
          approvedBy: actor.userId,
          approvedAt: new Date(),
        })
        .where(eq(purchaseRequisitions.id, requisition.id));
    } else {
      const [ordered] = await tx
        .select({
          total: sql<number>`COALESCE(SUM(${purchaseRequisitionItems.orderedBaseQuantity}), 0)`,
        })
        .from(purchaseRequisitionItems)
        .where(eq(purchaseRequisitionItems.requisitionId, requisition.id));
      if (Number(ordered?.total ?? 0) > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر إلغاء طلب الشراء",
            why: `كميات الطلب مربوطةٌ بأمر شراء (${Number(ordered?.total ?? 0)} وحدة) — لا يُلغى ما رُبط بمستند لاحق`,
            doThis: "افتح أمر الشراء المرتبط وعدّل كمياته أو ألغِ الأمر أوّلاً، ثم أعد الإلغاء",
          }),
        });
      }
      await tx
        .update(purchaseRequisitions)
        .set({ status: "CANCELLED", version: Number(requisition.version) + 1 })
        .where(eq(purchaseRequisitions.id, requisition.id));
    }
    await tx
      .update(purchaseRequisitionControlRequests)
      .set({
        status: "APPROVED",
        pendingGuard: null,
        reviewedBy: actor.userId,
        reviewedAt: new Date(),
        reviewReason: reason,
        appliedAt: new Date(),
      })
      .where(eq(purchaseRequisitionControlRequests.id, input.requestId));
    await recordIdempotencyKey(
      tx,
      "purchase.requisition.decide",
      input.decisionKey,
      input.requestId,
      payloadHash,
    );
    return {
      requestId: input.requestId,
      status: "APPROVED" as const,
      idempotent: false as const,
    };
  });
}

async function refreshRequisitionOrderingStatusTx(
  tx: Tx,
  requisitionId: number,
) {
  const items = await tx
    .select({
      approved: purchaseRequisitionItems.approvedBaseQuantity,
      ordered: purchaseRequisitionItems.orderedBaseQuantity,
    })
    .from(purchaseRequisitionItems)
    .where(eq(purchaseRequisitionItems.requisitionId, requisitionId));
  const approved = items.reduce((sum, item) => sum + Number(item.approved), 0);
  const ordered = items.reduce((sum, item) => sum + Number(item.ordered), 0);
  const status =
    ordered <= 0
      ? "APPROVED"
      : ordered >= approved
        ? "FULLY_ORDERED"
        : "PARTIALLY_ORDERED";
  await tx
    .update(purchaseRequisitions)
    .set({ status, version: sql`${purchaseRequisitions.version} + 1` })
    .where(eq(purchaseRequisitions.id, requisitionId));
}

/**
 * يحرر حجز طلبات الشراء عند إلغاء أمر الشراء مع إبقاء صفوف التخصيص نفسها دليلاً تاريخياً.
 * الحذف سيطمس المستند الذي اعتمد عليه القرار؛ projection orderedBaseQuantity وحده هو الذي يعود.
 */
export async function releasePurchaseOrderRevisionAllocationsTx(
  tx: Tx,
  revisionId: number,
) {
  const allocations = await tx
    .select({
      allocationId: purchaseOrderRequisitionAllocations.id,
      requisitionItemId: purchaseOrderRequisitionAllocations.requisitionItemId,
      quantity: purchaseOrderRequisitionAllocations.allocatedBaseQuantity,
    })
    .from(purchaseOrderRequisitionAllocations)
    .innerJoin(
      purchaseOrderRevisionItems,
      eq(
        purchaseOrderRequisitionAllocations.purchaseOrderRevisionItemId,
        purchaseOrderRevisionItems.id,
      ),
    )
    .where(eq(purchaseOrderRevisionItems.revisionId, revisionId))
    .orderBy(purchaseOrderRequisitionAllocations.id);
  if (allocations.length === 0) return [];

  const releasedByItem = new Map<number, number>();
  for (const allocation of allocations) {
    const itemId = Number(allocation.requisitionItemId);
    releasedByItem.set(
      itemId,
      (releasedByItem.get(itemId) ?? 0) + Number(allocation.quantity),
    );
  }
  const itemIds = Array.from(releasedByItem.keys()).sort((a, b) => a - b);
  const lockedItems = await tx
    .select({
      id: purchaseRequisitionItems.id,
      requisitionId: purchaseRequisitionItems.requisitionId,
      ordered: purchaseRequisitionItems.orderedBaseQuantity,
    })
    .from(purchaseRequisitionItems)
    .where(inArray(purchaseRequisitionItems.id, itemIds))
    .orderBy(purchaseRequisitionItems.id)
    .for("update");
  if (lockedItems.length !== itemIds.length) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر إلغاء أمر الشراء",
        why: `تخصيص الأمر يشير إلى ${itemIds.length} بنداً ووُجد ${lockedItems.length} فقط — بندٌ في طلب الشراء مفقود`,
        doThis: "أوقف الإلغاء وأبلغ الدعم الفنّي لمراجعة سجلّ التخصيصات قبل المحاولة ثانية",
      }),
    });
  }

  for (const item of lockedItems) {
    const released = releasedByItem.get(Number(item.id)) ?? 0;
    const nextOrdered = Number(item.ordered) - released;
    if (nextOrdered < 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر إلغاء أمر الشراء",
          why: `الكمية المحجوزة في طلب الشراء (${item.ordered}) أقلّ من تخصيص الأمر الملغى (${released})`,
          doThis: "أوقف الإلغاء وأبلغ الدعم الفنّي لمراجعة الحجوزات قبل المحاولة ثانية",
        }),
      });
    }
    await tx
      .update(purchaseRequisitionItems)
      .set({ orderedBaseQuantity: nextOrdered })
      .where(eq(purchaseRequisitionItems.id, item.id));
  }
  const requisitionIds = Array.from(
    new Set(lockedItems.map((item) => Number(item.requisitionId))),
  ).sort((a, b) => a - b);
  for (const requisitionId of requisitionIds) {
    await refreshRequisitionOrderingStatusTx(tx, requisitionId);
  }
  return allocations.map((allocation) => ({
    allocationId: Number(allocation.allocationId),
    requisitionItemId: Number(allocation.requisitionItemId),
    quantity: Number(allocation.quantity),
  }));
}

/** يستبدل تغطية المراجعة الحالية مع إبقاء روابط المراجعات القديمة كسجل تاريخي. */
export async function replacePurchaseOrderRevisionAllocationsTx(
  tx: Tx,
  input: {
    branchId: number;
    previousRevisionId?: number | null;
    revisionItems: Array<{ id: number; lineNo: number; baseQuantity: number }>;
    allocations?: PurchaseRevisionAllocationDraft[];
  },
) {
  const allocations = input.allocations ?? [];
  const lineByNo = new Map(
    input.revisionItems.map((line) => [line.lineNo, line]),
  );
  const newByRequisitionItem = new Map<number, number>();
  const lineTotals = new Map<number, number>();
  for (const allocation of allocations) {
    const line = lineByNo.get(allocation.lineNo);
    if (!line)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر ربط طلب الشراء بالأمر",
          why: `سطر الربط رقم ${allocation.lineNo} غير موجود في أمر الشراء`,
          doThis: "افتح شاشة الربط وتحقّق من أرقام السطور، ثم أعد الإرسال بأرقامٍ صالحة",
        }),
      });
    if (
      !Number.isInteger(allocation.allocatedBaseQuantity) ||
      allocation.allocatedBaseQuantity <= 0
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر ربط طلب الشراء بالأمر",
          why: `كمية الربط (${allocation.allocatedBaseQuantity}) غير صحيحة — يجب أن تكون عدداً صحيحاً موجباً`,
          doThis: "صحّح كميات الربط الأساسية (بأعدادٍ صحيحة موجبة) ثم أعد الإرسال",
        }),
      });
    }
    lineTotals.set(
      line.id,
      (lineTotals.get(line.id) ?? 0) + allocation.allocatedBaseQuantity,
    );
    newByRequisitionItem.set(
      allocation.requisitionItemId,
      (newByRequisitionItem.get(allocation.requisitionItemId) ?? 0) +
        allocation.allocatedBaseQuantity,
    );
  }
  for (const line of input.revisionItems) {
    if ((lineTotals.get(line.id) ?? 0) > line.baseQuantity) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر ربط طلب الشراء بالأمر",
          why: `مجموع ربط السطر ${line.lineNo} (${lineTotals.get(line.id) ?? 0}) يتجاوز كميته في الأمر (${line.baseQuantity})`,
          doThis: `اخفض مجموع الربط لهذا السطر إلى ${line.baseQuantity} أو أقلّ، ثم أعد الإرسال`,
        }),
      });
    }
  }
  const previous = input.previousRevisionId
    ? await tx
        .select({
          requisitionItemId:
            purchaseOrderRequisitionAllocations.requisitionItemId,
          quantity: purchaseOrderRequisitionAllocations.allocatedBaseQuantity,
        })
        .from(purchaseOrderRequisitionAllocations)
        .innerJoin(
          purchaseOrderRevisionItems,
          eq(
            purchaseOrderRequisitionAllocations.purchaseOrderRevisionItemId,
            purchaseOrderRevisionItems.id,
          ),
        )
        .where(
          eq(purchaseOrderRevisionItems.revisionId, input.previousRevisionId),
        )
    : [];
  const previousByRequisitionItem = new Map<number, number>();
  for (const allocation of previous) {
    const id = Number(allocation.requisitionItemId);
    previousByRequisitionItem.set(
      id,
      (previousByRequisitionItem.get(id) ?? 0) + Number(allocation.quantity),
    );
  }
  const ids = Array.from(
    new Set([
      ...Array.from(previousByRequisitionItem.keys()),
      ...Array.from(newByRequisitionItem.keys()),
    ]),
  ).sort((a, b) => a - b);
  if (ids.length) {
    const lockedItems = await tx
      .select({
        id: purchaseRequisitionItems.id,
        requisitionId: purchaseRequisitionItems.requisitionId,
        variantId: purchaseRequisitionItems.variantId,
        productUnitId: purchaseRequisitionItems.productUnitId,
        approved: purchaseRequisitionItems.approvedBaseQuantity,
        ordered: purchaseRequisitionItems.orderedBaseQuantity,
        branchId: purchaseRequisitions.branchId,
        status: purchaseRequisitions.status,
      })
      .from(purchaseRequisitionItems)
      .innerJoin(
        purchaseRequisitions,
        eq(purchaseRequisitionItems.requisitionId, purchaseRequisitions.id),
      )
      .where(inArray(purchaseRequisitionItems.id, ids))
      .orderBy(purchaseRequisitionItems.id)
      .for("update");
    if (lockedItems.length !== ids.length) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر ربط طلب الشراء بالأمر",
          why: `طُلب ربط ${ids.length} بنداً ووُجد ${lockedItems.length} فقط — أحد بنود طلبات الشراء المرتبطة غير موجود`,
          doThis: "أعد تحميل شاشة أمر الشراء وشاشة طلبات الشراء، ثم أعد الربط بالبنود المتاحة الحالية",
        }),
      });
    }
    const revisionItemByLine = new Map(
      input.revisionItems.map((line) => [line.lineNo, line]),
    );
    const revisionRows = await tx
      .select({
        id: purchaseOrderRevisionItems.id,
        variantId: purchaseOrderRevisionItems.variantId,
        productUnitId: purchaseOrderRevisionItems.productUnitId,
      })
      .from(purchaseOrderRevisionItems)
      .where(
        inArray(
          purchaseOrderRevisionItems.id,
          input.revisionItems.map((line) => line.id),
        ),
      );
    const revisionShape = new Map(
      revisionRows.map((row) => [Number(row.id), row]),
    );
    for (const item of lockedItems) {
      if (Number(item.branchId) !== input.branchId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذّر ربط طلب الشراء بالأمر",
            why: `الطلب في فرعٍ (${item.branchId}) مختلف عن أمر الشراء (${input.branchId}) — الربط داخل الفرع الواحد`,
            doThis: "اختر طلب شراء من نفس فرع أمر الشراء، أو أنشئ أمراً آخر لفرع الطلب",
          }),
        });
      }
      if (
        newByRequisitionItem.has(Number(item.id)) &&
        !["APPROVED", "PARTIALLY_ORDERED", "FULLY_ORDERED"].includes(
          item.status,
        )
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر ربط طلب الشراء بالأمر",
            why: `حالة الطلب ${item.status} — الربط مسموحٌ لطلبٍ معتمد أو جزئيّ الأمر أو مكتمل الأمر فقط`,
            doThis: "أرسل الطلب واعتمده أوّلاً، ثم أعد ربطه بأمر الشراء",
          }),
        });
      }
      const released = previousByRequisitionItem.get(Number(item.id)) ?? 0;
      const added = newByRequisitionItem.get(Number(item.id)) ?? 0;
      const nextOrdered = Number(item.ordered) - released + added;
      if (nextOrdered < 0 || nextOrdered > Number(item.approved)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر ربط طلب الشراء بالأمر",
            why: `الربط الجديد يجعل المحجوز (${nextOrdered}) خارج المدى المسموح — يجب أن يبقى بين 0 والكمية المعتمدة (${item.approved})`,
            doThis: "اخفض كمية الربط، أو ألغِ الربط السابق قبل زيادة الحجز على نفس البند",
          }),
        });
      }
      await tx
        .update(purchaseRequisitionItems)
        .set({ orderedBaseQuantity: nextOrdered })
        .where(eq(purchaseRequisitionItems.id, item.id));
    }
    for (const allocation of allocations) {
      const line = revisionItemByLine.get(allocation.lineNo)!;
      const revisionRow = revisionShape.get(line.id)!;
      const requisitionItem = lockedItems.find(
        (item) => Number(item.id) === allocation.requisitionItemId,
      )!;
      if (
        Number(revisionRow.variantId) !== Number(requisitionItem.variantId) ||
        (requisitionItem.productUnitId != null &&
          Number(revisionRow.productUnitId) !==
            Number(requisitionItem.productUnitId))
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر ربط طلب الشراء بالأمر",
            why: `صنف/وحدة سطر أمر الشراء لا تُطابق بند الطلب: منتج الأمر ${revisionRow.variantId} وطلب ${requisitionItem.variantId}`,
            doThis: "غيّر البند المختار للربط، أو أنشئ سطراً جديداً في أمر الشراء يُطابق الصنف والوحدة",
          }),
        });
      }
      await tx.insert(purchaseOrderRequisitionAllocations).values({
        purchaseOrderRevisionItemId: line.id,
        requisitionItemId: allocation.requisitionItemId,
        allocatedBaseQuantity: allocation.allocatedBaseQuantity,
      });
    }
    const affectedRequisitions = Array.from(
      new Set(lockedItems.map((item) => Number(item.requisitionId))),
    );
    for (const requisitionId of affectedRequisitions) {
      await refreshRequisitionOrderingStatusTx(tx, requisitionId);
    }
  }
}

export async function hasCompleteRequisitionCoverageTx(
  tx: Tx,
  revisionId: number,
) {
  const lines = await tx
    .select({
      id: purchaseOrderRevisionItems.id,
      baseQuantity: purchaseOrderRevisionItems.baseQuantity,
      allocated: sql<number>`COALESCE(SUM(${purchaseOrderRequisitionAllocations.allocatedBaseQuantity}), 0)`,
    })
    .from(purchaseOrderRevisionItems)
    .leftJoin(
      purchaseOrderRequisitionAllocations,
      eq(
        purchaseOrderRequisitionAllocations.purchaseOrderRevisionItemId,
        purchaseOrderRevisionItems.id,
      ),
    )
    .where(eq(purchaseOrderRevisionItems.revisionId, revisionId))
    .groupBy(
      purchaseOrderRevisionItems.id,
      purchaseOrderRevisionItems.baseQuantity,
    );
  return (
    lines.length > 0 &&
    lines.every((line) => Number(line.allocated) === Number(line.baseQuantity))
  );
}

export async function listPurchaseRequisitions(
  input: {
    branchId?: number;
    status?: (typeof purchaseRequisitions.$inferSelect)["status"];
    limit?: number;
  },
  actor: Actor,
) {
  const branchId = actor.role === "admin" ? input.branchId : actor.branchId;
  if (branchId == null)
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر عرض قائمة طلبات الشراء",
        why: "حسابك بلا فرعٍ مُسنَد، وقائمة الطلبات تُصفَّى بالفرع",
        doThis: "اطلب من المدير إسناد فرعٍ لحسابك ثم أعد الدخول",
      }),
    });
  return requireDb()
    .select()
    .from(purchaseRequisitions)
    .where(
      and(
        eq(purchaseRequisitions.branchId, branchId),
        input.status
          ? eq(purchaseRequisitions.status, input.status)
          : undefined,
      ),
    )
    .orderBy(desc(purchaseRequisitions.id))
    .limit(Math.min(input.limit ?? 100, 200));
}

export async function getPurchaseRequisition(
  requisitionId: number,
  actor: Actor,
) {
  const db = requireDb();
  const [requisition] = await db
    .select()
    .from(purchaseRequisitions)
    .where(eq(purchaseRequisitions.id, requisitionId))
    .limit(1);
  if (!requisition)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر متابعة العملية",
        why: `طلب الشراء بالرقم ${requisitionId} غير موجود — قد يكون حُذف أو الرقم مغلوط`,
        doThis: "افتح قائمة طلبات الشراء واختر الطلب من هناك، أو تحقّق من رقمه",
      }),
    });
  assertBranch(Number(requisition.branchId), actor);
  const [items, requests] = await Promise.all([
    db
      .select()
      .from(purchaseRequisitionItems)
      .where(eq(purchaseRequisitionItems.requisitionId, requisitionId))
      .orderBy(purchaseRequisitionItems.lineNo),
    db
      .select()
      .from(purchaseRequisitionControlRequests)
      .where(
        eq(purchaseRequisitionControlRequests.requisitionId, requisitionId),
      )
      .orderBy(desc(purchaseRequisitionControlRequests.id)),
  ]);
  return { ...requisition, items, requests };
}

export async function listPendingPurchaseRequisitionControls(
  actor: Actor,
  page: { limit: number; cursor?: number | null },
) {
  const branchCondition =
    actor.role === "admin"
      ? undefined
      : eq(purchaseRequisitionControlRequests.branchId, actor.branchId);
  return requireDb()
    .select({
      id: purchaseRequisitionControlRequests.id,
      requestKey: purchaseRequisitionControlRequests.requestKey,
      requisitionId: purchaseRequisitionControlRequests.requisitionId,
      requisitionNumber: purchaseRequisitions.requisitionNumber,
      branchId: purchaseRequisitionControlRequests.branchId,
      kind: purchaseRequisitionControlRequests.kind,
      status: purchaseRequisitionControlRequests.status,
      reason: purchaseRequisitionControlRequests.reason,
      baseVersion: purchaseRequisitionControlRequests.baseVersion,
      requestedBy: purchaseRequisitionControlRequests.requestedBy,
      requestedAt: purchaseRequisitionControlRequests.requestedAt,
      creatorId: purchaseRequisitions.createdBy,
      submittedBy: purchaseRequisitions.submittedBy,
      requisitionVersion: purchaseRequisitions.version,
      requisitionStatus: purchaseRequisitions.status,
    })
    .from(purchaseRequisitionControlRequests)
    .innerJoin(
      purchaseRequisitions,
      eq(
        purchaseRequisitionControlRequests.requisitionId,
        purchaseRequisitions.id,
      ),
    )
    .where(
      and(
        eq(purchaseRequisitionControlRequests.status, "PENDING"),
        branchCondition,
        page.cursor == null
          ? undefined
          : lt(purchaseRequisitionControlRequests.id, page.cursor),
      ),
    )
    .orderBy(desc(purchaseRequisitionControlRequests.id))
    .limit(page.limit + 1);
}
