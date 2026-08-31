import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  goodsReceiptItems,
  goodsReceipts,
  purchaseControlSettings,
  purchaseOrderRevisionItems,
  purchaseOrderRevisions,
  purchaseOrders,
  supplierInvoiceApprovalRequests,
  supplierInvoiceLines,
  supplierInvoiceMatchAllocations,
  supplierInvoiceMatchRuns,
  supplierInvoices,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { money, round2, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";
import { sha256, stableCanonical } from "./grniAccounting";
import { assertPurchaseBranch } from "./internal";
import { allocateRoundedMoneyByWeight } from "./supplierInvoiceDraftPolicy";
import { lockSupplierInvoiceChainTx } from "./supplierInvoices";

export interface RunThreeWayMatchInput {
  supplierInvoiceId: number;
  expectedInvoiceVersion: number;
  matchKey: string;
  allocations: Array<{
    supplierInvoiceLineId: number;
    goodsReceiptItemId: number;
    matchedBaseQuantity: number;
  }>;
}

function requiredKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 160)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مفتاح تشغيل المطابقة مطلوب وبحد أقصى 160 محرفاً",
    });
  return key;
}

export function allocateSupplierInvoiceLineNetAcrossMatches(input: {
  lineNetAmount: string | number | Decimal;
  invoicedBaseQuantity: number;
  matches: Array<{ matchedBaseQuantity: number; stableKey: number }>;
}): Decimal[] {
  if (
    !Number.isSafeInteger(input.invoicedBaseQuantity) ||
    input.invoicedBaseQuantity <= 0
  ) {
    throw new Error("invoiced base quantity must be a positive integer");
  }
  if (
    input.matches.some(
      (match) =>
        !Number.isSafeInteger(match.matchedBaseQuantity) ||
        match.matchedBaseQuantity <= 0,
    )
  ) {
    throw new Error("matched base quantities must be positive integers");
  }
  const matchedBaseQuantity = input.matches.reduce(
    (sum, match) => sum + match.matchedBaseQuantity,
    0,
  );
  if (matchedBaseQuantity > input.invoicedBaseQuantity) {
    throw new Error("matched base quantity exceeds the supplier invoice line");
  }
  const lineNetAmount =
    input.lineNetAmount instanceof Decimal
      ? input.lineNetAmount
      : money(input.lineNetAmount);
  const matchedTarget = round2(
    lineNetAmount
      .times(matchedBaseQuantity)
      .dividedBy(input.invoicedBaseQuantity),
  );
  return allocateRoundedMoneyByWeight(
    matchedTarget,
    input.matches.map((match) => match.matchedBaseQuantity),
    input.matches.map((match) => match.stableKey),
  );
}

