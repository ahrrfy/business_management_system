import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, eq, inArray, like, ne, sql } from "drizzle-orm";
import {
  branchStock,
  goodsReceiptItems,
  goodsReceiptReversalItems,
  goodsReceiptReversalRequestItems,
  goodsReceiptReversalRequests,
  goodsReceiptReversals,
  goodsReceipts,
  productVariants,
  purchaseOrderItems,
  purchaseOrderRevisionItems,
  purchaseOrderRevisions,
  purchaseOrders,
  supplierInvoiceMatchAllocations,
  supplierInvoiceMatchRuns,
  supplierInvoices,
  suppliers,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
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
    throw new TRPCError({ code: "BAD_REQUEST", message: `${label} مطلوب` });
  if (normalized.length > max) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${label} يجب ألا يتجاوز ${max} محرفاً`,
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
        message: `${label} غير صالح`,
      });
    }
    if (seen.has(value)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `لا يجوز تكرار ${label}`,
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
    throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشراء غير موجود" });
  assertPurchaseBranch(po, actor);
  const supplier = (
    await tx
      .select({ id: suppliers.id, isActive: suppliers.isActive })
      .from(suppliers)
      .where(eq(suppliers.id, Number(po.supplierId)))
      .for("update")
      .limit(1)
  )[0];
  if (!supplier || !supplier.isActive) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "المورد غير موجود أو غير نشط",
    });
  }
  if (po.approvedRevisionId == null) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "لا يمكن الاستلام قبل اعتماد نسخة أمر الشراء",
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
      message: "نسخة أمر الشراء المعتمدة مفقودة أو لا تخص الأمر",
    });
  }
  return { po, revision };
}

export async function createGoodsReceipt(
  input: CreateGoodsReceiptInput,
  actor: Actor,
) {
  const requestKey = requireText(input.clientRequestId, "مفتاح الطلب", 120);
  if (
    !Number.isSafeInteger(input.expectedOrderVersion) ||
    input.expectedOrderVersion <= 0
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "نسخة أمر الشراء المتوقعة غير صالحة",
    });
  }
  if (!input.lines.length)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "أضف بند استلام واحداً على الأقل",
    });
  if (input.lines.length > 50) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "الاستلام الواحد يدعم 50 بنداً كحد أقصى؛ قسّم الإذن الكبير إلى دفعات",
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
          message: "كميات الاستلام يجب أن تكون أعداد أساس صحيحة وغير سالبة",
        });
      }
      const rejectionReason = line.rejectionReason?.trim() || null;
      if (rejected > 0 && !rejectionReason) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "سبب رفض الكمية مطلوب",
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

  return withTx(async (tx) => {
    const existing = (
      await tx
        .select()
        .from(goodsReceipts)
        .where(eq(goodsReceipts.clientRequestId, requestKey))
        .limit(1)
    )[0];
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "مفتاح الطلب مستعمل بحمولة استلام مختلفة",
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
        message: "تغيّر أمر الشراء؛ أعد تحميله قبل الاستلام",
      });
    }
    if (
      Number(po.approvedRevisionId) !== input.purchaseOrderRevisionId ||
      Number(revision.id) !== input.purchaseOrderRevisionId
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "الاستلام مسموح للنسخة المعتمدة الحالية فقط",
      });
    }
    if (
      !(["CONFIRMED", "RECEIVED"] as const).includes(
        po.status as "CONFIRMED" | "RECEIVED",
      )
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "حالة أمر الشراء لا تسمح بالاستلام",
      });
    }
    if (
      [po.createdBy, po.approvedBy].some(
        (id) => id != null && Number(id) === actor.userId,
      )
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "فصل المهام: منشئ أو معتمد أمر الشراء لا يستلم بضاعته",
      });
    }
    if (!money(revision.taxAmount).isZero()) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "GRNI الحالي يدعم سياسة الضريبة العراقية الصفرية فقط",
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
        message: "بنود الأمر لا تطابق لقطة النسخة المعتمدة",
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
          message: "إسقاط بنود الأمر على النسخة المعتمدة غير متسق",
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
          message: "بند الاستلام لا يخص أمر الشراء",
        });
      const priorAccepted = acceptedByItem.get(line.purchaseOrderItemId) ?? 0;
      if (
        priorAccepted + line.acceptedBaseQuantity >
        Number(snapshot.baseQuantity)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `الكمية المقبولة تتجاوز المعتمد في السطر ${snapshot.lineNo}`,
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
              message: "لقطة السطر الدولارية مفقودة",
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
            message: "لا يمكن استلام بند خدمي أو بلا حركة مخزون",
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
  });
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
      message: "حدد بنداً واحداً على الأقل للعكس",
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
          message: "كمية العكس يجب أن تكون عدداً صحيحاً موجباً",
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
      if (existing.payloadHash !== payloadHash)
        throw new TRPCError({
          code: "CONFLICT",
          message: "مفتاح طلب العكس مستعمل بحمولة مختلفة",
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
        message: "إذن الاستلام غير موجود",
      });
    assertPurchaseBranch(receipt, actor);
    if (receipt.origin !== "NATIVE")
      throw new TRPCError({
        code: "CONFLICT",
        message: "الإذن التاريخي المجمّع لا يُعكس قبل تفكيكه إلى مستندات أصلية",
      });
    if (Number(receipt.version) !== input.expectedReceiptVersion)
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيّر إذن الاستلام؛ أعد تحميله",
      });
    if (receipt.status === "REVERSED")
      throw new TRPCError({
        code: "CONFLICT",
        message: "إذن الاستلام معكوس بالكامل",
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
        message: "أحد بنود العكس لا يخص إذن الاستلام",
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
          message: "كمية العكس تتجاوز المقبول المتاح",
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
        message: "طلب العكس غير موجود",
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
        message: "إذن الاستلام غير موجود",
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
          message: "طلب العكس حُسم بقرار مختلف",
        });
      }
      return {
        requestId: input.requestId,
        status: request.status,
        idempotentReplay: true as const,
      };
    }
    if (request.status !== "PENDING")
      throw new TRPCError({ code: "CONFLICT", message: "طلب العكس غير معلّق" });
    if (
      Number(request.requestedBy) === actor.userId ||
      Number(receipt.createdBy) === actor.userId ||
      Number(receipt.postedBy) === actor.userId ||
      Number(po.createdBy) === actor.userId ||
      Number(po.approvedBy) === actor.userId
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "فصل المهام: منفذ الاستلام أو منشئ الطلب/الأمر لا يعتمد العكس",
      });
    }
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
          message: "لا يمكن عكس كمية خُصصت لفاتورة مورد أو لم تعد متاحة",
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
          message: "تعذر إنشاء حركة عكس المخزون",
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
          message: "إذن الاستلام غير موجود",
        });
      assertPurchaseBranch(receipt, actor);
      const items = await tx
        .select()
        .from(goodsReceiptItems)
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
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك عرض فرع آخر" });
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
        .orderBy(asc(goodsReceipts.receivedAt), asc(goodsReceipts.id))
        .limit(limit),
    { gate: "NONE" },
  );
}

export async function listPendingGoodsReceiptReversals(
  branchId: number,
  actor: Actor,
) {
  if (actor.role !== "admin" && actor.branchId !== branchId)
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك عرض فرع آخر" });
  return withTx(
    (tx) =>
      tx
        .select()
        .from(goodsReceiptReversalRequests)
        .where(
          and(
            eq(goodsReceiptReversalRequests.branchId, branchId),
            eq(goodsReceiptReversalRequests.status, "PENDING"),
            ne(goodsReceiptReversalRequests.requestedBy, actor.userId),
          ),
        )
        .orderBy(asc(goodsReceiptReversalRequests.requestedAt)),
    { gate: "NONE" },
  );
}
