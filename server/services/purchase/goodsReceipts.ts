import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, like, sql } from "drizzle-orm";
import {
  branchStock,
  goodsReceiptItems,
  goodsReceiptReversalItems,
  goodsReceiptReversalRequestItems,
  goodsReceiptReversalRequests,
  goodsReceiptReversals,
  goodsReceipts,
  productVariants,
  products,
  purchaseOrderItems,
  purchaseOrderRevisionItems,
  purchaseOrderRevisions,
  purchaseOrders,
  supplierInvoiceMatchAllocations,
  supplierInvoiceMatchRuns,
  supplierInvoices,
  suppliers,
} from "../../../drizzle/schema";
import { goodsReceiptReversalTrigger } from "@shared/approvalTriggers";
import { appErrorMessage } from "@shared/errors";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { assertApprover, resolveApprovalActor } from "../approval/ownerGate";
import { applyMovement, ensureBranchStockRows } from "../inventoryService";
import { lockInventoryVariants } from "../inventory/stockLock";
import { money, round2, toDateStr, toDbMoney } from "../money";
import { assertPeriodOpen } from "../periodLockService";
import { withTx, type Actor } from "../tx";
import {
  postGoodsReceiptGrniTx,
  postGoodsReceiptReversalTx,
  sha256,
  stableCanonical,
} from "./grniAccounting";
import { assertPurchaseBranch } from "./internal";
import { payloadHashMatches } from "../idempotency";

export interface CreateGoodsReceiptInput {
  purchaseOrderId: number;
  purchaseOrderRevisionId: number;
  expectedOrderVersion: number;
  clientRequestId: string;
  supplierDeliveryNote?: string | null;
  receivedAt?: Date;
  notes?: string | null;
  lines: Array<{
    purchaseOrderItemId: number;
    acceptedBaseQuantity: number;
    rejectedBaseQuantity?: number;
    rejectionReason?: string | null;
  }>;
}

export interface RequestGoodsReceiptReversalInput {
  goodsReceiptId: number;
  expectedReceiptVersion: number;
  requestKey: string;
  reason: string;
  lines: Array<{
    goodsReceiptItemId: number;
    baseQuantity: number;
    reason?: string | null;
  }>;
}

export interface DecideGoodsReceiptReversalInput {
  requestId: number;
  decisionKey: string;
  action: "APPROVE" | "REJECT";
  reviewReason: string;
}

export function finalResidualCurrencyAmount(
  lineTotal: string | number | Decimal,
  baseQuantity: number,
  acceptedQuantity: number,
  priorReceived: string | number | Decimal,
  finalAccepted: boolean,
): Decimal {
  if (acceptedQuantity === 0) return money(0);
  return finalAccepted
    ? round2(money(lineTotal).minus(priorReceived))
    : round2(money(lineTotal).times(acceptedQuantity).dividedBy(baseQuantity));
}

export function cumulativeQuantityCurrencyDelta(
  lineTotal: string | number | Decimal,
  baseQuantity: number,
  priorQuantity: number,
  quantity: number,
): Decimal {
  const total = money(lineTotal);
  const cumulative = priorQuantity + quantity;
  const before =
    priorQuantity === 0
      ? money(0)
      : round2(total.times(priorQuantity).dividedBy(baseQuantity));
  const after =
    cumulative === baseQuantity
      ? total
      : round2(total.times(cumulative).dividedBy(baseQuantity));
  return round2(after.minus(before));
}

function requireText(
  value: string | null | undefined,
  label: string,
  max: number,
): string {
  const normalized = value?.trim() ?? "";
  if (!normalized)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: `تعذّر إتمام العملية: ${label} مطلوب`,
        why: "الحقل وصل فارغاً — إمّا لم يُملأ في الشاشة وإمّا لم تُرسله الشاشة",
        doThis: `املأ «${label}» ثمّ أعِد الإرسال؛ وإن لم يكن للحقل مكانٌ في الشاشة فأعِد تحميلها وأبلِغ مسؤول النظام إن تكرّر`,
      }),
    });
  if (normalized.length > max) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: `تعذّر إتمام العملية: ${label} أطول من المسموح`,
        why: `الحدّ ${max} محرفاً والمُرسَل ${normalized.length}`,
        doThis: `اختصر «${label}» إلى ${max} محرفاً فأقلّ ثمّ أعِد الإرسال`,
      }),
    });
  }
  return normalized;
}

function uniquePositiveIds(values: number[], label: string): void {
  const seen = new Set<number>();
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر إتمام العملية: ${label} غير صالح`,
          why: `المعرّف المُرسَل (${value}) ليس رقماً موجباً — يبدو أنّ الشاشة تحمل قائمةً قديمة`,
          doThis: "أعِد تحميل الشاشة واختر البنود من جدولها الحالي ثمّ أعِد الإرسال",
        }),
      });
    }
    if (seen.has(value)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر إتمام العملية: ${label} مكرَّر`,
          why: `البند رقم ${value} مُدرَجٌ مرّتين، والبند الواحد يُعالَج في سطرٍ واحد كي لا تُحتسَب كمّيته مرّتين`,
          doThis: "ادمج السطرين المكرَّرين في سطرٍ واحد بمجموع كمّيتهما ثمّ أعِد الإرسال",
        }),
      });
    }
    seen.add(value);
  }
}

async function nextDocumentNumber(
  tx: Tx,
  table: typeof goodsReceipts | typeof goodsReceiptReversals,
  column:
    | typeof goodsReceipts.receiptNumber
    | typeof goodsReceiptReversals.reversalNumber,
  prefixName: "GRN" | "GRR",
  branchId: number,
): Promise<string> {
  const ymd = toDateStr().replaceAll("-", "");
  const prefix = `${prefixName}-${branchId}-${ymd}-`;
  const lockName = `numbering:${prefixName.toLowerCase()}:${branchId}:${ymd}`;
  const lockResult: any = await tx.execute(
    sql`SELECT GET_LOCK(${lockName}, 5) AS locked`,
  );
  const locked = Array.isArray(lockResult)
    ? lockResult[0]?.[0]
    : lockResult?.rows?.[0];
  if (Number(locked?.locked) !== 1)
    throw new Error(`numbering lock timeout for ${lockName}`);
  try {
    const rows = await tx
      .select({ value: column })
      .from(table as any)
      .where(like(column as any, `${prefix}%`))
      .orderBy(asc((table as any).id))
      .for("update");
    let max = 0;
    for (const row of rows) {
      const suffix = String(row.value ?? "").slice(prefix.length);
      if (/^[0-9]+$/.test(suffix)) max = Math.max(max, Number(suffix));
    }
    return `${prefix}${String(max + 1).padStart(5, "0")}`;
  } finally {
    await tx.execute(sql`SELECT RELEASE_LOCK(${lockName})`);
  }
}

