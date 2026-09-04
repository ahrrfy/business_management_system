import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, like, lt, sql } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
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
        what: "تعذّرت إدارة طلب الشراء",
        why: "الطلب يخصّ فرعاً غير فرعك المُسنَد، وعبور الفروع محصورٌ بـ**مدير النظام (admin)** — لا مديرَ فرعٍ عاديٍّ (`manager`)",
        doThis: "أدر الطلب من داخل الفرع الصحيح، أو اطلب من مدير النظام (admin) التنفيذ نيابةً",
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
        what: "تعذّر إنشاء طلب الشراء",
        why: "الغرض المُدخَل خارج المدى المسموح (3-500 محرفاً) — إمّا فارغ أو أقل من ثلاثة أحرف",
        doThis: "اكتب في حقل «الغرض» شرحاً مقتضباً لما يُشترى ولماذا، بين 3 و500 محرفاً",
      }),
    });
  }
  if (!input.items.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إنشاء طلب الشراء",
        why: "الطلب وصل بلا أيّ صنف في قائمة البنود",
        doThis: "أضف صنفاً واحداً على الأقل في جدول البنود، بكميّته المطلوبة، قبل الحفظ",
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
          what: "تعذّر إنشاء طلب الشراء",
          why: "أحد بنود الطلب يحمل كميّةً غير موجبة أو ليست عدداً صحيحاً (كمّية الأساس تُخزَّن بالوحدة الصغرى)",
          doThis: "افتح البند المتضرِّر واكتب كميّةً صحيحة أكبر من صفر بالوحدة المختارة",
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
          what: "تعذّر إنشاء طلب الشراء",
          why: "أحد بنود الطلب بلا مبرِّرٍ نصّيّ، أو مبرِّرُه خارج المدى المسموح (3-500 محرفاً)",
          doThis: "افتح البند المتضرِّر واكتب في حقل «المبرِّر» جملةً تشرح سبب طلب الصنف",
        }),
      });
    }
    const key = `${item.variantId}:${item.productUnitId ?? 0}`;
    if (seen.has(key)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إنشاء طلب الشراء",
          why: "الصنف نفسه بالوحدة نفسها ظهر أكثر من مرّة في بنود الطلب",
          doThis: "ادمج التكرار في بندٍ واحد بمجموع الكمّية، أو استعمل وحدةً مختلفة للسطر الآخر",
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
          what: "تعذّرت معالجة طلب الشراء",
          why: "الفرع المستهدف بمعرّفه غير موجود، إمّا حُذف أو أُدخل بمعرّفٍ غير صحيح",
          doThis: "افتح شاشة الفروع وتحقّق أنّ الفرع قائم، ثمّ أعد اختياره من القائمة",
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
          why: "الإعدادات تغيّرت في جهةٍ أخرى بين لحظة فتحك الشاشة ولحظة الحفظ (رقم النسخة لا يطابق)",
          doThis: "حدّث الصفحة لتحميل الإعدادات الحاليّة، ثمّ أعد إدخال تعديلاتك عليها",
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
          what: "تعذّرت معالجة طلب الشراء",
          why: "الفرع المستهدف بمعرّفه غير موجود، إمّا حُذف أو أُدخل بمعرّفٍ غير صحيح",
          doThis: "افتح شاشة الفروع وتحقّق أنّ الفرع قائم، ثمّ أعد اختياره من القائمة",
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
          what: "تعذّر فتح طلب الشراء",
          why: "الطلب المطلوب بمعرّفه غير موجود، إمّا حُذف أو أُدخل معرّفٌ غير صحيح",
          doThis: "ارجع لقائمة طلبات الشراء واختر الطلب من القائمة بدل تحرير المعرّف يدوياً",
        }),
      });
    assertBranch(Number(requisition.branchId), actor);
    if (Number(requisition.branchId) !== input.branchId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تعديل طلب الشراء",
          why: "الطلب أُنشئ في فرعٍ آخر ومحاولة التعديل تحاول نقله لفرعٍ جديد، والنقل غير مسموح",
          doThis: "أبقِ الفرع كما هو في الأصل، أو ارفض الطلب وأنشئ آخرَ في الفرع الجديد",
        }),
      });
    }
    if (requisition.status !== "DRAFT" && requisition.status !== "REJECTED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تعديل طلب الشراء",
          why: "الطلب ليس بحالة «مسودة» ولا «مرفوض» — لا يُعدَّل الطلب بعد إرساله للاعتماد",
          doThis: "ارجع لقائمة طلبات الشراء ورشّح على «مسودة/مرفوض» لعرض ما يقبل التعديل",
        }),
      });
    }
    if (Number(requisition.version) !== input.expectedVersion) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر حفظ تعديل طلب الشراء",
          why: "الطلب تغيّر في جهةٍ أخرى بين لحظة فتحك الشاشة ولحظة الحفظ (رقم النسخة لا يطابق)",
          doThis: "حدّث الصفحة لتحميل النسخة الحاليّة من الطلب، ثمّ أعد إدخال تعديلاتك عليها",
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
        what: "تعذّر إنشاء طلب قرار الاعتماد/الإلغاء",
        why: "السبب المُدخَل خارج المدى المسموح (3-500 محرفاً) — إمّا فارغ أو أقل من ثلاثة أحرف",
        doThis: "اكتب في حقل «السبب» جملةً تشرح للمُعتَمِد لماذا الاعتماد أو الإلغاء، بين 3 و500 محرفاً",
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
        what: "تعذّر فتح طلب الشراء",
        why: "الطلب المطلوب بمعرّفه غير موجود، إمّا حُذف أو أُدخل معرّفٌ غير صحيح",
        doThis: "ارجع لقائمة طلبات الشراء واختر الطلب من القائمة بدل تحرير المعرّف يدوياً",
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
          why: "نفس مفتاح الطلب مسجَّل قبل قليل بحمولةٍ مختلفة (طلبُ شراءٍ آخر أو نوع قرارٍ آخر)",
          doThis: "حدّث الشاشة ليُولَّد مفتاحٌ جديد، ثمّ أعد الحفظ بالبيانات المعروضة أمامك",
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
        what: "تعذّر تسجيل طلب القرار",
        why: "طلب الشراء تغيّر في جهةٍ أخرى بين لحظة فتحك الشاشة ولحظة الحفظ (رقم النسخة لا يطابق)",
        doThis: "حدّث الصفحة لتحميل النسخة الحاليّة من طلب الشراء، ثمّ أعد تسجيل طلب القرار عليها",
      }),
    });
  }
  if (input.kind === "APPROVE" && requisition.status !== "SUBMITTED") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر طلب اعتماد طلب الشراء",
        why: "الطلب ليس بحالة «مُرسَل» — لا يُطلب اعتمادٌ لطلبٍ ما زال مسودةً أو مرفوضاً أو مُعتَمَداً",
        doThis: "افتح الطلب واضغط «إرسال» أوّلاً ليصبح جاهزاً للاعتماد، ثمّ اطلب الاعتماد",
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
        what: "تعذّر طلب إلغاء طلب الشراء",
        why: "الطلب في حالةٍ لا تقبل الإلغاء (مطلوب أن يكون مسودة أو مُرسَلاً أو معتمداً أو مطلوباً جزئياً)",
        doThis: "افتح الطلب لعرض حالته، ثمّ اتّخذ الإجراء المناسب لحالته (رفض/تعديل/إغلاق)",
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
          why: "بنودُ الطلب مربوطة بأمر شراءٍ قائم بكميّاتٍ مطلوبة بالفعل، والإلغاء يترك أمر الشراء بلا مصدر",
          doThis: "افتح أمر الشراء المرتبط وعدّله أو ألغِه أوّلاً، ثمّ ألغِ طلب الشراء",
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
          what: "تعذّر فتح طلب الشراء",
          why: "الطلب المطلوب بمعرّفه غير موجود، إمّا حُذف أو أُدخل معرّفٌ غير صحيح",
          doThis: "ارجع لقائمة طلبات الشراء واختر الطلب من القائمة بدل تحرير المعرّف يدوياً",
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
            why: "نفس مفتاح الطلب مسجَّل قبل قليل بحمولةٍ مختلفة (طلبٌ آخر أو سببٌ مختلف)",
            doThis: "حدّث الشاشة ليُولَّد مفتاحٌ جديد، ثمّ أعد الإرسال بالبيانات المعروضة أمامك",
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
          what: "تعذّر إرسال طلب الشراء",
          why: "الطلب ليس بحالة «مسودة» — لا يُرسل طلبٌ سبق إرساله أو اعتماده",
          doThis: "ارجع لقائمة طلبات الشراء ورشّح على «مسودة» لعرض ما يقبل الإرسال",
        }),
      });
    }
    if (Number(requisition.version) !== input.expectedVersion) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر حفظ تعديل طلب الشراء",
          why: "الطلب تغيّر في جهةٍ أخرى بين لحظة فتحك الشاشة ولحظة الحفظ (رقم النسخة لا يطابق)",
          doThis: "حدّث الصفحة لتحميل النسخة الحاليّة من الطلب، ثمّ أعد إدخال تعديلاتك عليها",
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
          what: "تعذّر إرسال طلب الشراء",
          why: "الطلب لا يحوي أيّ بند — لا يوجد ما يُطلب اعتمادُه",
          doThis: "افتح تعديل الطلب وأضف صنفاً واحداً على الأقل بكميّته، ثمّ احفظ وأعد الإرسال",
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
        what: "تعذّر فتح طلب قرار الاعتماد",
        why: "طلب القرار المطلوب بمعرّفه غير موجود، إمّا حُذف أو حُسم من جهةٍ أخرى",
        doThis: "ارجع لقائمة طلبات القرار واختر الطلب من القائمة لعرض حالته الحاليّة",
      }),
    });
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حسم طلب قرار الاعتماد",
        why: "سبب القرار المُدخَل خارج المدى المسموح (3-500 محرفاً) — إمّا فارغ أو أقل من ثلاثة أحرف",
        doThis: "اكتب في حقل «السبب» جملةً واضحة تشرح للطالب سبب الاعتماد أو الرفض، بين 3 و500 محرفاً",
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
          what: "تعذّر فتح طلب الشراء",
          why: "الطلب المطلوب بمعرّفه غير موجود، إمّا حُذف أو أُدخل معرّفٌ غير صحيح",
          doThis: "ارجع لقائمة طلبات الشراء واختر الطلب من القائمة بدل تحرير المعرّف يدوياً",
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
          what: "تعذّر معالجة طلب قرار الاعتماد",
          why: "طلب القرار المطلوب بمعرّفه غير موجود، إمّا حُذف أو حُسم بين لحظة الفتح والحفظ",
          doThis: "ارجع لقائمة طلبات القرار وحدّثها، ثمّ افتح الطلب المطلوب من جديد",
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
            what: "تعذّر حسم طلب قرار الاعتماد",
            why: "مفتاح القرار الذي أرسلته الشاشة سبق استعمالُه على طلبٍ آخر",
            doThis: "حدّث الشاشة ليُولَّد مفتاح قرارٍ جديد، ثمّ أعد الحسم على الطلب المعروض أمامك",
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
          what: "تعذّر حسم طلب قرار الاعتماد",
          why: "الطلب حُسم مسبقاً (اعتماداً أو رفضاً)، وحسم القرار لا يتكرّر",
          doThis: "ارجع لقائمة طلبات القرار وحدّثها لعرض النتيجة المسجَّلة",
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
              what: "تعذّر اعتماد طلب الشراء",
              why: "أنت أنشأت الطلب أو أرسلتَه أو طلبت القرار — فصل المهام يمنع اعتمادَك القرارَ الذي أنت طرفٌ فيه",
              doThis: "اطلب من مديرٍ أو مستخدمٍ آخر اعتماد الطلب من صفحة طلبات الاعتماد",
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
              what: "تعذّر اعتماد طلب الشراء",
              why: "كمّية اعتماد أحد البنود ليست عدداً صحيحاً بين صفر والكمّية المطلوبة",
              doThis: "افتح شاشة الاعتماد وعدّل الكمّية لتكون بين 0 والكمّية المطلوبة، ثمّ أعد الاعتماد",
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
            why: "بنودُ الطلب مربوطة بأمر شراءٍ قائم بكميّاتٍ مطلوبة بالفعل، والإلغاء يترك أمر الشراء بلا مصدر",
            doThis: "افتح أمر الشراء المرتبط وعدّله أو ألغِه أوّلاً، ثمّ ألغِ طلب الشراء",
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
        what: "تعذّر إلغاء تخصيصات أمر الشراء",
        why: "التخصيص المُلغى يشير إلى بند طلب شراءٍ لم يعد موجوداً في قاعدة البيانات",
        doThis: "أوقف مسار الإلغاء واطلب من المدير مراجعة سجلّ التدقيق للبحث عن البند المفقود",
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
          what: "تعذّر تحرير الكمّية المحجوزة",
          why: "الكمّية المطلوبة على بند طلب الشراء أقلّ من الكمّية المُخصَّصة على أمر الشراء الملغى — البيانات غير متسقة",
          doThis: "أوقف مسار الإلغاء واطلب من المدير مراجعة سجلّ التدقيق لطلب الشراء وأمر الشراء المرتبط به",
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
          what: "تعذّر ربط طلب الشراء بأمر الشراء",
          why: `سطر الربط رقم ${allocation.lineNo} لا يقابله سطرٌ في أمر الشراء المُرسَل`,
          doThis: "أعد فتح شاشة الربط وتحقّق من أرقام أسطر أمر الشراء، ثمّ اربط على السطر الموجود",
        }),
      });
    if (
      !Number.isInteger(allocation.allocatedBaseQuantity) ||
      allocation.allocatedBaseQuantity <= 0
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر ربط طلب الشراء بأمر الشراء",
          why: "كمّية الربط الأساسية على أحد الأسطر ليست عدداً صحيحاً موجباً (تُخزَّن بالوحدة الصغرى)",
          doThis: "افتح شاشة الربط وعدّل الكمّية لتكون عدداً صحيحاً أكبر من صفر",
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
          what: "تعذّر ربط طلب الشراء بأمر الشراء",
          why: `مجموع كميّات الربط على السطر رقم ${line.lineNo} يتجاوز الكمّية المطلوبة على أمر الشراء`,
          doThis: "افتح شاشة الربط وخفّض الكميات على السطر ليصير مجموعها ≤ الكمّية على أمر الشراء",
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
          what: "تعذّر ربط طلب الشراء بأمر الشراء",
          why: "أحد بنود طلب الشراء المشار إليه لم يعد موجوداً في قاعدة البيانات (قد يكون حُذف)",
          doThis: "أعد فتح شاشة الربط وحدّثها، ثمّ أعد اختيار البنود من قائمة طلب الشراء الحاليّة",
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
            what: "تعذّر ربط طلب الشراء بأمر الشراء",
            why: "طلب الشراء المُختار يخصّ فرعاً غير فرع أمر الشراء، والربط لا يعبر الفروع",
            doThis: "اختر طلب شراءٍ من نفس فرع أمر الشراء، أو أنشئ طلباً جديداً في الفرع الصحيح",
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
            what: "تعذّر ربط طلب الشراء بأمر الشراء",
            why: "طلب الشراء المُختار ليس معتمَداً (ولا مطلوباً جزئياً أو كلياً)، والربط لا يقبل مسودةً ولا مُرسَلاً",
            doThis: "اطلب من المدير اعتماد طلب الشراء أوّلاً من قائمة طلبات الاعتماد، ثمّ أعد الربط",
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
            what: "تعذّر ربط طلب الشراء بأمر الشراء",
            why: "الكمّية الجديدة ستجعل مجموع الكمّيات المرتبطة على البند أكبر من كمّيته المعتمدة أو أقلّ من صفر",
            doThis: "افتح شاشة الربط وخفّض الكمّية على البند، أو اعتمد كمّيةً أكبر على طلب الشراء أوّلاً",
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
            what: "تعذّر ربط طلب الشراء بأمر الشراء",
            why: "الصنف أو الوحدة على بند طلب الشراء لا يطابق الصنف أو الوحدة على سطر أمر الشراء",
            doThis: "افتح شاشة الربط واختر بنداً يطابق الصنف والوحدة على سطر أمر الشراء، أو أضف بنداً جديداً لأمر الشراء",
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
        what: "تعذّر عرض طلبات الشراء",
        why: "الجلسة الحاليّة بلا فرعٍ مُسنَد، والاطّلاع محصورٌ بفرع المستخدم",
        doThis: "اخرج ثم ادخل بمستخدمٍ له فرعٌ مُسنَد، أو اطلب من المدير تحديد فرعك من شاشة المستخدمين",
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
        what: "تعذّر فتح طلب الشراء",
        why: "الطلب المطلوب بمعرّفه غير موجود، إمّا حُذف أو أُدخل معرّفٌ غير صحيح",
        doThis: "ارجع لقائمة طلبات الشراء واختر الطلب من القائمة بدل تحرير المعرّف يدوياً",
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