export async function runThreeWayMatch(
  input: RunThreeWayMatchInput,
  actor: Actor,
) {
  const matchKey = requiredKey(input.matchKey);
  if (
    !Number.isSafeInteger(input.expectedInvoiceVersion) ||
    input.expectedInvoiceVersion <= 0
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "نسخة فاتورة المورد المتوقعة غير صالحة",
    });
  }
  if (!input.allocations.length)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "أضف تخصيص استلام واحداً على الأقل",
    });
  const allocations = input.allocations
    .map((allocation) => {
      if (
        !Number.isSafeInteger(allocation.supplierInvoiceLineId) ||
        allocation.supplierInvoiceLineId <= 0 ||
        !Number.isSafeInteger(allocation.goodsReceiptItemId) ||
        allocation.goodsReceiptItemId <= 0 ||
        !Number.isSafeInteger(allocation.matchedBaseQuantity) ||
        allocation.matchedBaseQuantity <= 0
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "تخصيص المطابقة يحمل معرّفاً أو كمية أساس غير صالحة",
        });
      }
      return { ...allocation };
    })
    .sort(
      (a, b) =>
        a.supplierInvoiceLineId - b.supplierInvoiceLineId ||
        a.goodsReceiptItemId - b.goodsReceiptItemId,
    );
  const pairs = new Set(
    allocations.map(
      (allocation) =>
        `${allocation.supplierInvoiceLineId}:${allocation.goodsReceiptItemId}`,
    ),
  );
  if (pairs.size !== allocations.length)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا يجوز تكرار زوج بند الفاتورة/بند الاستلام",
    });

  return withTx(async (tx) => {
    const existing = (
      await tx
        .select()
        .from(supplierInvoiceMatchRuns)
        .where(eq(supplierInvoiceMatchRuns.matchKey, matchKey))
        .limit(1)
    )[0];
    if (existing) {
      if (Number(existing.supplierInvoiceId) !== input.supplierInvoiceId)
        throw new TRPCError({
          code: "CONFLICT",
          message: "مفتاح المطابقة مستعمل لفاتورة أخرى",
        });
      const existingAllocations = await tx
        .select()
        .from(supplierInvoiceMatchAllocations)
        .where(
          eq(supplierInvoiceMatchAllocations.matchRunId, Number(existing.id)),
        )
        .orderBy(
          asc(supplierInvoiceMatchAllocations.supplierInvoiceLineId),
          asc(supplierInvoiceMatchAllocations.goodsReceiptItemId),
        );
      const replayShape = existingAllocations.map((row) => ({
        supplierInvoiceLineId: Number(row.supplierInvoiceLineId),
        goodsReceiptItemId: Number(row.goodsReceiptItemId),
        matchedBaseQuantity: Number(row.matchedBaseQuantity),
      }));
      if (stableCanonical(replayShape) !== stableCanonical(allocations))
        throw new TRPCError({
          code: "CONFLICT",
          message: "مفتاح المطابقة مستعمل بتخصيصات مختلفة",
        });
      return {
        ...existing,
        allocations: existingAllocations,
        idempotentReplay: true as const,
      };
    }

    // Global lock order: PO(s) -> supplier -> invoice -> request -> GRN -> items.
    const { invoice } = await lockSupplierInvoiceChainTx(
      tx,
      input.supplierInvoiceId,
    );
    assertPurchaseBranch(invoice, actor);
    if (Number(invoice.version) !== input.expectedInvoiceVersion)
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيّرت فاتورة المورد؛ أعد تحميلها قبل المطابقة",
      });
    if (
      !(["DRAFT", "ON_HOLD", "MATCHED"] as const).includes(
        invoice.status as "DRAFT" | "ON_HOLD" | "MATCHED",
      )
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "الفاتورة المرحلة أو المعكوسة لا تقبل تشغيل مطابقة جديداً",
      });
    }
    const pendingApproval = (
      await tx
        .select({ id: supplierInvoiceApprovalRequests.id })
        .from(supplierInvoiceApprovalRequests)
        .where(
          and(
            eq(
              supplierInvoiceApprovalRequests.supplierInvoiceId,
              input.supplierInvoiceId,
            ),
            eq(supplierInvoiceApprovalRequests.status, "PENDING"),
          ),
        )
        .orderBy(asc(supplierInvoiceApprovalRequests.id))
        .for("update")
        .limit(1)
    )[0];
    if (pendingApproval) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "لا يمكن إعادة المطابقة أثناء وجود طلب اعتماد فاتورة معلّق",
      });
    }
    const invoiceLines = await tx
      .select()
      .from(supplierInvoiceLines)
      .where(
        eq(supplierInvoiceLines.supplierInvoiceId, input.supplierInvoiceId),
      )
      .orderBy(asc(supplierInvoiceLines.id))
      .for("update");
    const invoiceLineById = new Map(
      invoiceLines.map((line) => [Number(line.id), line] as const),
    );
    if (
      allocations.some(
        (allocation) => !invoiceLineById.has(allocation.supplierInvoiceLineId),
      )
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "أحد تخصيصات المطابقة لا يخص فاتورة المورد",
      });
    }

    const grnItemIds = Array.from(
      new Set(allocations.map((allocation) => allocation.goodsReceiptItemId)),
    ).sort((a, b) => a - b);
    const grnRows = await tx
      .select({ item: goodsReceiptItems, receipt: goodsReceipts })
      .from(goodsReceiptItems)
      .innerJoin(
        goodsReceipts,
        eq(goodsReceipts.id, goodsReceiptItems.goodsReceiptId),
      )
      .where(inArray(goodsReceiptItems.id, grnItemIds))
      .orderBy(asc(goodsReceipts.id), asc(goodsReceiptItems.id))
      .for("update");
    if (grnRows.length !== grnItemIds.length)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "أحد بنود إذن الاستلام غير موجود",
      });
    const grnById = new Map(
      grnRows.map((row) => [Number(row.item.id), row] as const),
    );
    for (const row of grnRows) {
      if (
        Number(row.receipt.supplierId) !== Number(invoice.supplierId) ||
        Number(row.receipt.branchId) !== Number(invoice.branchId) ||
        row.receipt.currency !== invoice.currency
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "المطابقة تتطلب المورد والفرع والعملة نفسها في الفاتورة وكل أذون الاستلام",
        });
      }
      if (row.receipt.status === "REVERSED")
        throw new TRPCError({
          code: "CONFLICT",
          message: "لا يمكن المطابقة إلى إذن استلام معكوس",
        });
    }

    const activeAllocatedRows = await tx
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
            grnItemIds,
          ),
          ne(
            supplierInvoiceMatchRuns.supplierInvoiceId,
            input.supplierInvoiceId,
          ),
          inArray(supplierInvoices.status, ["MATCHED", "POSTED"]),
        ),
      )
      .groupBy(supplierInvoiceMatchAllocations.goodsReceiptItemId)
      .for("update");
    const activeAllocated = new Map(
      activeAllocatedRows.map((row) => [
        Number(row.goodsReceiptItemId),
        Number(row.allocated),
      ]),
    );

    const revisionItemIds = Array.from(
      new Set(
        invoiceLines
          .map((line) => Number(line.purchaseOrderRevisionItemId))
          .filter((id) => id > 0),
      ),
    );
    if (revisionItemIds.length !== invoiceLines.length)
      throw new TRPCError({
        code: "CONFLICT",
        message: "كل بند فاتورة أصلية يحتاج بند نسخة أمر شراء",
      });
    const revisionRows = await tx
      .select({
        item: purchaseOrderRevisionItems,
        revision: purchaseOrderRevisions,
        order: purchaseOrders,
      })
      .from(purchaseOrderRevisionItems)
      .innerJoin(
        purchaseOrderRevisions,
        eq(purchaseOrderRevisions.id, purchaseOrderRevisionItems.revisionId),
      )
      .innerJoin(
        purchaseOrders,
        eq(purchaseOrders.id, purchaseOrderRevisions.purchaseOrderId),
      )
      .where(inArray(purchaseOrderRevisionItems.id, revisionItemIds))
      .orderBy(asc(purchaseOrders.id), asc(purchaseOrderRevisionItems.id))
      .for("update");
    if (revisionRows.length !== revisionItemIds.length)
      throw new TRPCError({
        code: "CONFLICT",
        message: "دليل نسخة أمر الشراء مفقود",
      });
    const revisionByItemId = new Map(
      revisionRows.map((row) => [Number(row.item.id), row] as const),
    );
    for (const row of revisionRows) {
      if (
        Number(row.order.approvedRevisionId) !== Number(row.revision.id) ||
        Number(row.order.supplierId) !== Number(invoice.supplierId) ||
        Number(row.order.branchId) !== Number(invoice.branchId) ||
        row.order.agreedCurrency !== invoice.currency
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "نسخة أمر شراء غير معتمدة أو لا تطابق المورد/الفرع/العملة",
        });
      }
    }

    const allocatedPerLine = new Map<number, number>();
    const allocatedPerGrn = new Map<number, number>();
    for (const allocation of allocations) {
      const invoiceLine = invoiceLineById.get(
        allocation.supplierInvoiceLineId,
      )!;
      const grn = grnById.get(allocation.goodsReceiptItemId)!;
      if (
        invoiceLine.purchaseOrderRevisionItemId == null ||
        grn.item.purchaseOrderRevisionItemId == null ||
        Number(invoiceLine.purchaseOrderRevisionItemId) !==
          Number(grn.item.purchaseOrderRevisionItemId)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "بند الفاتورة وبند الاستلام لا يعودان إلى بند النسخة المعتمدة نفسه",
        });
      }
      const nextLine =
        (allocatedPerLine.get(allocation.supplierInvoiceLineId) ?? 0) +
        allocation.matchedBaseQuantity;
      if (nextLine > Number(invoiceLine.invoicedBaseQuantity))
        throw new TRPCError({
          code: "CONFLICT",
          message: "التخصيص يتجاوز كمية بند الفاتورة",
        });
      allocatedPerLine.set(allocation.supplierInvoiceLineId, nextLine);
      const nextGrn =
        (allocatedPerGrn.get(allocation.goodsReceiptItemId) ?? 0) +
        allocation.matchedBaseQuantity;
      const grnAvailable =
        Number(grn.item.acceptedBaseQuantity) -
        Number(grn.item.reversedBaseQuantity) -
        Number(grn.item.returnedBaseQuantity) -
        (activeAllocated.get(allocation.goodsReceiptItemId) ?? 0);
      if (nextGrn > grnAvailable)
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "التخصيص يتجاوز صافي الكمية المقبولة غير المفوترة في إذن الاستلام",
        });
      allocatedPerGrn.set(allocation.goodsReceiptItemId, nextGrn);
    }

    const matchedInvoiceAmountByPair = new Map<string, Decimal>();
    for (const line of invoiceLines) {
      const lineAllocations = allocations.filter(
        (allocation) => allocation.supplierInvoiceLineId === Number(line.id),
      );
      if (!lineAllocations.length) continue;
      const matchedAmounts = allocateSupplierInvoiceLineNetAcrossMatches({
        lineNetAmount: line.netAmount,
        invoicedBaseQuantity: Number(line.invoicedBaseQuantity),
        matches: lineAllocations.map((allocation) => ({
          matchedBaseQuantity: allocation.matchedBaseQuantity,
          stableKey: allocation.goodsReceiptItemId,
        })),
      });
      lineAllocations.forEach((allocation, index) => {
        matchedInvoiceAmountByPair.set(
          `${allocation.supplierInvoiceLineId}:${allocation.goodsReceiptItemId}`,
          matchedAmounts[index]!,
        );
      });
    }

    const settings = (
      await tx
        .select()
        .from(purchaseControlSettings)
        .where(eq(purchaseControlSettings.branchId, Number(invoice.branchId)))
        .for("update")
        .limit(1)
    )[0];
    const policy = {
      version: Math.max(Number(settings?.version ?? 0), 1),
      priceTolerancePercent: money(
        settings?.priceTolerancePercent ?? "0",
      ).toFixed(4),
      quantityToleranceBase: 0,
      totalToleranceAmount: money(
        settings?.totalToleranceAmount ?? "0",
      ).toFixed(2),
      holdIsHard: true,
    } as const;
    const policySnapshot = stableCanonical(policy);
    const policyHash = sha256(policySnapshot);

    let poTotal = money(0);
    let grnTotal = money(0);
    let matchedInvoiceNet = money(0);
    let priceVariance = money(0);
    let maxPriceVariancePercent = money(0);
    const allocationEvidence: Array<Record<string, unknown>> = [];
    for (const allocation of allocations) {
      const line = invoiceLineById.get(allocation.supplierInvoiceLineId)!;
      const grn = grnById.get(allocation.goodsReceiptItemId)!;
      const revision = revisionByItemId.get(
        Number(line.purchaseOrderRevisionItemId),
      )!;
      const poBaseUnitPrice = round2(
        money(revision.item.lineTotal).dividedBy(
          Number(revision.item.baseQuantity),
        ),
      );
      const grnBaseUnitPrice = money(grn.item.unitCostIqd);
      const invoiceBaseUnitPrice = money(line.netAmount).dividedBy(
        Number(line.invoicedBaseQuantity),
      );
      const quantity = new Decimal(allocation.matchedBaseQuantity);
      const allocationPo = round2(poBaseUnitPrice.times(quantity));
      const allocationGrn = round2(grnBaseUnitPrice.times(quantity));
      const allocationInvoice = matchedInvoiceAmountByPair.get(
        `${allocation.supplierInvoiceLineId}:${allocation.goodsReceiptItemId}`,
      )!;
      const allocationPriceVariance = round2(
        allocationInvoice.minus(allocationPo),
      );
      const pricePct = poBaseUnitPrice.isZero()
        ? invoiceBaseUnitPrice.isZero()
          ? money(0)
          : money("9999999")
        : invoiceBaseUnitPrice
            .minus(poBaseUnitPrice)
            .abs()
            .dividedBy(poBaseUnitPrice)
            .times(100);
      maxPriceVariancePercent = Decimal.max(maxPriceVariancePercent, pricePct);
      poTotal = poTotal.plus(allocationPo);
      grnTotal = grnTotal.plus(allocationGrn);
      matchedInvoiceNet = matchedInvoiceNet.plus(allocationInvoice);
      priceVariance = priceVariance.plus(allocationPriceVariance);
      allocationEvidence.push({
        supplierInvoiceLineId: allocation.supplierInvoiceLineId,
        goodsReceiptItemId: allocation.goodsReceiptItemId,
        purchaseOrderRevisionItemId: Number(line.purchaseOrderRevisionItemId),
        goodsReceiptId: Number(grn.receipt.id),
        goodsReceiptVersion: Number(grn.receipt.version),
        matchedBaseQuantity: allocation.matchedBaseQuantity,
        poUnitPriceIqd: toDbMoney(poBaseUnitPrice),
        grnUnitCostIqd: toDbMoney(grnBaseUnitPrice),
        invoiceUnitPriceIqd: toDbMoney(round2(invoiceBaseUnitPrice)),
        matchedAmount: toDbMoney(allocationInvoice),
        priceVarianceAmount: toDbMoney(allocationPriceVariance),
      });
    }
    poTotal = round2(poTotal);
    grnTotal = round2(grnTotal);
    matchedInvoiceNet = round2(matchedInvoiceNet);
    priceVariance = round2(priceVariance);
    const invoicedBaseQuantity = invoiceLines.reduce(
      (sum, line) => sum + Number(line.invoicedBaseQuantity),
      0,
    );
    const receivedBaseQuantity = allocations.reduce(
      (sum, allocation) => sum + allocation.matchedBaseQuantity,
      0,
    );
    const orderedBaseQuantity = revisionRows.reduce(
      (sum, row) => sum + Number(row.item.baseQuantity),
      0,
    );
    const quantityVarianceBase = invoicedBaseQuantity - receivedBaseQuantity;
    const totalVariance = round2(money(invoice.totalAmount).minus(grnTotal));
    const holdCodes: string[] = [];
    if (Math.abs(quantityVarianceBase) > policy.quantityToleranceBase)
      holdCodes.push("QUANTITY_MISMATCH");
    if (maxPriceVariancePercent.gt(policy.priceTolerancePercent))
      holdCodes.push("PRICE_TOLERANCE_EXCEEDED");
    if (totalVariance.abs().gt(policy.totalToleranceAmount))
      holdCodes.push("TOTAL_TOLERANCE_EXCEEDED");
    const exact =
      quantityVarianceBase === 0 &&
      priceVariance.isZero() &&
      totalVariance.isZero();
    const outcome: "EXACT" | "WITHIN_TOLERANCE" | "HOLD" = holdCodes.length
      ? "HOLD"
      : exact
        ? "EXACT"
        : "WITHIN_TOLERANCE";
    const poRevisionSet = revisionRows
      .map((row) => ({
        id: Number(row.revision.id),
        payloadHash: row.revision.payloadHash,
      }))
      .sort((a, b) => a.id - b.id);
    const receiptSet = Array.from(
      new Map(
        grnRows.map((row) => [
          Number(row.receipt.id),
          {
            id: Number(row.receipt.id),
            version: Number(row.receipt.version),
            payloadHash: row.receipt.payloadHash,
          },
        ]),
      ).values(),
    ).sort((a, b) => a.id - b.id);
    const poRevisionSetHash = sha256(stableCanonical(poRevisionSet));
    const goodsReceiptSetHash = sha256(stableCanonical(receiptSet));
    const evidenceSnapshot = stableCanonical({
      invoice: {
        id: Number(invoice.id),
        version: Number(invoice.version),
        payloadHash: invoice.payloadHash,
        totalAmount: invoice.totalAmount,
      },
      policy,
      poRevisions: poRevisionSet,
      goodsReceipts: receiptSet,
      allocations: allocationEvidence,
      totals: {
        orderedBaseQuantity,
        receivedBaseQuantity,
        invoicedBaseQuantity,
        quantityVarianceBase,
        poTotal: toDbMoney(poTotal),
        grnTotal: toDbMoney(grnTotal),
        matchedInvoiceNet: toDbMoney(matchedInvoiceNet),
        invoiceTotal: invoice.totalAmount,
        priceVarianceAmount: toDbMoney(priceVariance),
        totalVarianceAmount: toDbMoney(totalVariance),
      },
      holdCodes,
    });
    const evidenceHash = sha256(evidenceSnapshot);
    const latest = (
      await tx
        .select({ runNo: supplierInvoiceMatchRuns.runNo })
        .from(supplierInvoiceMatchRuns)
        .where(
          eq(
            supplierInvoiceMatchRuns.supplierInvoiceId,
            input.supplierInvoiceId,
          ),
        )
        .orderBy(desc(supplierInvoiceMatchRuns.runNo))
        .for("update")
        .limit(1)
    )[0];
    const runNo = Number(latest?.runNo ?? 0) + 1;
    const inserted = await tx.insert(supplierInvoiceMatchRuns).values({
      matchKey,
      supplierInvoiceId: input.supplierInvoiceId,
      supplierId: Number(invoice.supplierId),
      branchId: Number(invoice.branchId),
      runNo,
      outcome,
      policyVersion: policy.version,
      policySnapshot,
      policyHash,
      poRevisionSetHash,
      goodsReceiptSetHash,
      invoiceHash: invoice.payloadHash,
      priceTolerancePercent: policy.priceTolerancePercent,
      quantityToleranceBase: policy.quantityToleranceBase,
      totalToleranceAmount: policy.totalToleranceAmount,
      orderedBaseQuantity,
      receivedBaseQuantity,
      invoicedBaseQuantity,
      poTotal: toDbMoney(poTotal),
      grnTotal: toDbMoney(grnTotal),
      invoiceTotal: invoice.totalAmount,
      quantityVarianceBase,
      priceVarianceAmount: toDbMoney(priceVariance),
      totalVarianceAmount: toDbMoney(totalVariance),
      outcomeReason:
        outcome === "HOLD" ? `مطابقة محجوزة: ${holdCodes.join(", ")}` : null,
      holdCodes,
      evidenceSnapshot,
      evidenceHash,
      performedBy: actor.userId,
    });
    const matchRunId = extractInsertId(inserted);
    await tx.insert(supplierInvoiceMatchAllocations).values(
      allocationEvidence.map((row) => ({
        matchRunId,
        supplierInvoiceLineId: Number(row.supplierInvoiceLineId),
        purchaseOrderRevisionItemId: Number(row.purchaseOrderRevisionItemId),
        goodsReceiptItemId: Number(row.goodsReceiptItemId),
        matchedBaseQuantity: Number(row.matchedBaseQuantity),
        poUnitPriceIqd: String(row.poUnitPriceIqd),
        grnUnitCostIqd: String(row.grnUnitCostIqd),
        invoiceUnitPriceIqd: String(row.invoiceUnitPriceIqd),
        quantityVarianceBase: 0,
        priceVarianceAmount: String(row.priceVarianceAmount),
        matchedAmount: String(row.matchedAmount),
      })),
    );
    await tx
      .update(supplierInvoices)
      .set({
        status: outcome === "HOLD" ? "ON_HOLD" : "MATCHED",
        holdReason:
          outcome === "HOLD" ? `مطابقة محجوزة: ${holdCodes.join(", ")}` : null,
      })
      .where(eq(supplierInvoices.id, input.supplierInvoiceId));
    return {
      matchRunId,
      runNo,
      outcome,
      holdCodes,
      evidenceHash,
      invoiceVersionAfterMatch: input.expectedInvoiceVersion + 1,
      idempotentReplay: false as const,
    };
  });
}

export async function getThreeWayMatch(matchRunId: number, actor: Actor) {
  return withTx(
    async (tx) => {
      const run = (
        await tx
          .select()
          .from(supplierInvoiceMatchRuns)
          .where(eq(supplierInvoiceMatchRuns.id, matchRunId))
          .limit(1)
      )[0];
      if (!run)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "تشغيل المطابقة غير موجود",
        });
      assertPurchaseBranch(run, actor);
      const allocations = await tx
        .select()
        .from(supplierInvoiceMatchAllocations)
        .where(eq(supplierInvoiceMatchAllocations.matchRunId, matchRunId))
        .orderBy(
          asc(supplierInvoiceMatchAllocations.supplierInvoiceLineId),
          asc(supplierInvoiceMatchAllocations.goodsReceiptItemId),
        );
      return { run, allocations };
    },
    { gate: "NONE" },
  );
}