async function lockOrderAndRevision(
  tx: Tx,
  purchaseOrderId: number,
  actor: Actor,
) {
  const po = (
    await tx
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, purchaseOrderId))
      .for("update")
      .limit(1)
  )[0];
  if (!po)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر استلام البضاعة",
        why: `أمر الشراء رقم ${purchaseOrderId} غير موجود — يبدو أنه حُذف أو أنّ الرابط قديم`,
        doThis: "افتح الأمر من قائمة المشتريات وأعِد الاستلام منه؛ وإن كان الأمر ملغى فأنشئ أمراً جديداً بالبضاعة الواصلة",
      }),
    });
  assertPurchaseBranch(po, actor);
  const supplier = (
    await tx
      // `name` للرسالة وحدها: «المورد غير موجود أو غير نشط» بلا اسمٍ تترك السائق واقفاً
      // والموظّف يبحث عن أيّ مورّدٍ يقصد النظام قبل أن يعرف من يُفعّله.
      .select({ id: suppliers.id, isActive: suppliers.isActive, name: suppliers.name })
      .from(suppliers)
      .where(eq(suppliers.id, Number(po.supplierId)))
      .for("update")
      .limit(1)
  )[0];
  if (!supplier || !supplier.isActive) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: `تعذّر استلام بضاعة أمر الشراء ${po.poNumber}`,
        why: supplier
          ? `مورّد الأمر «${supplier.name}» موقوف، والموقوف لا تُستلَم بضاعته ولا تُحمَّل عليه ذمّة`
          : `مورّد الأمر (رقم ${Number(po.supplierId)}) لم يعد موجوداً في السجلّ`,
        doThis: supplier
          ? "أعِد تفعيل المورّد من صفحة الموردين ثمّ استلم، أو أوقف الاستلام حتى يُحسَم سبب إيقافه"
          : "أنشئ المورّد من صفحة الموردين وأعِد إصدار أمر شراءٍ عليه — لا تُستلَم بضاعةٌ بلا طرفٍ تُنسَب إليه ذمّتها",
      }),
    });
  }
  if (po.approvedRevisionId == null) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: `تعذّر استلام بضاعة أمر الشراء ${po.poNumber}`,
        why: "لا نسخة معتمَدة للأمر بعد، والاستلام يُقاس على نسخةٍ معتمَدة (كمّياتٍ وأسعاراً) لا على مسوّدة",
        doThis: "اطلب من المخوَّل اعتماد الأمر من قائمة المشتريات، ثمّ أعِد الاستلام؛ وسجِّل وصول البضاعة على ورقة المورّد ريثما يُعتمَد",
      }),
    });
  }
  const revision = (
    await tx
      .select()
      .from(purchaseOrderRevisions)
      .where(eq(purchaseOrderRevisions.id, Number(po.approvedRevisionId)))
      .for("update")
      .limit(1)
  )[0];
  if (!revision || Number(revision.purchaseOrderId) !== purchaseOrderId) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: `تعذّر استلام بضاعة أمر الشراء ${po.poNumber}`,
        why: `النسخة المعتمَدة المسجَّلة على الأمر (رقم ${Number(po.approvedRevisionId)}) مفقودة أو تخصّ أمراً آخر`,
        doThis: "أعِد اعتماد الأمر ليُثبَّت له نسخةٌ سليمة ثمّ استلم؛ وإن تكرّر الرفض بعد الاعتماد فأبلِغ مسؤول النظام برقم الأمر",
      }),
    });
  }
  return { po, revision };
}

