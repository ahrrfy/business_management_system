import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { isDupEntry } from "@shared/errorMap.ar";
import { appErrorMessage } from "@shared/errors";
import {
  productUnits,
  purchaseReturnRequests,
  purchaseReturnRequestItems,
  suppliers,
  users,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { withTx, type Actor } from "../tx";
import { money, round2, toDbMoney } from "../money";
import {
  lockEconomicInventoryScope,
  readEconomicVariant,
} from "../inventory/economicOwnership";
import { assertPurchaseBranch } from "./internal";
import { sha256, stableCanonical } from "./grniAccounting";
import { returnConflict } from "./returnEvidence";

export type ReturnCashRoute =
  | { cashBucket: "DRAWER"; shiftId: number }
  | { cashBucket: "TREASURY"; shiftId?: null };
export interface ExceptionReturnInput {
  sourceKind: "OWNER_EXCEPTION";
  supplierId: number;
  branchId: number;
  requestKey: string;
  settlement: "CREDIT" | "CASH";
  paymentMethod: "CASH" | "CARD" | "TRANSFER" | "WALLET";
  cashRoute?: ReturnCashRoute;
  externalReference?: string;
  evidenceType:
    | "RETURN_NOTE"
    | "SUPPLIER_ACKNOWLEDGEMENT"
    | "DOCUMENT_IMAGE"
    | "PDF"
    | "EMAIL"
    | "OTHER";
  evidenceReference: string;
  reason: string;
  expectedTotal?: string;
  lines: Array<{
    variantId: number;
    productUnitId?: number;
    quantity: number;
    agreedUnitPrice: string;
    reason?: string | null;
  }>;
}
export type ExceptionLine = {
  version: 1;
  priceBasis: "AGREED_EXCEPTION";
  variantId: number;
  productUnitId: number | null;
  quantity: number;
  conversionFactor: string;
  baseQuantity: number;
  agreedUnitPrice: string;
  unitName: string;
  netAmount: string;
};

// Only raised for a validation throw inside the uncommitted creation callback,
// after a current replay read proves this key absent. Never wraps commit errors.
export class RejectedReturnProposal extends TRPCError {}

export async function createExceptionReturnRequest(
  input: ExceptionReturnInput,
  actor: Actor,
) {
  if (
    !input.requestKey.trim() ||
    input.requestKey.length > 64 ||
    input.reason.trim().length < 3 ||
    !input.evidenceReference.trim() ||
    input.evidenceReference.length > 500 ||
    !input.lines.length ||
    input.lines.length > 500 ||
    !Number.isSafeInteger(input.branchId) ||
    input.branchId < 1 ||
    !Number.isSafeInteger(input.supplierId) ||
    input.supplierId < 1
  )
    returnConflict("بيانات المورد أو الفرع أو السبب أو مرجع الدليل غير مكتملة");
  if (
    input.settlement === "CASH" &&
    input.paymentMethod === "CASH" &&
    !input.cashRoute
  )
    returnConflict("حدد مصدر استلام النقد الفعلي: درج مفتوح أو خزينة الفرع");
  if (
    input.settlement === "CASH" &&
    input.paymentMethod !== "CASH" &&
    (!input.externalReference?.trim() || input.evidenceType === "RETURN_NOTE")
  )
    returnConflict(
      "الاسترداد غير النقدي يحتاج مرجعاً خارجياً ودليلاً من المورد",
    );
  if (
    input.cashRoute &&
    (input.settlement !== "CASH" || input.paymentMethod !== "CASH")
  )
    returnConflict("مصدر النقد لا يطابق طريقة التسوية");
  const lines = input.lines
    .map((line) => {
      if (
        !Number.isSafeInteger(line.variantId) ||
        line.variantId < 1 ||
        !Number.isSafeInteger(line.quantity) ||
        line.quantity < 1 ||
        !/^\d+(?:\.\d{1,2})?$/.test(line.agreedUnitPrice)
      )
        returnConflict("كمية أو سعر الاتفاق غير صالح");
      return {
        variantId: line.variantId,
        productUnitId: line.productUnitId ?? null,
        quantity: line.quantity,
        agreedUnitPrice: toDbMoney(line.agreedUnitPrice),
        reason: line.reason?.trim() || null,
      };
    })
    .sort(
      (a, b) =>
        a.variantId - b.variantId ||
        (a.productUnitId ?? 0) - (b.productUnitId ?? 0),
    );
  if (
    new Set(lines.map((l) => `${l.variantId}:${l.productUnitId}`)).size !==
    lines.length
  )
    returnConflict("اجمع البنود المتكررة قبل إرسال الطلب");
  const expectedTotal = toDbMoney(
    lines.reduce(
      (s, l) => s.plus(money(l.agreedUnitPrice).times(l.quantity)),
      money(0),
    ),
  );
  if (
    !money(expectedTotal).gt(0) ||
    (input.expectedTotal != null &&
      !money(input.expectedTotal).eq(expectedTotal))
  )
    returnConflict("الإجمالي المرسل لا يطابق مجموع الكميات بأسعار الاتفاق");
  const proposal = {
    sourceKind: input.sourceKind,
    supplierId: input.supplierId,
    branchId: input.branchId,
    settlement: input.settlement,
    paymentMethod: input.paymentMethod,
    cashRoute: input.cashRoute ?? null,
    externalReference: input.externalReference?.trim() || null,
    evidenceType: input.evidenceType,
    evidenceReference: input.evidenceReference.trim(),
    reason: input.reason.trim(),
    lines,
    expectedTotal,
  };
  const canonical = stableCanonical(proposal),
    hash = sha256(canonical);
  const evidenceHash = sha256(
    stableCanonical({
      type: proposal.evidenceType,
      reference: proposal.evidenceReference,
    }),
  );
  const exceptionEvidenceKey = sha256(
    stableCanonical({
      supplierId: input.supplierId,
      branchId: input.branchId,
      evidenceHash,
    }),
  );
  return withTx(async (tx) => {
    const replay = async (current = false) => {
      const q = tx
        .select()
        .from(purchaseReturnRequests)
        .where(eq(purchaseReturnRequests.requestKey, input.requestKey))
        .limit(1);
      const [row] = await (current ? q.for("update") : q);
      if (!row) return null;
      assertPurchaseBranch(row, actor);
      if (row.payloadHash !== hash || row.sourceKind !== "OWNER_EXCEPTION")
        returnConflict("أعيد مفتاح الطلب بمضمون مختلف");
      return {
        requestId: row.id,
        status: row.status,
        idempotent: true as const,
      };
    };
    const prior = await replay();
    if (prior) return prior;
    const [currentActor] = await tx
      .select()
      .from(users)
      .where(eq(users.id, actor.userId))
      .for("share");
    if (!currentActor?.isActive) returnConflict("الحساب غير نشط");
    assertPurchaseBranch(
      { branchId: input.branchId },
      {
        ...actor,
        branchId: currentActor.branchId ?? 0,
        role: currentActor.isOwner ? "admin" : currentActor.role,
      },
    );
    const [supplier] = await tx
      .select()
      .from(suppliers)
      .where(eq(suppliers.id, input.supplierId))
      .for("update");
    if (!supplier?.isActive || supplier.supplierKind !== "REGULAR")
      returnConflict("المورد غير نشط أو ليس مورداً تجارياً عادياً");
    const raced = await replay(true);
    if (raced) return raced;
    const items: Array<{
      lineNo: number;
      supplierInvoiceLineId: null;
      goodsReceiptItemId: null;
      matchAllocationId: null;
      purchaseOrderItemId: null;
      variantId: number;
      requestedBaseQuantity: number;
      unitPriceIqd: string;
      netAmount: string;
      taxAmount: string;
      totalAmount: string;
      sourceSnapshot: string;
      sourceHash: string;
      reason: string | null;
    }> = [];
    try {
      const scope = await lockEconomicInventoryScope(
        tx,
        lines.map((l) => l.variantId),
      );
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        const variant = await readEconomicVariant(tx, scope, line.variantId);
        if (
          !variant.product.isActive ||
          variant.product.isService ||
          variant.product.isBundle ||
          variant.product.isConsignment
        )
          returnConflict(
            "الاستثناء يقبل مخزوناً مملوكاً فعلياً فقط؛ لا خدمات أو بكجات أو أمانة",
          );
        const [unit] =
          line.productUnitId == null
            ? []
            : await tx
                .select()
                .from(productUnits)
                .where(eq(productUnits.id, line.productUnitId))
                .for("share");
        if (
          line.productUnitId != null &&
          (!unit || unit.variantId !== line.variantId)
        )
          returnConflict("وحدة الصنف لا تطابق المنتج");
        const factor = unit?.conversionFactor ?? "1",
          base = money(factor).times(line.quantity);
        if (!base.isInteger() || !base.gt(0) || base.gt(2147483647))
          returnConflict("تحويل الوحدة لا ينتج كمية أساس صحيحة");
        const net = toDbMoney(money(line.agreedUnitPrice).times(line.quantity));
        const snapshot: ExceptionLine = {
          version: 1,
          priceBasis: "AGREED_EXCEPTION",
          variantId: line.variantId,
          productUnitId: line.productUnitId,
          quantity: line.quantity,
          conversionFactor: factor,
          baseQuantity: base.toNumber(),
          agreedUnitPrice: line.agreedUnitPrice,
          unitName: unit?.unitName ?? "وحدة أساس",
          netAmount: net,
        };
        const sourceSnapshot = stableCanonical(snapshot);
        items.push({
          lineNo: index + 1,
          supplierInvoiceLineId: null,
          goodsReceiptItemId: null,
          matchAllocationId: null,
          purchaseOrderItemId: null,
          variantId: line.variantId,
          requestedBaseQuantity: base.toNumber(),
          unitPriceIqd: toDbMoney(money(net).div(base)),
          netAmount: net,
          taxAmount: "0.00",
          totalAmount: net,
          sourceSnapshot,
          sourceHash: sha256(sourceSnapshot),
          reason: line.reason,
        });
      }
    } catch (error) {
      if (
        error instanceof TRPCError &&
        (error.code === "BAD_REQUEST" || error.code === "CONFLICT")
      )
        throw new RejectedReturnProposal({
          code: error.code,
          message: error.message,
          cause: error,
        });
      throw error;
    }
    let requestId: number;
    try {
      requestId = extractInsertId(
        await tx.insert(purchaseReturnRequests).values({
          requestKey: input.requestKey,
          sourceKind: "OWNER_EXCEPTION",
          exceptionEvidenceKey,
          supplierInvoiceId: null,
          matchRunId: null,
          purchaseOrderId: null,
          baseInvoiceVersion: null,
          supplierId: input.supplierId,
          branchId: input.branchId,
          settlement: input.settlement,
          paymentMethod: input.paymentMethod,
          requestedNetAmount: expectedTotal,
          requestedTaxAmount: "0.00",
          requestedTotalAmount: expectedTotal,
          payloadCanonical: canonical,
          payloadHash: hash,
          evidenceType: input.evidenceType,
          evidenceReference: proposal.evidenceReference,
          evidenceHash,
          reason: proposal.reason,
          pendingGuard: `RETURN-EX:${input.supplierId}:${input.branchId}:${evidenceHash}`,
          requestedBy: actor.userId,
        }),
      );
    } catch (error) {
      if (!isDupEntry(error)) throw error;
      const found = await replay(true);
      if (found) return found;
      const [evidenceOwner] = await tx
        .select({ id: purchaseReturnRequests.id })
        .from(purchaseReturnRequests)
        .where(
          eq(purchaseReturnRequests.exceptionEvidenceKey, exceptionEvidenceKey),
        )
        .limit(1)
        .for("share");
      // Only a proven evidence collision with an absent request key permits
      // editing the proposal. Other unique failures keep their original error.
      if (!evidenceOwner) throw error;
      throw new RejectedReturnProposal({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذر تثبيت مرتجع المورد",
          why: "مرجع الدليل مسجل في طلب آخر؛ افتح الطلب الأصلي",
          doThis: "راجع الطلب الأصلي أو صحح مرجع الدليل ثم أعد المحاولة",
        }),
        cause: error,
      });
    }
    await tx
      .insert(purchaseReturnRequestItems)
      .values(items.map((item) => ({ ...item, requestId })));
    return {
      requestId,
      status: "PENDING" as const,
      idempotent: false as const,
    };
  });
}