export async function createGoodsReceiptInTx(
  tx: Tx,
  input: CreateGoodsReceiptInput,
  actor: Actor,
  options: {
    /**
     * Internal-only bridge for the atomic invoice-posting facade. The outer
     * purchase-order approval is the independent checker, so its approver may
     * materialize the deterministic GRN in the same transaction. This never
     * permits the purchase-order creator to receive their own order.
     */
    allowPurchaseOrderApproverForAutomaticPosting?: boolean;
  } = {},
) {
  const requestKey = requireText(input.clientRequestId, "مفتاح الطلب", 120);
  if (
    !Number.isSafeInteger(input.expectedOrderVersion) ||
    input.expectedOrderVersion <= 0
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر استلام البضاعة",
        why: `رقم نسخة الأمر المتوقَّعة (${input.expectedOrderVersion}) غير صالح — لم تُرسله الشاشة كما يجب`,
        doThis: "أعِد تحميل شاشة الاستلام من صفحة أمر الشراء وأعِد إدخال الكمّيات؛ وإن تكرّر فأبلِغ مسؤول النظام برقم الأمر",
      }),
    });
  }
  if (!input.lines.length)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حفظ إذن الاستلام",
        why: "لا بند فيه — والإذن مستندٌ يشهد بوصول بضاعةٍ بعينها",
        doThis: "أضف بند استلام واحداً على الأقل بكمّيته الواصلة ثمّ احفظ",
      }),
    });
  const maxLines = options.allowPurchaseOrderApproverForAutomaticPosting
    ? 500
    : 50;
  if (input.lines.length > maxLines) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حفظ إذن الاستلام",
        why: `الإذن الواحد يدعم ${maxLines} بنداً كحدّ أقصى، وأنت ترسل ${input.lines.length}`,
        doThis: `قسّم الإذن الكبير إلى دفعات (${maxLines} بنداً فأقلّ لكل إذن) واستلمها واحدةً تلو الأخرى على الأمر نفسه`,
      }),
    });
  }
  uniquePositiveIds(
    input.lines.map((line) => line.purchaseOrderItemId),
    "بند أمر الشراء",
  );
  const normalizedLines = input.lines
    .map((line) => {
      const accepted = Number(line.acceptedBaseQuantity);
      const rejected = Number(line.rejectedBaseQuantity ?? 0);
      if (
        !Number.isSafeInteger(accepted) ||
        accepted < 0 ||
        !Number.isSafeInteger(rejected) ||
        rejected < 0 ||
        accepted + rejected <= 0
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: `تعذّر حفظ إذن الاستلام بسبب كمّيات البند رقم ${line.purchaseOrderItemId}`,
            why: `المقبول ${accepted} والمرفوض ${rejected} — والمطلوب عددان صحيحان غير سالبين ومجموعُهما أكبر من صفر`,
            doThis: "أدخِل الكمّية المقبولة والمرفوضة بالوحدة الأساس (بلا كسور)، واحذف السطر الذي لم يصل منه شيء بدل تركه صفراً",
          }),
        });
      }
      const rejectionReason = line.rejectionReason?.trim() || null;
      if (rejected > 0 && !rejectionReason) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: `تعذّر حفظ إذن الاستلام: البند رقم ${line.purchaseOrderItemId} فيه ${rejected} وحدة مرفوضة بلا سبب`,
            why: "الكمّية المرفوضة تُردّ إلى المورّد وتُخصَم من ذمّته، فلا تُثبَّت بلا سببٍ مكتوب يشهد به المستند",
            doThis: "اكتب سبب الرفض في السطر (تلف · نقص · مواصفة مخالفة · تاريخ انتهاء)، أو صفِّر الكمّية المرفوضة إن كانت البضاعة سليمة",
          }),
        });
      }
      return {
        purchaseOrderItemId: line.purchaseOrderItemId,
        acceptedBaseQuantity: accepted,
        rejectedBaseQuantity: rejected,
        rejectionReason,
      };
    })
    .sort((a, b) => a.purchaseOrderItemId - b.purchaseOrderItemId);
  const canonical = stableCanonical({
    purchaseOrderId: input.purchaseOrderId,
    purchaseOrderRevisionId: input.purchaseOrderRevisionId,
    expectedOrderVersion: input.expectedOrderVersion,
    supplierDeliveryNote: input.supplierDeliveryNote?.trim() || null,
    receivedAt: input.receivedAt?.toISOString() ?? null,
    notes: input.notes?.trim() || null,
    lines: normalizedLines,
  });
  const payloadHash = sha256(canonical);

  const executeInExistingTransaction = async () => {
    const existing = (
      await tx
        .select()
        .from(goodsReceipts)
        .where(eq(goodsReceipts.clientRequestId, requestKey))
        .limit(1)
    )[0];
    if (existing) {
      if (!payloadHashMatches(payloadHash, existing.payloadHash)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: `تعذّر حفظ إذن الاستلام — الإذن ${existing.receiptNumber} مُثبَتٌ سلفاً بهذا المفتاح`,
            why: "المفتاح نفسه أُرسل بكمّياتٍ أو بنودٍ مختلفة عمّا ثُبِّت، والمفتاح الواحد يخصّ إذناً واحداً كي لا تُستلَم البضاعة مرّتين",
            doThis: `افتح الإذن ${existing.receiptNumber} وراجع ما ثُبِّت فيه؛ ولاستلام كمّيةٍ إضافية أنشئ إذناً جديداً من شاشة الاستلام بدل إعادة إرسال هذا`,
          }),
        });
      }
      assertPurchaseBranch(existing, actor);
      return { ...existing, idempotentReplay: true as const };
    }

    const { po, revision } = await lockOrderAndRevision(
      tx,
      input.purchaseOrderId,
      actor,
    );
    await assertPeriodOpen(tx, input.receivedAt ?? new Date());
    if (Number(po.version) !== input.expectedOrderVersion) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: `تعذّر استلام بضاعة أمر الشراء ${po.poNumber}`,
          why: `تغيّر الأمر بعد فتح الشاشة (نسختك ${input.expectedOrderVersion} والحالية ${Number(po.version)}) — والاستلام يُقاس على النسخة الحالية`,
          doThis: "أعِد تحميل شاشة الاستلام، طابِق الكمّيات مع البضاعة الواصلة فعلاً، ثمّ احفظ",
        }),
      });
    }
    if (
      Number(po.approvedRevisionId) !== input.purchaseOrderRevisionId ||
      Number(revision.id) !== input.purchaseOrderRevisionId
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: `تعذّر استلام بضاعة أمر الشراء ${po.poNumber}`,
          why: `شاشتك تستلم على النسخة ${input.purchaseOrderRevisionId} والمعتمَدة الآن هي ${Number(po.approvedRevisionId)} — والاستلام على النسخة المعتمَدة الحالية وحدها`,
          doThis: "أعِد تحميل الأمر لتظهر النسخة المعتمَدة الحالية بكمّياتها وأسعارها، ثمّ استلم عليها",
        }),
      });
    }
    if (
      !(["CONFIRMED", "RECEIVED"] as const).includes(
        po.status as "CONFIRMED" | "RECEIVED",
      )
    ) {
      // المخرج يختلف باختلاف الحالة، فلا تكفي تسميةٌ عربية للحالة: المسوّدة تُرسَل وتُعتمَد،
      // والمُرسَل ينتظر اعتماداً، والملغى لا طريق له إلّا أمرٌ جديد. حالةٌ واحدةٌ = خطوةٌ واحدة.
      const statusExit: Record<string, { label: string; doThis: string }> = {
        DRAFT: {
          label: "مسوّدة",
          doThis: "أرسِل الأمر إلى المورّد من صفحة الأمر ثمّ اطلب اعتماده من المخوَّل، وبعدها استلم",
        },
        SENT: {
          label: "مُرسَل وينتظر الاعتماد",
          doThis: "اطلب من المخوَّل اعتماد الأمر من قائمة المشتريات ثمّ أعِد الاستلام",
        },
        CANCELLED: {
          label: "ملغى",
          doThis: "أنشئ أمر شراءٍ جديداً بالبضاعة الواصلة واعتمِده ثمّ استلم عليه — لا تُستلَم بضاعةٌ على أمرٍ ملغى",
        },
      };
      const exit = statusExit[String(po.status)];
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: `تعذّر استلام بضاعة أمر الشراء ${po.poNumber}`,
          why: `حالة الأمر الآن «${exit?.label ?? String(po.status)}»، والاستلام لا يقع إلّا على أمرٍ معتمَد (مؤكَّد أو مُستلَم جزئياً)`,
          doThis:
            exit?.doThis ??
            "أعِد الأمر إلى حالة «مؤكَّد» باعتماده من المخوَّل، ثمّ استلم البضاعة عليه",
        }),
      });
    }
    const isPurchaseOrderCreator =
      po.createdBy != null && Number(po.createdBy) === actor.userId;
    const isPurchaseOrderApprover =
      po.approvedBy != null && Number(po.approvedBy) === actor.userId;
    if (
      isPurchaseOrderCreator ||
      (isPurchaseOrderApprover &&
        !options.allowPurchaseOrderApproverForAutomaticPosting)
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: `لا تستطيع استلام بضاعة أمر الشراء ${po.poNumber} بنفسك`,
          why: `فصل المهام: أنت ${Number(po.createdBy) === actor.userId ? "منشئ الأمر" : "معتمِد الأمر"}، ومن يطلب البضاعة أو يعتمدها لا يشهد بوصولها`,
          doThis: "سلّم البضاعة إلى أمين المخزن أو زميلٍ آخر ليُدخِل الاستلام بحضورك، وبقاؤك مع السائق حتى يُثبَّت الإذن",
        }),
      });
    }
    if (!money(revision.taxAmount).isZero()) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: `تعذّر استلام بضاعة أمر الشراء ${po.poNumber}`,
          why: `النسخة المعتمَدة تحمل ضريبة ${money(revision.taxAmount).toFixed(2)}، ومسار الاستلام يدعم سياسة الضريبة العراقية الصفرية فقط (0%)`,
          doThis: "صفِّر الضريبة في أمر الشراء (عدّله ثمّ أعِد اعتماده) وأدخِل قيمتها في سعر البنود إن كان المورّد يحمّلها، ثمّ استلم البضاعة",
        }),
      });
    }

    const poItems = await tx
      .select()
      .from(purchaseOrderItems)
      .where(eq(purchaseOrderItems.purchaseOrderId, input.purchaseOrderId))
      .orderBy(asc(purchaseOrderItems.id))
      .for("update");
    const revisionItems = await tx
      .select()
      .from(purchaseOrderRevisionItems)
      .where(
        eq(
          purchaseOrderRevisionItems.revisionId,
          input.purchaseOrderRevisionId,
        ),
      )
      .orderBy(asc(purchaseOrderRevisionItems.lineNo))
      .for("update");
    if (poItems.length !== revisionItems.length) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: `تعذّر استلام بضاعة أمر الشراء ${po.poNumber}`,
          why: `بنود الأمر ${poItems.length} وبنود النسخة المعتمَدة ${revisionItems.length} — تغيّرت بنوده بعد اعتماده، والاستلام يُقاس على لقطة النسخة`,
          doThis: "أعِد اعتماد الأمر ليُلتقط له لقطةٌ مطابقة لبنوده الحالية، ثمّ استلم عليه",
        }),
      });
    }
    const revisionByPoItemId = new Map<
      number,
      (typeof revisionItems)[number]
    >();
    poItems.forEach((item, index) => {
      const snapshot = revisionItems[index];
      if (
        !snapshot ||
        Number(item.variantId) !== Number(snapshot.variantId) ||
        Number(item.baseQuantity) !== Number(snapshot.baseQuantity)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: `تعذّر استلام بضاعة أمر الشراء ${po.poNumber}`,
            why: `بند الأمر رقم ${Number(item.id)} لا يطابق ما في لقطة النسخة المعتمَدة (اختلف الصنف أو الكمّية) — عُدِّل الأمر بعد اعتماده`,
            doThis: "أعِد اعتماد الأمر ليُلتقط له لقطةٌ مطابقة لبنوده الحالية، ثمّ استلم عليه",
          }),
        });
      }
      revisionByPoItemId.set(Number(item.id), snapshot);
    });
    const poItemById = new Map(
      poItems.map((item) => [Number(item.id), item] as const),
    );

    const existingAccepted = await tx
      .select({
        purchaseOrderItemId: goodsReceiptItems.purchaseOrderItemId,
        accepted: sql<string>`COALESCE(SUM(${goodsReceiptItems.acceptedBaseQuantity} - ${goodsReceiptItems.reversedBaseQuantity} - ${goodsReceiptItems.returnedBaseQuantity}),0)`,
      })
      .from(goodsReceiptItems)
      .innerJoin(
        goodsReceipts,
        eq(goodsReceipts.id, goodsReceiptItems.goodsReceiptId),
      )
      .where(eq(goodsReceipts.purchaseOrderId, input.purchaseOrderId))
      .groupBy(goodsReceiptItems.purchaseOrderItemId)
      .for("update");
    const acceptedByItem = new Map(
      existingAccepted.map((row) => [
        Number(row.purchaseOrderItemId),
        Number(row.accepted),
      ]),
    );
    // The projection is decremented by governed reversals, while immutable GRN
    // line amounts remain unchanged as audit evidence.
    const netByItem = new Map(
      poItems.map((item) => [Number(item.id), money(item.receivedNet)]),
    );

    const work = normalizedLines.map((line) => {
      const item = poItemById.get(line.purchaseOrderItemId);
      const snapshot = revisionByPoItemId.get(line.purchaseOrderItemId);
      if (!item || !snapshot)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: `تعذّر استلام بضاعة أمر الشراء ${po.poNumber}`,
            why: `أحد أسطر الاستلام (بند رقم ${line.purchaseOrderItemId}) لا يخصّ هذا الأمر — غالباً تغيّرت بنود الأمر بعد فتح الشاشة`,
            doThis: "أعِد تحميل شاشة الاستلام لتظهر بنود الأمر الحالية، ثمّ أدخِل الكمّيات الواصلة عليها",
          }),
        });
      const priorAccepted = acceptedByItem.get(line.purchaseOrderItemId) ?? 0;
      if (
        priorAccepted + line.acceptedBaseQuantity >
        Number(snapshot.baseQuantity)
      ) {
        const remaining = Number(snapshot.baseQuantity) - priorAccepted;
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: `الكمية المقبولة تتجاوز المعتمد في السطر ${snapshot.lineNo}`,
            why: `المعتمَد ${Number(snapshot.baseQuantity)} وحدة أساس، والمستلَم سابقاً ${priorAccepted}، فالمتبقّي ${remaining} — وأنت تُدخِل ${line.acceptedBaseQuantity}`,
            doThis: `أنقص كمّية السطر إلى ${remaining} واستلمها، وأدرِج الزائد الذي وصل فعلاً في أمر شراءٍ جديد أو عدّل الأمر وأعِد اعتماده قبل استلامه`,
          }),
        });
      }
      return { line, item, snapshot, priorAccepted };
    });

    const receiptNumber = await nextDocumentNumber(
      tx,
      goodsReceipts,
      goodsReceipts.receiptNumber,
      "GRN",
      Number(po.branchId),
    );
    const receiptInsert = await tx.insert(goodsReceipts).values({
      receiptNumber,
      clientRequestId: requestKey,
      origin: "NATIVE",
      purchaseOrderId: input.purchaseOrderId,
      purchaseOrderRevisionId: input.purchaseOrderRevisionId,
      supplierId: Number(po.supplierId),
      branchId: Number(po.branchId),
      status: "POSTED",
      receivedAt: input.receivedAt ?? new Date(),
      supplierDeliveryNote: input.supplierDeliveryNote?.trim() || null,
      currency: po.agreedCurrency,
      agreedRate: po.agreedRate,
      netAmount: "0.00",
      taxAmount: "0.00",
      totalAmount: "0.00",
      usdTotal: po.agreedCurrency === "USD" ? "0.00" : null,
      notes: input.notes?.trim() || null,
      payloadCanonical: canonical,
      payloadHash,
      createdBy: actor.userId,
      postedBy: actor.userId,
      postedAt: new Date(),
    });
    const goodsReceiptId = extractInsertId(receiptInsert);

    const variantIds = work
      .filter(({ line }) => line.acceptedBaseQuantity > 0)
      .map(({ item }) => Number(item.variantId));
    await lockInventoryVariants(tx, variantIds);
    await ensureBranchStockRows(tx, variantIds, Number(po.branchId));
    if (variantIds.length) {
      await tx
        .select({ id: branchStock.id })
        .from(branchStock)
        .where(
          inArray(
            branchStock.variantId,
            Array.from(new Set(variantIds)).sort((a, b) => a - b),
          ),
        )
        .orderBy(asc(branchStock.variantId), asc(branchStock.branchId))
        .for("update");
    }
    const stockRows = variantIds.length
      ? await tx
          .select({
            variantId: branchStock.variantId,
            quantity: sql<string>`COALESCE(SUM(${branchStock.quantity}),0)`,
          })
          .from(branchStock)
          .where(inArray(branchStock.variantId, variantIds))
          .groupBy(branchStock.variantId)
      : [];
    const variantRows = variantIds.length
      ? await tx
          .select({
            id: productVariants.id,
            costPrice: productVariants.costPrice,
          })
          .from(productVariants)
          .where(inArray(productVariants.id, variantIds))
          .orderBy(asc(productVariants.id))
          .for("update")
      : [];
    const qtyByVariant = new Map(
      stockRows.map((row) => [Number(row.variantId), money(row.quantity)]),
    );
    const costByVariant = new Map(
      variantRows.map((row) => [Number(row.id), money(row.costPrice)]),
    );

    let usdTotal = money(0);
    const prepared = work.map(
      ({ line, item, snapshot, priorAccepted }, index) => {
        const accepted = line.acceptedBaseQuantity;
        const priorNet = netByItem.get(Number(item.id)) ?? money(0);
        const isFinalAccepted =
          priorAccepted + accepted === Number(snapshot.baseQuantity);
        const lineNet =
          accepted === 0
            ? money(0)
            : isFinalAccepted
              ? round2(money(snapshot.lineTotal).minus(priorNet))
              : round2(
                  money(snapshot.lineTotal)
                    .times(accepted)
                    .dividedBy(Number(snapshot.baseQuantity)),
                );
        const unitCost =
          accepted > 0
            ? round2(lineNet.dividedBy(accepted))
            : round2(
                money(snapshot.lineTotal).dividedBy(
                  Number(snapshot.baseQuantity),
                ),
              );
        let lineUsd: Decimal | null = null;
        if (po.agreedCurrency === "USD") {
          if (snapshot.usdLineTotal == null)
            throw new TRPCError({
              code: "CONFLICT",
              message: appErrorMessage({
                what: `تعذّر استلام السطر ${Number(snapshot.lineNo)} من أمر الشراء ${po.poNumber}`,
                why: "الأمر بالدولار ولا قيمة دولارية محفوظة لهذا السطر في النسخة المعتمَدة — فلا تُحتسَب ذمّة المورّد بالدولار",
                doThis: "افتح الأمر وأدخِل سعر السطر بالدولار وأعِد اعتماده، ثمّ استلم البضاعة",
              }),
            });
          lineUsd = finalResidualCurrencyAmount(
            snapshot.usdLineTotal,
            Number(snapshot.baseQuantity),
            accepted,
            item.receivedUsd ?? "0",
            isFinalAccepted,
          );
          usdTotal = usdTotal.plus(lineUsd);
        }
        return {
          goodsReceiptId,
          lineNo: index + 1,
          purchaseOrderItemId: Number(item.id),
          purchaseOrderRevisionItemId: Number(snapshot.id),
          variantId: Number(item.variantId),
          productUnitId:
            item.productUnitId == null ? null : Number(item.productUnitId),
          receivedBaseQuantity: accepted + line.rejectedBaseQuantity,
          acceptedBaseQuantity: accepted,
          rejectedBaseQuantity: line.rejectedBaseQuantity,
          rejectionReason: line.rejectionReason,
          unitCostIqd: toDbMoney(unitCost),
          netAmount: toDbMoney(lineNet),
          taxAmount: "0.00",
          totalAmount: toDbMoney(lineNet),
          usdAmount: lineUsd == null ? null : toDbMoney(lineUsd),
          inventoryMovementId: null,
          accepted,
          lineNet,
          lineUsd,
          unitCost,
          item,
        };
      },
    );
    await tx
      .insert(goodsReceiptItems)
      .values(
        prepared.map(
          ({
            accepted: _accepted,
            lineNet: _lineNet,
            lineUsd: _lineUsd,
            unitCost: _unitCost,
            item: _item,
            ...values
          }) => values,
        ),
      );
    const insertedItems = await tx
      .select({ id: goodsReceiptItems.id, lineNo: goodsReceiptItems.lineNo })
      .from(goodsReceiptItems)
      .where(eq(goodsReceiptItems.goodsReceiptId, goodsReceiptId))
      .orderBy(asc(goodsReceiptItems.lineNo));
    let netTotal = money(0);
    for (let index = 0; index < prepared.length; index += 1) {
      const { accepted, lineNet, lineUsd, unitCost, item } = prepared[index]!;
      const goodsReceiptItemId = Number(insertedItems[index]!.id);
      if (accepted > 0) {
        const variantId = Number(item.variantId);
        const oldQty = Decimal.max(qtyByVariant.get(variantId) ?? money(0), 0);
        const oldCost = costByVariant.get(variantId) ?? money(0);
        const denominator = oldQty.plus(accepted);
        const newCost =
          denominator.lte(0) || oldCost.lte(0)
            ? unitCost
            : round2(
                oldQty
                  .times(oldCost)
                  .plus(unitCost.times(accepted))
                  .dividedBy(denominator),
              );
        const movement = await applyMovement(tx, {
          variantId,
          branchId: Number(po.branchId),
          baseQuantity: accepted,
          movementType: "IN",
          referenceType: "GOODS_RECEIPT",
          referenceId: goodsReceiptId,
          notes: `إذن استلام ${receiptNumber}`,
          createdBy: actor.userId,
          stampOpened: true,
        });
        if (movement.movementId <= 0)
          throw new TRPCError({
            code: "CONFLICT",
            message: appErrorMessage({
              what: `تعذّر استلام السطر رقم ${Number(insertedItems[index]!.lineNo)} من أمر الشراء ${po.poNumber}`,
              why: "الصنف مصنَّف خِدمة (بلا مخزون) فلا تُكتب له حركةُ إدخال، وإذنُ الاستلام لا يُثبَّت بلا حركة",
              doThis: "احذف السطر الخِدميّ من الاستلام واستلم البضاعة وحدها؛ وإن كان تصنيفه خطأً فصحّحه من صفحة تعديل المنتج (يلزمه رصيدٌ صفريّ) ثمّ أعِد الاستلام",
            }),
          });
        await tx
          .update(goodsReceiptItems)
          .set({ inventoryMovementId: movement.movementId })
          .where(eq(goodsReceiptItems.id, goodsReceiptItemId));
        await tx
          .update(productVariants)
          .set({ costPrice: toDbMoney(newCost) })
          .where(eq(productVariants.id, variantId));
        await tx
          .update(purchaseOrderItems)
          .set({
            receivedBaseQuantity: sql`${purchaseOrderItems.receivedBaseQuantity} + ${accepted}`,
            receivedNet: sql`${purchaseOrderItems.receivedNet} + ${toDbMoney(lineNet)}`,
            ...(lineUsd == null
              ? {}
              : {
                  receivedUsd: sql`${purchaseOrderItems.receivedUsd} + ${toDbMoney(lineUsd)}`,
                }),
          })
          .where(eq(purchaseOrderItems.id, Number(item.id)));
        qtyByVariant.set(variantId, denominator);
        costByVariant.set(variantId, newCost);
        netTotal = netTotal.plus(lineNet);
      }
    }
    netTotal = round2(netTotal);
    usdTotal = round2(usdTotal);
    await tx
      .update(goodsReceipts)
      .set({
        netAmount: toDbMoney(netTotal),
        totalAmount: toDbMoney(netTotal),
        usdTotal: po.agreedCurrency === "USD" ? toDbMoney(usdTotal) : null,
      })
      .where(eq(goodsReceipts.id, goodsReceiptId));

    const totals = await tx
      .select({
        id: purchaseOrderItems.id,
        base: purchaseOrderItems.baseQuantity,
        accepted: sql<string>`COALESCE(SUM(${goodsReceiptItems.acceptedBaseQuantity} - ${goodsReceiptItems.reversedBaseQuantity} - ${goodsReceiptItems.returnedBaseQuantity}),0)`,
      })
      .from(purchaseOrderItems)
      .leftJoin(
        goodsReceiptItems,
        eq(goodsReceiptItems.purchaseOrderItemId, purchaseOrderItems.id),
      )
      .where(eq(purchaseOrderItems.purchaseOrderId, input.purchaseOrderId))
      .groupBy(purchaseOrderItems.id, purchaseOrderItems.baseQuantity);
    const fullyReceived = totals.every(
      (row) => Number(row.accepted) >= Number(row.base),
    );
    await tx
      .update(purchaseOrders)
      .set({ status: fullyReceived ? "RECEIVED" : "CONFIRMED" })
      .where(eq(purchaseOrders.id, input.purchaseOrderId));
    await postGoodsReceiptGrniTx(tx, {
      goodsReceiptId,
      purchaseOrderId: input.purchaseOrderId,
      supplierId: Number(po.supplierId),
      branchId: Number(po.branchId),
      inventoryAmount: netTotal,
      totalAmount: netTotal,
      actorId: actor.userId,
    });
    return {
      goodsReceiptId,
      receiptNumber,
      netAmount: toDbMoney(netTotal),
      usdTotal: po.agreedCurrency === "USD" ? toDbMoney(usdTotal) : null,
      fullyReceived,
      idempotentReplay: false as const,
    };
  };
  return executeInExistingTransaction();
}

export async function createGoodsReceipt(
  input: CreateGoodsReceiptInput,
  actor: Actor,
) {
  return withTx((tx) => createGoodsReceiptInTx(tx, input, actor));
}

export async function requestGoodsReceiptReversal(
  input: RequestGoodsReceiptReversalInput,
  actor: Actor,
) {
  const requestKey = requireText(input.requestKey, "مفتاح الطلب", 120);
  const reason = requireText(input.reason, "سبب العكس", 500);
  if (!input.lines.length)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تقديم طلب عكس الاستلام",
        why: "لم تُحدَّد فيه بنود، وعكس الاستلام يُخرِج كمّيةً بعينها من المخزون",
        doThis: "علّم البنود التي تريد عكسها من جدول الإذن وأدخِل كمّية كلٍّ منها ثمّ أرسِل الطلب",
      }),
    });
  uniquePositiveIds(
    input.lines.map((line) => line.goodsReceiptItemId),
    "بند إذن الاستلام",
  );
  const lines = input.lines
    .map((line) => {
      if (!Number.isSafeInteger(line.baseQuantity) || line.baseQuantity <= 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: `تعذّر تقديم طلب عكس الاستلام بسبب كمّية البند رقم ${line.goodsReceiptItemId}`,
            why: `الكمّية يجب أن تكون عدداً صحيحاً موجباً بالوحدة الأساس، والمُرسَل ${line.baseQuantity}`,
            doThis: "أدخِل الكمّية المراد عكسها بالوحدة الأساس (بلا كسور)، واحذف السطر الذي لا تريد عكس شيءٍ منه",
          }),
        });
      }
      return {
        goodsReceiptItemId: line.goodsReceiptItemId,
        baseQuantity: line.baseQuantity,
        reason: line.reason?.trim() || null,
      };
    })
    .sort((a, b) => a.goodsReceiptItemId - b.goodsReceiptItemId);
  const canonical = stableCanonical({
    goodsReceiptId: input.goodsReceiptId,
    expectedReceiptVersion: input.expectedReceiptVersion,
    reason,
    lines,
  });
  const payloadHash = sha256(canonical);
  return withTx(async (tx) => {
    const existing = (
      await tx
        .select()
        .from(goodsReceiptReversalRequests)
        .where(eq(goodsReceiptReversalRequests.requestKey, requestKey))
        .limit(1)
    )[0];
    if (existing) {
      if (!payloadHashMatches(payloadHash, existing.payloadHash))
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر تقديم طلب عكس الاستلام",
            why: `مفتاح الطلب مستعمَلٌ سلفاً لطلب عكسٍ آخر (رقم ${Number(existing.id)}) بكمّياتٍ أو بنودٍ مختلفة`,
            doThis: "افتح قائمة اعتمادات المشتريات وراجع الطلب القائم؛ ولطلب عكسٍ مختلف ابدأ من شاشة الإذن من جديد بدل إعادة إرسال هذا",
          }),
        });
      assertPurchaseBranch(existing, actor);
      return { ...existing, idempotentReplay: true as const };
    }
    const receipt = (
      await tx
        .select()
        .from(goodsReceipts)
        .where(eq(goodsReceipts.id, input.goodsReceiptId))
        .for("update")
        .limit(1)
    )[0];
    if (!receipt)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر تقديم طلب عكس الاستلام",
          why: `إذن الاستلام رقم ${input.goodsReceiptId} غير موجود — يبدو أنّ الرابط قديم`,
          doThis: "افتح الإذن من قائمة أذون الاستلام واطلب العكس من صفحته",
        }),
      });
    assertPurchaseBranch(receipt, actor);
    if (receipt.origin !== "NATIVE")
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: `تعذّر طلب عكس إذن الاستلام ${receipt.receiptNumber}`,
          why: "الإذن تاريخيّ مجمَّع (رُحِّل من قبل النظام) ولا يحمل مستنداً أصلياً واحداً يُعكَس عليه",
          doThis: "صحّح الفرق بتسوية مخزونٍ معتمَدة أو بمرتجع شراءٍ على المورّد، ولا تنتظر عكساً لهذا الإذن",
        }),
      });
    if (Number(receipt.version) !== input.expectedReceiptVersion)
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: `تعذّر طلب عكس إذن الاستلام ${receipt.receiptNumber}`,
          why: `تغيّر الإذن بعد فتح الشاشة (نسختك ${input.expectedReceiptVersion} والحالية ${Number(receipt.version)}) — غالباً عُكِس منه شيءٌ للتوّ`,
          doThis: "أعِد تحميل الإذن، راجع ما بقي مقبولاً في كل سطر، ثمّ اطلب العكس على المتبقّي وحده",
        }),
      });
    if (receipt.status === "REVERSED")
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: `تعذّر طلب عكس إذن الاستلام ${receipt.receiptNumber}`,
          why: "الإذن معكوسٌ بالكامل سلفاً، فلا تبقى فيه كمّيةٌ تُعكَس",
          doThis: "افتح أمر الشراء وراجع الكمّيات المتبقّية عليه؛ ولإخراج بضاعةٍ عادت للمورّد بعد استلامها استعمل مرتجع الشراء لا عكس الإذن",
        }),
      });
    const items = await tx
      .select()
      .from(goodsReceiptItems)
      .where(
        and(
          eq(goodsReceiptItems.goodsReceiptId, input.goodsReceiptId),
          inArray(
            goodsReceiptItems.id,
            lines.map((line) => line.goodsReceiptItemId),
          ),
        ),
      )
      .orderBy(asc(goodsReceiptItems.id))
      .for("update");
    if (items.length !== lines.length)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر طلب عكس إذن الاستلام ${receipt.receiptNumber}`,
          why: `طلبتَ عكس ${lines.length} بنداً ولم يُوجَد منها في هذا الإذن إلّا ${items.length} — أحد البنود يخصّ إذناً آخر`,
          doThis: "أعِد تحميل الإذن واختر بنوده من جدوله نفسه، ثمّ أعِد إرسال الطلب",
        }),
      });
    const itemById = new Map(
      items.map((item) => [Number(item.id), item] as const),
    );
    for (const line of lines) {
      const item = itemById.get(line.goodsReceiptItemId)!;
      const available =
        Number(item.acceptedBaseQuantity) -
        Number(item.reversedBaseQuantity) -
        Number(item.returnedBaseQuantity);
      if (line.baseQuantity > available)
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: `كمية العكس تتجاوز المقبول المتاح في السطر ${Number(item.lineNo)} من إذن الاستلام ${receipt.receiptNumber}`,
            why: `المقبول ${Number(item.acceptedBaseQuantity)} وحدة أساس، وعُكِس منه ${Number(item.reversedBaseQuantity)} ورُدّ للمورّد ${Number(item.returnedBaseQuantity)}، فالمتاح للعكس ${available} — وأنت تطلب ${line.baseQuantity}`,
            doThis:
              available > 0
                ? `أنقص كمّية السطر إلى ${available} وأعِد إرسال الطلب`
                : "لم يبقَ في هذا السطر ما يُعكَس — أخرِجه من الطلب، ولإرجاع بضاعةٍ إلى المورّد استعمل مرتجع الشراء",
          }),
        });
    }
    const inserted = await tx.insert(goodsReceiptReversalRequests).values({
      requestKey,
      goodsReceiptId: input.goodsReceiptId,
      branchId: Number(receipt.branchId),
      baseReceiptVersion: input.expectedReceiptVersion,
      payloadCanonical: canonical,
      payloadHash,
      reason,
      status: "PENDING",
      pendingGuard: `GRN_REVERSE:${input.goodsReceiptId}`,
      requestedBy: actor.userId,
    });
    const requestId = extractInsertId(inserted);
    await tx
      .insert(goodsReceiptReversalRequestItems)
      .values(lines.map((line) => ({ requestId, ...line })));
    return {
      requestId,
      status: "PENDING" as const,
      idempotentReplay: false as const,
    };
  });
}

export async function decideGoodsReceiptReversal(
  input: DecideGoodsReceiptReversalInput,
  actor: Actor,
) {
  const decisionKey = requireText(input.decisionKey, "مفتاح القرار", 120);
  const reviewReason = requireText(input.reviewReason, "سبب القرار", 500);
  const decisionHash = sha256(
    stableCanonical({
      requestId: input.requestId,
      action: input.action,
      reviewReason,
    }),
  );
  return withTx(async (tx) => {
    const preview = (
      await tx
        .select()
        .from(goodsReceiptReversalRequests)
        .where(eq(goodsReceiptReversalRequests.id, input.requestId))
        .limit(1)
    )[0];
    if (!preview)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر حسم طلب عكس الاستلام",
          why: `الطلب رقم ${input.requestId} غير موجود — يبدو أنه حُذف أو أنّ الشاشة تحمل قائمةً قديمة`,
          doThis: "أعِد تحميل قائمة اعتمادات المشتريات واحسم الطلب من صفّه الحالي",
        }),
      });
    const receiptPreview = (
      await tx
        .select()
        .from(goodsReceipts)
        .where(eq(goodsReceipts.id, Number(preview.goodsReceiptId)))
        .limit(1)
    )[0];
    if (!receiptPreview)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر حسم طلب عكس الاستلام",
          why: `إذن الاستلام المرتبط بالطلب (رقم ${Number(preview.goodsReceiptId)}) لم يعد موجوداً`,
          doThis: "ارفض الطلب وأبلِغ مسؤول النظام برقم الطلب ورقم الإذن — لا يُعتمَد عكسٌ على مستندٍ مفقود",
        }),
      });
    const { po } = await lockOrderAndRevision(
      tx,
      Number(receiptPreview.purchaseOrderId),
      actor,
    );
    const receipt = (
      await tx
        .select()
        .from(goodsReceipts)
        .where(eq(goodsReceipts.id, Number(preview.goodsReceiptId)))
        .for("update")
        .limit(1)
    )[0]!;
    const request = (
      await tx
        .select()
        .from(goodsReceiptReversalRequests)
        .where(eq(goodsReceiptReversalRequests.id, input.requestId))
        .for("update")
        .limit(1)
    )[0]!;
    assertPurchaseBranch(receipt, actor);
    if (request.decisionKey != null) {
      if (
        request.decisionKey !== decisionKey ||
        request.decisionHash !== decisionHash
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: `تعذّر حسم طلب عكس إذن الاستلام ${receipt.receiptNumber}`,
            why: `الطلب حُسم سلفاً بقرارٍ مختلف (حالته الآن ${request.status === "APPROVED" ? "معتمَد" : "مرفوض"}) — ولا يُحسَم الطلب مرّتين`,
            doThis: "أعِد تحميل قائمة الاعتمادات لترى القرار المُثبَت؛ ولتصحيحه اطلب عكساً جديداً بمستنده",
          }),
        });
      }
      return {
        requestId: input.requestId,
        status: request.status,
        idempotentReplay: true as const,
      };
    }
    if (request.status !== "PENDING")
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: `تعذّر حسم طلب عكس إذن الاستلام ${receipt.receiptNumber}`,
          why: `الطلب لم يعد معلّقاً (حالته ${request.status === "APPROVED" ? "معتمَد" : "مرفوض"}) — حسمه زميلٌ آخر قبلك`,
          doThis: "أعِد تحميل قائمة الاعتمادات لترى من حسمه ومتى؛ وإن كان القرار خاطئاً فاطلب عكساً جديداً بمستنده",
        }),
      });
    // عكسُ الاستلام محوُ أثرٍ مُثبَت: `applyMovement` باتّجاه OUT (إخراجُ مخزونٍ أُدخل) +
    // قيدٌ عكسيّ يمحو التزام GRNI. ⇒ المالك حصراً. والرفضُ حرٌّ — لا يكتب شيئاً ماليّاً.
    assertApprover({
      actor: await resolveApprovalActor(tx, actor),
      trigger: goodsReceiptReversalTrigger(input.action),
      subject: `عكس استلام ${receipt.receiptNumber}`,
      legacy: () => {
        if (
          Number(request.requestedBy) === actor.userId ||
          Number(receipt.createdBy) === actor.userId ||
          Number(receipt.postedBy) === actor.userId ||
          Number(po.createdBy) === actor.userId ||
          Number(po.approvedBy) === actor.userId
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: appErrorMessage({
              what: `لا تستطيع اعتماد عكس إذن الاستلام ${receipt.receiptNumber}`,
              why: "فصل المهام: أنت طرفٌ في المستند نفسه (طلبتَ العكس أو نفّذتَ الاستلام أو أنشأتَ أمر الشراء أو اعتمدتَه)، ومن صنع الأثر لا يمحوه",
              doThis: "أحِل الطلب إلى المدير أو مالك الحساب ليعتمده، وسيبقى معلّقاً في قائمة اعتمادات المشتريات حتى يُحسَم",
            }),
          });
        }
      },
    });
    const decidedAt = new Date();
    if (input.action === "REJECT") {
      await tx
        .update(goodsReceiptReversalRequests)
        .set({
          status: "REJECTED",
          pendingGuard: null,
          reviewedBy: actor.userId,
          reviewedAt: decidedAt,
          reviewReason,
          decisionKey,
          decisionHash,
        })
        .where(eq(goodsReceiptReversalRequests.id, input.requestId));
      return {
        requestId: input.requestId,
        status: "REJECTED" as const,
        idempotentReplay: false as const,
      };
    }
    if (
      Number(receipt.version) !== Number(request.baseReceiptVersion) ||
      receipt.status === "REVERSED"
    ) {
      await tx
        .update(goodsReceiptReversalRequests)
        .set({
          status: "STALE",
          pendingGuard: null,
          reviewedBy: actor.userId,
          reviewedAt: decidedAt,
          reviewReason,
          decisionKey,
          decisionHash,
        })
        .where(eq(goodsReceiptReversalRequests.id, input.requestId));
      return {
        requestId: input.requestId,
        status: "STALE" as const,
        idempotentReplay: false as const,
      };
    }
    // Mutating a historical receipt changes the operational source used by the
    // closed-period inventory/GRNI certificate. Reopen that period first; a
    // current-date journal alone must not rewrite its frozen source document.
    await assertPeriodOpen(tx, receipt.receivedAt);
    const requestedItems = await tx
      .select({
        requestItem: goodsReceiptReversalRequestItems,
        receiptItem: goodsReceiptItems,
      })
      .from(goodsReceiptReversalRequestItems)
      .innerJoin(
        goodsReceiptItems,
        eq(
          goodsReceiptItems.id,
          goodsReceiptReversalRequestItems.goodsReceiptItemId,
        ),
      )
      .where(eq(goodsReceiptReversalRequestItems.requestId, input.requestId))
      .orderBy(asc(goodsReceiptItems.id))
      .for("update");
    const allocatedRows = await tx
      .select({
        goodsReceiptItemId: supplierInvoiceMatchAllocations.goodsReceiptItemId,
        allocated: sql<string>`COALESCE(SUM(${supplierInvoiceMatchAllocations.matchedBaseQuantity}),0)`,
      })
      .from(supplierInvoiceMatchAllocations)
      .innerJoin(
        supplierInvoiceMatchRuns,
        eq(
          supplierInvoiceMatchRuns.id,
          supplierInvoiceMatchAllocations.matchRunId,
        ),
      )
      .innerJoin(
        supplierInvoices,
        eq(supplierInvoices.id, supplierInvoiceMatchRuns.supplierInvoiceId),
      )
      .where(
        and(
          inArray(
            supplierInvoiceMatchAllocations.goodsReceiptItemId,
            requestedItems.map((row) => Number(row.receiptItem.id)),
          ),
          inArray(supplierInvoices.status, ["MATCHED", "POSTED"]),
        ),
      )
      .groupBy(supplierInvoiceMatchAllocations.goodsReceiptItemId)
      .for("update");
    const allocated = new Map(
      allocatedRows.map((row) => [
        Number(row.goodsReceiptItemId),
        Number(row.allocated),
      ]),
    );
    for (const row of requestedItems) {
      const available =
        Number(row.receiptItem.acceptedBaseQuantity) -
        Number(row.receiptItem.reversedBaseQuantity) -
        Number(row.receiptItem.returnedBaseQuantity) -
        (allocated.get(Number(row.receiptItem.id)) ?? 0);
      if (Number(row.requestItem.baseQuantity) > available)
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: `تعذّر اعتماد عكس السطر ${Number(row.receiptItem.lineNo)} من إذن الاستلام ${receipt.receiptNumber}`,
            why: `المتاح للعكس الآن ${available} وحدة أساس والمطلوب ${Number(row.requestItem.baseQuantity)} — خُصِّص جزءٌ منه لفاتورة مورّدٍ أو رُدَّ أو عُكِس بعد تقديم الطلب`,
            doThis:
              "ارفض هذا الطلب واطلب عكساً جديداً بالكمّية المتاحة فعلاً؛ وإن كانت الكمّية مفوترةً على المورّد فعالجها بمرتجع شراءٍ لا بعكس الإذن",
          }),
        });
    }
    const variantIds = requestedItems.map((row) =>
      Number(row.receiptItem.variantId),
    );
    await lockInventoryVariants(tx, variantIds);
    const variantRows = await tx
      .select({ id: productVariants.id, costPrice: productVariants.costPrice })
      .from(productVariants)
      .where(inArray(productVariants.id, variantIds))
      .orderBy(asc(productVariants.id))
      .for("update");
    const costByVariant = new Map(
      variantRows.map((row) => [Number(row.id), money(row.costPrice)]),
    );
    const reversalNumber = await nextDocumentNumber(
      tx,
      goodsReceiptReversals,
      goodsReceiptReversals.reversalNumber,
      "GRR",
      Number(receipt.branchId),
    );
    const financialItems = requestedItems.map((row) => {
      const quantity = Number(row.requestItem.baseQuantity);
      const usdAmount =
        row.receiptItem.usdAmount == null
          ? null
          : cumulativeQuantityCurrencyDelta(
              row.receiptItem.usdAmount,
              Number(row.receiptItem.acceptedBaseQuantity),
              Number(row.receiptItem.reversedBaseQuantity),
              quantity,
            );
      return { row, quantity, usdAmount };
    });
    const reversalCanonical = stableCanonical({
      requestId: input.requestId,
      receiptId: receipt.id,
      decisionHash,
      items: financialItems.map(({ row, quantity, usdAmount }) => ({
        goodsReceiptItemId: row.receiptItem.id,
        baseQuantity: quantity,
        usdAmount: usdAmount == null ? null : toDbMoney(usdAmount),
      })),
    });
    let grniAmount = money(0);
    let inventoryAmount = money(0);
    const reversalInsert = await tx.insert(goodsReceiptReversals).values({
      reversalNumber,
      requestId: input.requestId,
      goodsReceiptId: Number(receipt.id),
      purchaseOrderId: Number(receipt.purchaseOrderId),
      purchaseOrderRevisionId: Number(receipt.purchaseOrderRevisionId),
      supplierId: Number(receipt.supplierId),
      branchId: Number(receipt.branchId),
      netAmount: "0.00",
      taxAmount: "0.00",
      totalAmount: "0.00",
      payloadCanonical: reversalCanonical,
      payloadHash: sha256(reversalCanonical),
      reason: request.reason,
      postedBy: actor.userId,
    });
    const reversalId = extractInsertId(reversalInsert);
    for (const { row, quantity, usdAmount } of financialItems) {
      const original = round2(
        money(row.receiptItem.unitCostIqd).times(quantity),
      );
      const carrying = round2(
        (
          costByVariant.get(Number(row.receiptItem.variantId)) ?? money(0)
        ).times(quantity),
      );
      const movement = await applyMovement(tx, {
        variantId: Number(row.receiptItem.variantId),
        branchId: Number(receipt.branchId),
        baseQuantity: quantity,
        movementType: "OUT",
        referenceType: "GOODS_RECEIPT_REVERSAL",
        referenceId: reversalId,
        notes: `عكس ${reversalNumber}`,
        createdBy: actor.userId,
      });
      if (movement.movementId <= 0)
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: `تعذّر اعتماد عكس السطر ${Number(row.receiptItem.lineNo)} من إذن الاستلام ${receipt.receiptNumber}`,
            why: "لم تُكتب حركة إخراجٍ للصنف — صُنِّف خِدمةً بعد استلامه، والخدمة بلا مخزونٍ يُخرَج منه",
            doThis: "أعِد تصنيف الصنف صنفاً مخزنياً من صفحة تعديل المنتج ثمّ أعِد اعتماد الطلب؛ وإن تعذّر فارفض الطلب وصحّح الرصيد بتسويةٍ معتمَدة",
          }),
        });
      await tx.insert(goodsReceiptReversalItems).values({
        reversalId,
        goodsReceiptItemId: Number(row.receiptItem.id),
        baseQuantity: quantity,
        netAmount: toDbMoney(original),
        taxAmount: "0.00",
        totalAmount: toDbMoney(original),
        inventoryMovementId: movement.movementId,
      });
      await tx
        .update(goodsReceiptItems)
        .set({
          reversedBaseQuantity: sql`${goodsReceiptItems.reversedBaseQuantity} + ${quantity}`,
        })
        .where(eq(goodsReceiptItems.id, Number(row.receiptItem.id)));
      await tx
        .update(purchaseOrderItems)
        .set({
          receivedBaseQuantity: sql`GREATEST(${purchaseOrderItems.receivedBaseQuantity} - ${quantity}, 0)`,
          receivedNet: sql`GREATEST(${purchaseOrderItems.receivedNet} - ${toDbMoney(original)}, 0)`,
          ...(usdAmount == null
            ? {}
            : {
                receivedUsd: sql`${purchaseOrderItems.receivedUsd} - ${toDbMoney(usdAmount)}`,
              }),
        })
        .where(
          eq(
            purchaseOrderItems.id,
            Number(row.receiptItem.purchaseOrderItemId),
          ),
        );
      grniAmount = grniAmount.plus(original);
      inventoryAmount = inventoryAmount.plus(carrying);
    }
    grniAmount = round2(grniAmount);
    inventoryAmount = round2(inventoryAmount);
    await tx
      .update(goodsReceiptReversals)
      .set({
        netAmount: toDbMoney(grniAmount),
        totalAmount: toDbMoney(grniAmount),
      })
      .where(eq(goodsReceiptReversals.id, reversalId));
    const remaining = await tx
      .select({ count: sql<number>`COUNT(*)` })
      .from(goodsReceiptItems)
      .where(
        and(
          eq(goodsReceiptItems.goodsReceiptId, Number(receipt.id)),
          sql`${goodsReceiptItems.reversedBaseQuantity} + ${goodsReceiptItems.returnedBaseQuantity} < ${goodsReceiptItems.acceptedBaseQuantity}`,
        ),
      );
    const receiptStatus =
      Number(remaining[0]?.count ?? 0) === 0
        ? "REVERSED"
        : "PARTIALLY_REVERSED";
    await tx
      .update(goodsReceipts)
      .set({ status: receiptStatus })
      .where(eq(goodsReceipts.id, Number(receipt.id)));
    await tx
      .update(purchaseOrders)
      .set({ status: "CONFIRMED" })
      .where(eq(purchaseOrders.id, Number(receipt.purchaseOrderId)));
    await postGoodsReceiptReversalTx(tx, {
      goodsReceiptId: Number(receipt.id),
      reversalId,
      purchaseOrderId: Number(receipt.purchaseOrderId),
      supplierId: Number(receipt.supplierId),
      branchId: Number(receipt.branchId),
      grniAmount,
      inventoryCarryingAmount: inventoryAmount,
      actorId: actor.userId,
    });
    await tx
      .update(goodsReceiptReversalRequests)
      .set({
        status: "APPROVED",
        pendingGuard: null,
        reviewedBy: actor.userId,
        reviewedAt: decidedAt,
        reviewReason,
        decisionKey,
        decisionHash,
        appliedAt: decidedAt,
      })
      .where(eq(goodsReceiptReversalRequests.id, input.requestId));
    return {
      requestId: input.requestId,
      reversalId,
      reversalNumber,
      status: "APPROVED" as const,
      idempotentReplay: false as const,
    };
  });
}

export async function getGoodsReceipt(goodsReceiptId: number, actor: Actor) {
  return withTx(
    async (tx) => {
      const receipt = (
        await tx
          .select()
          .from(goodsReceipts)
          .where(eq(goodsReceipts.id, goodsReceiptId))
          .limit(1)
      )[0];
      if (!receipt)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "تعذّر فتح إذن الاستلام",
            why: `الإذن رقم ${goodsReceiptId} غير موجود — يبدو أنّ الرابط قديم أو أنّ الإذن يخصّ فرعاً آخر`,
            doThis: "ارجع إلى قائمة أذون الاستلام وافتح الإذن من صفّه هناك",
          }),
        });
      assertPurchaseBranch(receipt, actor);
      const items = await tx
        .select({
          id: goodsReceiptItems.id,
          goodsReceiptId: goodsReceiptItems.goodsReceiptId,
          lineNo: goodsReceiptItems.lineNo,
          purchaseOrderItemId: goodsReceiptItems.purchaseOrderItemId,
          variantId: goodsReceiptItems.variantId,
          productName: products.name,
          variantSku: productVariants.sku,
          receivedBaseQuantity: goodsReceiptItems.receivedBaseQuantity,
          acceptedBaseQuantity: goodsReceiptItems.acceptedBaseQuantity,
          rejectedBaseQuantity: goodsReceiptItems.rejectedBaseQuantity,
          reversedBaseQuantity: goodsReceiptItems.reversedBaseQuantity,
          returnedBaseQuantity: goodsReceiptItems.returnedBaseQuantity,
          unitCostIqd: goodsReceiptItems.unitCostIqd,
          netAmount: goodsReceiptItems.netAmount,
          taxAmount: goodsReceiptItems.taxAmount,
        })
        .from(goodsReceiptItems)
        .innerJoin(productVariants, eq(productVariants.id, goodsReceiptItems.variantId))
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(eq(goodsReceiptItems.goodsReceiptId, goodsReceiptId))
        .orderBy(asc(goodsReceiptItems.lineNo));
      const reversalRequests = await tx
        .select()
        .from(goodsReceiptReversalRequests)
        .where(eq(goodsReceiptReversalRequests.goodsReceiptId, goodsReceiptId))
        .orderBy(asc(goodsReceiptReversalRequests.requestedAt));
      return { receipt, items, reversalRequests };
    },
    { gate: "NONE" },
  );
}

export async function listGoodsReceipts(
  input: { branchId: number; purchaseOrderId?: number; limit?: number },
  actor: Actor,
) {
  if (actor.role !== "admin" && actor.branchId !== input.branchId)
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "لا يمكنك عرض أذون استلام فرع آخر",
        why: `الطلب يخصّ الفرع رقم ${input.branchId} وأنت مُسنَدٌ إلى الفرع رقم ${actor.branchId ?? "غير محدَّد"}`,
        doThis: "بدّل الفرع في الشاشة إلى فرعك، أو اطلب من المدير عرض أذون الفرع الآخر (عبورُ الفروع له وحده)",
      }),
    });
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
  return withTx(
    (tx) =>
      tx
        .select()
        .from(goodsReceipts)
        .where(
          and(
            eq(goodsReceipts.branchId, input.branchId),
            input.purchaseOrderId == null
              ? undefined
              : eq(goodsReceipts.purchaseOrderId, input.purchaseOrderId),
          ),
        )
        // الأحدث أولاً (مراجعة Codex على #1001): سقفٌ ٢٠٠ بلا ترقيمِ صفحات — ترتيبٌ تصاعديّ
        // كان يُسقط أيّ إذنٍ جديد بعد أن يتجاوز الفرع ٢٠٠ إذن، فيصير غير قابلٍ للعكس أبداً.
        .orderBy(desc(goodsReceipts.receivedAt), desc(goodsReceipts.id))
        .limit(limit),
    { gate: "NONE" },
  );
}

export async function listPendingGoodsReceiptReversals(
  branchId: number,
  actor: Actor,
) {
  if (actor.role !== "admin" && actor.branchId !== branchId)
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "لا يمكنك عرض طلبات عكس الاستلام في فرع آخر",
        why: `الطلب يخصّ الفرع رقم ${branchId} وأنت مُسنَدٌ إلى الفرع رقم ${actor.branchId ?? "غير محدَّد"}`,
        doThis: "بدّل الفرع في الشاشة إلى فرعك، أو اطلب من المدير مراجعة طلبات الفرع الآخر (عبورُ الفروع له وحده)",
      }),
    });
  // ⭐ لا فلترةَ بـ`requestedBy` هنا (خلافاً لنسخةٍ سابقة كانت تستعمل `ne(...)`) — مطابقةً
  // لنمط `listPendingPurchaseChargeControls`/نظائرها: القائمة الخادميّة تُرجع كل المعلَّق
  // في الفرع بلا استثناء، والعميلُ (`GovernanceApprovalQueue`) هو من يقرّر زرّ الاعتماد
  // عبر `isOwner`/`canReviewGovernanceRequest` — فلترةٌ خادميّة هنا كانت تُخفي طلب المالك
  // عن نفسه فلا يظهر زرٌّ ليُعتمَد أصلاً، رغم أنّ طبقة القرار تسمح له.
  return withTx(
    (tx) =>
      tx
        .select()
        .from(goodsReceiptReversalRequests)
        .where(
          and(
            eq(goodsReceiptReversalRequests.branchId, branchId),
            eq(goodsReceiptReversalRequests.status, "PENDING"),
          ),
        )
        .orderBy(asc(goodsReceiptReversalRequests.requestedAt)),
    { gate: "NONE" },
  );
}
