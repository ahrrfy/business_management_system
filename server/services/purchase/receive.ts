// استلام أمر الشراء (جزئي/كامل): WAVG بسعر المورّد وحده، تراكم الضريبة،
// قيد PURCHASE + AP للآجل أو clearing للنقدي، واستحقاق شحن عند الاستلام، وطلبات تسوية معلّقة لا تُنفَّذ إلا بعد اعتماد المالك.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { accountingEntries, branchStock, expenses, productVariants, purchaseOrderItems, purchaseOrders, receipts, suppliers, users } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { applyMovement, ensureBranchStockRows } from "../inventoryService";
import { lockInventoryVariants } from "../inventory/stockLock";
import { adjustSupplierBalance, adjustSupplierBalanceUsd, postEntry } from "../ledgerService";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import { money, round2, toDbMoney } from "../money";
import { lockCashSourceForUpdate } from "../cash/cashAvailability";
import type { Tx } from "../../db";
import { withTx, type Actor } from "../tx";
import { createSystemPaymentRequestTx, finalizeOwnerSystemVoucherTx } from "../voucher/create";
import {
  assertPurchaseBranch,
  pendingPurchaseSupplierPaymentsTx,
  purchaseCashSettlementUsesClearingTx,
  purchaseOrderPayableBalanceTx,
} from "./internal";
import type { ReceivePurchaseInput } from "./types";
import { expenseAccrualRecognition } from "../accounting/accrualPosting";
import {
  createAccrualObligationTx,
  transitionAccrualObligationTx,
} from "../accounting/accrualObligations";

export function assertUniqueReceiveLines(lines: Array<{ purchaseOrderItemId: number }>): void {
  const seen = new Set<number>();
  for (const line of lines) {
    if (seen.has(line.purchaseOrderItemId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يجوز تكرار بند أمر الشراء في الاستلام نفسه" });
    }
    seen.add(line.purchaseOrderItemId);
  }
}

export function cumulativePurchaseTax(
  poTax: string,
  priorTax: string,
  receivedNet: Decimal,
  rate: Decimal,
  fullyReceived: boolean,
): Decimal {
  const tax = fullyReceived ? round2(money(poTax).minus(money(priorTax))) : round2(receivedNet.times(rate));
  if (tax.lt(0) || money(priorTax).plus(tax).gt(money(poTax))) {
    throw new TRPCError({ code: "CONFLICT", message: "تراكم ضريبة الاستلام يتجاوز ضريبة أمر الشراء" });
  }
  return tax;
}

interface PostPurchaseOptions {
  /** اعتماد الفاتورة يرحّل كامل المتبقّي آلياً؛ المسار اليدوي القديم يمرّر أسطره صراحةً. */
  autoPostAll?: boolean;
  /** حالات البداية المسموحة قبل الترحيل. الاستلام اليدوي التاريخي يقبل CONFIRMED فقط. */
  allowedStatuses?: ReadonlyArray<"DRAFT" | "SENT" | "CONFIRMED">;
  /** مسار توافق تاريخي فقط؛ التطبيق التلقائي يبقي معتمد الفاتورة مستقلاً عن منشئها. */
  allowCreatorToPost?: boolean;
}

export type PurchasePostingDetails = Pick<
  ReceivePurchaseInput,
  | "shippingPaymentMethod"
  | "shippingPaymentReference"
  | "shippingCardLastFour"
  | "shippingBeneficiarySupplierId"
  | "shippingBeneficiaryName"
  | "shippingEvidenceReference"
>;

/**
 * مسار توافق داخلي للاختبارات والبيانات القديمة. لم يعد مكشوفاً عبر tRPC أو الواجهة؛ مسار
 * التطبيق الوحيد هو `postPurchaseInvoiceInTx` الذي يرحّل كامل الفاتورة مع حفظها/اعتمادها.
 */
export async function receivePurchase(input: ReceivePurchaseInput, actor: Actor & { role?: string }) {
  assertUniqueReceiveLines(input.lines);
  if (
    input.shippingPaymentMethod != null &&
    !["CASH", "CARD", "TRANSFER", "WALLET"].includes(String(input.shippingPaymentMethod))
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "الصكوك غير مدعومة في تسوية مصروفات الشراء",
    });
  }
  if (input.payment && input.payment.method !== "CASH") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "الدفع غير النقدي للمورد يتطلب سند صرف موثقاً بمرجع الأداة المالية",
    });
  }
  return withTx((tx) => receivePurchaseInTx(tx, input, actor));
}

/** يرحّل كامل فاتورة الشراء داخل معاملة الحفظ/الاعتماد نفسها. */
export async function postPurchaseInvoiceInTx(
  tx: Tx,
  purchaseOrderId: number,
  actor: Actor & { role?: string },
  allowedStatuses: ReadonlyArray<"DRAFT" | "SENT" | "CONFIRMED"> = ["CONFIRMED"],
  postingDetails: PurchasePostingDetails = {},
) {
  return receivePurchaseInTx(
    tx,
    {
      purchaseOrderId,
      lines: [],
      clientRequestId: `purchase-auto-post-${purchaseOrderId}`,
      ...postingDetails,
    },
    actor,
    { autoPostAll: true, allowedStatuses, allowCreatorToPost: false },
  );
}

async function receivePurchaseInTx(
  tx: Tx,
  input: ReceivePurchaseInput,
  actor: Actor & { role?: string },
  options: PostPurchaseOptions = {},
) {
    if (!options.autoPostAll) assertUniqueReceiveLines(input.lines);
    // Idempotency: تكرار الطلب نفسه يُعاد تشغيله بنتيجة الاستلام الأول بلا تكرار للمخزون أو AP.
    // قبل أيّ replay، نتحقّق أنّ المفتاح المخزَّن يخصّ نفس أمر الشراء وفرعه والكميات المطلوبة.
    // كان الـreplay يَعود بنتيجة مضلِّلة (receivedTotal=0.00) دون أيّ تحقّق ⇒ مفتاح يُعاد استعماله
    // على PO مختلف أو بكميات مختلفة كان يُرجع نجاحاً صامتاً ⇒ يَخفي تكرار طلب على كيان مختلف.
    const receiveRequestHash = input.clientRequestId
      ? idempotencyHash({
          purchaseOrderId: input.purchaseOrderId,
          mode: options.autoPostAll ? "AUTO_FULL_INVOICE" : "MANUAL_LEGACY",
          lines: options.autoPostAll ? [] : [...input.lines]
            .map((line) => ({
              purchaseOrderItemId: line.purchaseOrderItemId,
              receivedBaseQuantity: line.receivedBaseQuantity,
            }))
            .sort((left, right) => left.purchaseOrderItemId - right.purchaseOrderItemId),
          payment: input.payment
            ? {
                amount: input.payment.amount,
                method: input.payment.method,
              }
            : null,
          shippingPaymentMethod: input.shippingPaymentMethod ?? "CASH",
          shippingPaymentReference: input.shippingPaymentReference?.trim() || null,
          shippingCardLastFour: input.shippingCardLastFour?.trim() || null,
          shippingBeneficiarySupplierId: input.shippingBeneficiarySupplierId ?? null,
          shippingBeneficiaryName: input.shippingBeneficiaryName?.trim() || null,
          shippingEvidenceReference: input.shippingEvidenceReference?.trim() || null,
        })
      : null;
    const paymentRequestToken = receiveRequestHash?.slice(0, 16) ?? randomUUID().replaceAll("-", "").slice(0, 16);
    if (input.clientRequestId) {
      const existingRefId = await checkIdempotency(
        tx,
        "purchase.receive",
        input.clientRequestId,
        receiveRequestHash,
        { requireStoredHash: true },
      );
      if (existingRefId != null) {
        if (existingRefId !== input.purchaseOrderId) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: المفتاح مستعمَل لاستلام أمر شراء مختلف",
          });
        }
        const replayPo = (
          await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, input.purchaseOrderId)).limit(1)
        )[0];
        if (!replayPo) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشراء غير موجود" });
        assertPurchaseBranch(replayPo, actor);
        const replayItems = await tx
          .select()
          .from(purchaseOrderItems)
          .where(eq(purchaseOrderItems.purchaseOrderId, input.purchaseOrderId));
        const replayItemById = new Map(replayItems.map((i) => [Number(i.id), i]));
        const replayInputSum = input.lines.reduce((acc, l) => acc + Number(l.receivedBaseQuantity), 0);
        const replayActualSum = input.lines.reduce((acc, l) => {
          const it = replayItemById.get(l.purchaseOrderItemId);
          if (!it) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "تعارض idempotency: بنود الاستلام لا تخص أمر الشراء المُسجَّل",
            });
          }
          return acc + Number(it.receivedBaseQuantity ?? 0);
        }, 0);
        if (replayActualSum < replayInputSum) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: كميات الاستلام المطلوبة لا تطابق المسجَّل",
          });
        }
        const replayFully = replayItems.every((r) => (r.receivedBaseQuantity ?? 0) >= r.baseQuantity);
        const [replayShippingRequest] = await tx
          .select({ id: receipts.id })
          .from(receipts)
          .where(eq(receipts.referenceNumber, `SHIP-${replayPo.poNumber}-${paymentRequestToken}`))
          .limit(1);
        const [replaySupplierRequest] = await tx
          .select({ id: receipts.id })
          .from(receipts)
          .where(eq(receipts.referenceNumber, `PO-PAY-${replayPo.poNumber}-${paymentRequestToken}`))
          .limit(1);
        return {
          purchaseOrderId: input.purchaseOrderId,
          fullyReceived: replayFully,
          receivedTotal: money(replayPo.total).toFixed(2),
          receivedUsd: money(replayPo.usdTotal ?? "0").toFixed(2),
          shippingPaymentRequestReceiptId: replayShippingRequest ? Number(replayShippingRequest.id) : null,
          supplierPaymentRequestReceiptId: replaySupplierRequest ? Number(replaySupplierRequest.id) : null,
          idempotentReplay: true as const,
        };
      }
    }

    // ترتيب الأقفال العام: مصدر النقد → أمر الشراء/المورّد → الإيصالات. كانت المعاملة
    // تقفل PO والمورّد أولاً ثم الخزينة، بينما اعتماد سند المورد يفعل العكس، فتتكون دورة
    // supplier→branch / branch→supplier. قراءة المعاينة لا تقفل؛ وبناءً عليها نقفل المصدر
    // قبل PO. بعد قفل PO نعيد التحقق من الفرع، فلا نعتمد على لقطة قديمة.
    const poPreview = (
      await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, input.purchaseOrderId)).limit(1)
    )[0];
    if (!poPreview) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشراء غير موجود" });
    assertPurchaseBranch(poPreview, actor);
    const shippingMethod = input.shippingPaymentMethod ?? "CASH";
    const shippingPaymentReference = input.shippingPaymentReference?.trim() ?? "";
    const shippingCardLastFour = input.shippingCardLastFour?.trim() ?? "";
    if (shippingPaymentReference.length > 50) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "مرجع تسوية الشحن يجب ألا يتجاوز 50 محرفاً",
      });
    }
    if (shippingMethod === "TRANSFER" && !shippingPaymentReference) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "مرجع التحويل إلزامي لتسوية مصروف الشحن",
      });
    }
    if (shippingMethod === "CARD" && !/^\d{4}$/.test(shippingCardLastFour)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "آخر أربعة أرقام للبطاقة إلزامية لتسوية مصروف الشحن",
      });
    }
    const shippingBeneficiarySupplierId = input.shippingBeneficiarySupplierId ?? null;
    // قرار المالك (١٧/٨/٢٦): **الناقل ومستند الشحن اختياريّان — لا يحجبان الاستلام.**
    // كانا إلزامَين صلبَين (#604) بينما لا حقلَ لهما أصلاً في شاشة الاستلام ⇒ كلّ أمرٍ عليه
    // شحن/كمرك كان يُرفَض حتماً برسالة «رقم فاتورة/وصل الشحن … إلزامي» بلا مسارِ خلاصٍ في
    // الواجهة: ميزةٌ مقفلةٌ كلّياً لا حارسٌ. الخمسةُ التي يوجبها المبدأ المالي تبقى قائمة —
    // إيصالٌ وقيدٌ مصنَّف وأثرٌ نقديّ وطرفٌ منسوبٌ إليه وتقريرٌ يُظهره — لكنّ الطرف والمستند
    // يُملآن بقيمةٍ **صريحة الجهالة** حين لا يعرفهما أمين المخزن لحظة الاستلام، فيبقى المبلغ
    // ظاهراً وقابلاً للتصحيح لاحقاً بدل أن يُمنَع إثباتُه أصلاً (مصروفٌ حقيقيٌّ بلا قيد = المال
    // الذي «يضيع بصمت»، وهو الضرر الأكبر). طبقةُ الالتزامات (`accrualObligations`) تظلّ تُلزِم
    // نصّاً غير فارغ ⇒ نضمن ذلك هنا بالبدائل لا بتليينها (تخدم مساراتٍ أخرى محكومة).
    const rawShippingBeneficiary = input.shippingBeneficiaryName?.trim() ?? "";
    const rawShippingEvidence = input.shippingEvidenceReference?.trim() ?? "";
    // نائبات «لا شيء» تُعامَل كفراغٍ فتأخذ البديل الصريح بدل أن تُرفَض برسالة خطأ.
    const placeholders = new Set(["-", "—", "لا يوجد", "بدون", "none", "n/a", "na"]);
    const isPlaceholder = (value: string) => placeholders.has(value.toLocaleLowerCase("ar-IQ"));
    const freeShippingBeneficiary =
      !rawShippingBeneficiary || isPlaceholder(rawShippingBeneficiary) ? "" : rawShippingBeneficiary;
    // البديل: رقم أمر الشراء نفسه — مستندٌ داخليٌّ حقيقيّ يربط الاستحقاق بمصدره، لا حشوٌ فارغ.
    const shippingEvidenceReference =
      !rawShippingEvidence || isPlaceholder(rawShippingEvidence)
        ? `أمر الشراء ${poPreview.poNumber}`
        : rawShippingEvidence;
    const mayPaySupplierCash =
      poPreview.settlementType === "CASH" ||
      (input.payment?.method === "CASH" && money(input.payment.amount).gt(0));
    let treasuryPrelocked = false;
    if (mayPaySupplierCash) {
      await lockCashSourceForUpdate(tx, {
        branchId: Number(poPreview.branchId),
        cashBucket: "TREASURY",
        shiftId: null,
      });
      treasuryPrelocked = true;
    }

    const poRows = await tx
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, input.purchaseOrderId))
      .for("update")
      .limit(1);
    const po = poRows[0];
    if (!po) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشراء غير موجود" });
    if (Number(po.branchId) !== Number(poPreview.branchId)) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّر فرع أمر الشراء أثناء الاستلام؛ أعد المحاولة" });
    }
    assertPurchaseBranch(po, actor);
    const allowedStatuses = options.allowedStatuses ?? ["CONFIRMED"];
    if (!allowedStatuses.includes(po.status as "DRAFT" | "SENT" | "CONFIRMED")) {
      // قد يمرّ اعتمادان متزامنان بفحص المفتاح قبل أن يلتزم الأول. بعد قفل الأمر نعيد فحص
      // المفتاح: إن كان الأول قد رحّل الفاتورة نعيد نتيجة ناجحة بدل 400 زائف للنقرة الثانية.
      if (options.autoPostAll && po.status === "RECEIVED" && input.clientRequestId) {
        const racedRefId = await checkIdempotency(
          tx,
          "purchase.receive",
          input.clientRequestId,
          receiveRequestHash,
          { requireStoredHash: true, forUpdate: true },
        );
        if (racedRefId === input.purchaseOrderId) {
          const [replayShippingRequest] = await tx
            .select({ id: receipts.id })
            .from(receipts)
            .where(eq(receipts.referenceNumber, `SHIP-${po.poNumber}-${paymentRequestToken}`))
            .limit(1);
          const [replaySupplierRequest] = await tx
            .select({ id: receipts.id })
            .from(receipts)
            .where(eq(receipts.referenceNumber, `PO-PAY-${po.poNumber}-${paymentRequestToken}`))
            .limit(1);
          return {
            purchaseOrderId: input.purchaseOrderId,
            fullyReceived: true,
            receivedTotal: money(po.total).toFixed(2),
            receivedUsd: money(po.usdTotal ?? "0").toFixed(2),
            shippingPaymentRequestReceiptId: replayShippingRequest ? Number(replayShippingRequest.id) : null,
            supplierPaymentRequestReceiptId: replaySupplierRequest ? Number(replaySupplierRequest.id) : null,
            idempotentReplay: true as const,
          };
        }
      }
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا تُرحّل إلا فاتورة شراء غير ملغاة ولم تُرحّل سابقاً" });
    }
    // SOD-06 (تدقيق ٢٠/٦، قرار المالك): اعتماد الشراء بفصل المهام — الاستلام يُلزِم الذمم الدائنة (AP)
    // ويُرحّل قيد PURCHASE، فيجب أن يَختلف المُستلِم (المُعتمِد) عن مُنشئ الأمر، إلّا للأدمن. يضمن
    // شخصين في الشراء الآجل (مُنشئ + مُعتمِد) — نفس نمط SOD-05 في cancelVoucher.
    const receiverRole =
      actor.role ?? (await tx.select({ role: users.role }).from(users).where(eq(users.id, actor.userId)).limit(1))[0]?.role ?? "";
    if (
      !options.allowCreatorToPost &&
      receiverRole !== "admin" &&
      po.createdBy != null &&
      Number(po.createdBy) === actor.userId
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "لا يجوز استلام أمر شراء أنشأته بنفسك — يلزم شخص آخر لاعتماده (فصل المهام).",
      });
    }

    const items = await tx
      .select()
      .from(purchaseOrderItems)
      .where(eq(purchaseOrderItems.purchaseOrderId, input.purchaseOrderId));
    const itemById = new Map(items.map((i) => [Number(i.id), i]));

    const effectiveLines = options.autoPostAll
      ? items
          .map((item) => ({
            purchaseOrderItemId: Number(item.id),
            receivedBaseQuantity: Number(item.baseQuantity) - Number(item.receivedBaseQuantity ?? 0),
          }))
          .filter((line) => line.receivedBaseQuantity > 0)
      : input.lines;
    if (options.autoPostAll && effectiveLines.length === 0) {
      await tx
        .update(purchaseOrders)
        .set({ status: "RECEIVED" })
        .where(eq(purchaseOrders.id, input.purchaseOrderId));
      return {
        purchaseOrderId: input.purchaseOrderId,
        fullyReceived: true,
        receivedTotal: "0.00",
        receivedUsd: "0.00",
        shippingPaymentRequestReceiptId: null,
        supplierPaymentRequestReceiptId: null,
      };
    }

    // landed-cost: توزيع (الشحن + الكمرك) على بنود الأمر بنسبة قيمة كلّ بند من المجموع الفرعي.
    // يُحسب من حقول الأمر المخزَّنة على **كلّ** البنود (لا المستلَمة فقط) ⇒ حصّة البند ثابتة طوال
    // حياته، والاستلام الجزئيّ يُرسمِل نصيبَه منها (انظر cumLanded أدناه). خوارزمية «آخر بندٍ ذي قيمة
    // يمتصّ فرق التقريب» تضمن ثابتاً صارماً: **Σ الحصص = totalLanded بالضبط** (لا انجراف سنتات).
    const totalLanded = round2(money(po.shippingCost).plus(money(po.customsCost)));
    const poSubtotalForLanded = money(po.subtotal);
    const landedByItemId = new Map<number, Decimal>();
    for (const it of items) landedByItemId.set(Number(it.id), new Decimal(0));
    if (totalLanded.gt(0) && poSubtotalForLanded.gt(0)) {
      const ordered = [...items].sort((a, b) => Number(a.id) - Number(b.id));
      let lastValued = -1;
      for (let i = 0; i < ordered.length; i++) if (money(ordered[i].total).gt(0)) lastValued = i;
      let allocated = new Decimal(0);
      for (let i = 0; i < ordered.length; i++) {
        const it = ordered[i];
        if (money(it.total).lte(0)) continue;
        if (i === lastValued) {
          landedByItemId.set(Number(it.id), round2(totalLanded.minus(allocated)));
        } else {
          const share = round2(totalLanded.times(money(it.total)).dividedBy(poSubtotalForLanded));
          landedByItemId.set(Number(it.id), share);
          allocated = allocated.plus(share);
        }
      }
    }

    // Validate, then sort received lines by variantId for deterministic locking.
    const work = effectiveLines.map((l) => {
      const item = itemById.get(l.purchaseOrderItemId);
      if (!item) throw new TRPCError({ code: "BAD_REQUEST", message: `بند الشراء ${l.purchaseOrderItemId} لا يخص هذا الأمر` });
      if (!Number.isInteger(l.receivedBaseQuantity) || l.receivedBaseQuantity <= 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "الكمية المستلمة يجب أن تكون صحيحة موجبة" });
      }
      const alreadyReceived = item.receivedBaseQuantity ?? 0;
      if (alreadyReceived + l.receivedBaseQuantity > item.baseQuantity) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `الكمية المستلمة تتجاوز المطلوب للبند ${l.purchaseOrderItemId}` });
      }
      return { line: l, item };
    });
    const requestedByItem = new Map<number, number>();
    for (const { line } of work) {
      requestedByItem.set(
        line.purchaseOrderItemId,
        (requestedByItem.get(line.purchaseOrderItemId) ?? 0) + line.receivedBaseQuantity,
      );
    }
    requestedByItem.forEach((requested, itemId) => {
      const item = itemById.get(itemId)!;
      if ((item.receivedBaseQuantity ?? 0) + requested > item.baseQuantity) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `إجمالي الكمية المستلمة يتجاوز المطلوب للبند ${itemId}` });
      }
    });
    work.sort((a, b) => Number(a.item.variantId) - Number(b.item.variantId));

    // Batch-load all required data before the loop.
    const variantIds = work.map(({ item }) => Number(item.variantId));

    // معامل الوحدة لقطة ثابتة مشتقة من baseQuantity/quantity المخزنين في سطر الأمر.
    // إعادة قراءة productUnits هنا كانت تجعل تعديل الوحدة بعد إنشاء PO يغيّر تكلفة الاستلام أو يعطله.
    const unitFactorMap = new Map<number, Decimal>();
    for (const { line, item } of work) {
      const orderedQty = new Decimal(item.quantity);
      const factor = orderedQty.gt(0)
        ? new Decimal(item.baseQuantity).dividedBy(orderedQty)
        : new Decimal(1);
      if (factor.lte(0)) {
        throw new TRPCError({ code: "CONFLICT", message: `معامل الوحدة المخزّن لبند الشراء ${item.id} غير صالح` });
      }
      unitFactorMap.set(Number(item.id), factor);
      if (factor.gt(1) && !new Decimal(line.receivedBaseQuantity).modulo(factor).isZero()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `الكمية المستلَمة (${line.receivedBaseQuantity}) غير قابلة للقسمة على معامل الوحدة الأصلي (${factor.toString()})` });
      }
    }

    // mutex المتغيّرات قبل أي صف فرع؛ يمنع تجزئة نطاق الفروع بين استلام وإعادة تقييم.
    await lockInventoryVariants(tx, variantIds);
    await ensureBranchStockRows(tx, variantIds, Number(po.branchId));

    // قفل صفوف branchStock للمتغيّرات المعنية قبل قراءة الـSUM:
    // يَسَلْسِل receive مع أي sale متزامن على نفس المتغيّرات (تلك تأخذ قفلاً على نفس الصفوف
    // عبر applyMovement). بدون هذا القفل، يمكن لـsale متزامن أن يُغيّر الكميات بين قراءة
    // الـSUM وكتابة costPrice ⇒ WAVG محسوب على رصيد قديم. القفل لا يمنع INSERT جديد، لكن
    // branchStock للـvariant موجود إذ بدونه لا يوجد sale (يعمل applyMovement على ضمان الصفّ).
    await tx
      .select({ id: branchStock.id })
      .from(branchStock)
      .where(inArray(branchStock.variantId, variantIds))
      .orderBy(branchStock.variantId)
      .for("update");

    // Read existing stock per variant (sum across all branches) AFTER the row lock.
    const stockRows = await tx
      .select({
        variantId: branchStock.variantId,
        totalQty: sql<string>`COALESCE(SUM(${branchStock.quantity}), 0)`,
      })
      .from(branchStock)
      .where(inArray(branchStock.variantId, variantIds))
      .groupBy(branchStock.variantId);
    const stockMap = new Map(stockRows.map((s) => [Number(s.variantId), s.totalQty]));

    // Lock all variants for update in one query (deterministic order = ascending variantId).
    const variantRows = await tx
      .select({ id: productVariants.id, cost: productVariants.costPrice })
      .from(productVariants)
      .where(inArray(productVariants.id, variantIds))
      .for("update");
    const costMap = new Map(variantRows.map((v) => [Number(v.id), v.cost]));

    let receivedNet = new Decimal(0);
    let receivedUsd = new Decimal(0);
    let receivedLanded = new Decimal(0);
    for (const { line, item } of work) {
      const factor = unitFactorMap.get(Number(item.id)) ?? new Decimal(1);
      const costPerBase = round2(money(item.unitPrice).dividedBy(factor.lte(0) ? new Decimal(1) : factor));

      // قرار المالك (٥/٨/٢٦) — **الشحن/الكمرك لا يُرسمَلان في تكلفة الصنف**: «تكلفة الصنف سعر
      // المورّد فقط، والشحن مصاريف علينا لا دخل للمورّد بها». فحصّة البند من الشحن تُحسَب أدناه
      // لغرضٍ واحد: مقدارُ **المصروف** المعترَف به لحظة الاستلام (§الشحن مصروفاً) — لا تدخل WAVG
      // إطلاقاً. الاعتراف بها هنا مصروفاً وفي WAVG معاً كان سيحتسبها مرّتين (مرّة مصروفاً ومرّة في
      // COGS عند البيع) فينقص الربح ضعفاً.
      const lineLanded = landedByItemId.get(Number(item.id)) ?? new Decimal(0);
      const capCostPerBase = costPerBase;

      // WAVG (المتوسّط المرجّح): المخزون القائم + التكلفة القديمة مُقرآن قبل الحلقة.
      // التكلفة صفة عالمية للصنف ⇒ الوزن بإجمالي الأساس عبر الفروع.
      const existingQty = Decimal.max(new Decimal(stockMap.get(Number(item.variantId)) ?? "0"), 0);
      const oldCost = money(costMap.get(Number(item.variantId)) ?? "0");
      const recvQty = new Decimal(line.receivedBaseQuantity);
      const denom = existingQty.plus(recvQty);
      // لا مخزون قائم (أو تكلفة قديمة صفر) ⇒ المتوسّط = تكلفة الشراء الحالية (المُرسمَلة).
      const newCost =
        denom.lte(0) || oldCost.lte(0)
          ? round2(capCostPerBase)
          : round2(existingQty.times(oldCost).plus(recvQty.times(capCostPerBase)).dividedBy(denom));

      await applyMovement(tx, {
        variantId: Number(item.variantId),
        branchId: Number(po.branchId),
        baseQuantity: line.receivedBaseQuantity,
        movementType: "IN",
        referenceType: "PURCHASE_ORDER",
        referenceId: input.purchaseOrderId,
        createdBy: actor.userId,
        stampOpened: true,
      });
      await tx
        .update(purchaseOrderItems)
        .set({ receivedBaseQuantity: (item.receivedBaseQuantity ?? 0) + line.receivedBaseQuantity })
        .where(eq(purchaseOrderItems.id, Number(item.id)));
      // WAVG policy: تكلفة الصنف = المتوسّط المرجّح للمخزون القديم والمستلَم.
      await tx
        .update(productVariants)
        .set({ costPrice: newCost.toFixed(2) })
        .where(eq(productVariants.id, Number(item.variantId)));

      // حدّث الخريطتين بعد كل سطر ليُحسب المتوسّط المرجّح تسلسلياً لو تكرّر الصنف نفسه في أمر الشراء
      // (سطران لنفس المتغيّر) — وإلّا فالسطر الثاني يتجاهل كمية/تكلفة الأول ويطمس نتيجته.
      stockMap.set(Number(item.variantId), denom.toString());
      costMap.set(Number(item.variantId), newCost.toFixed(2));

      // Ledger/AP value derives from the stored line total (proportional to received).
      // مع عمود receivedNet المخزّن لتتبّع التراكم: عند الاستلام المُكمِل للكمية
      // (priorQty + thisQty === baseQuantity) نستعمل remainder = (total − receivedNet المخزّن سابقاً)
      // بدل round على portion ⇒ مجموع AP/PURCHASE يطابق إجمالي الـPO بالضبط (لا انجراف 0.01 IQD).
      const priorReceivedNet = money(item.receivedNet ?? "0");
      const priorQty = item.receivedBaseQuantity ?? 0;
      const isLastReceive = priorQty + line.receivedBaseQuantity === item.baseQuantity;
      let lineNet: Decimal;
      if (isLastReceive) {
        lineNet = round2(money(item.total).minus(priorReceivedNet));
      } else {
        const portion = new Decimal(line.receivedBaseQuantity).dividedBy(item.baseQuantity);
        lineNet = round2(money(item.total).times(portion));
      }
      await tx
        .update(purchaseOrderItems)
        .set({ receivedNet: toDbMoney(priorReceivedNet.plus(lineNet)) })
        .where(eq(purchaseOrderItems.id, Number(item.id)));
      receivedNet = receivedNet.plus(lineNet);

      if (po.agreedCurrency === "USD" && item.usdTotal != null) {
        const priorReceivedUsd = money(item.receivedUsd ?? "0");
        const lineUsd = isLastReceive
          ? round2(money(item.usdTotal).minus(priorReceivedUsd))
          : round2(money(item.usdTotal).times(new Decimal(line.receivedBaseQuantity).dividedBy(item.baseQuantity)));
        await tx
          .update(purchaseOrderItems)
          .set({ receivedUsd: toDbMoney(priorReceivedUsd.plus(lineUsd)) })
          .where(eq(purchaseOrderItems.id, Number(item.id)));
        receivedUsd = receivedUsd.plus(lineUsd);
      }

      // landed-cost: حصّة البند من الشحن/الكمرك المُرسمَلة في هذه الدفعة — cumulative مقرَّب بنفس
      // منطق «آخر استلامٍ يمتصّ الباقي» ⇒ Σ عبر كلّ الاستلامات = حصّة البند بالضبط (لا انجراف).
      const cumLanded = (k: number): Decimal =>
        k >= item.baseQuantity ? lineLanded : round2(lineLanded.times(k).dividedBy(item.baseQuantity));
      receivedLanded = receivedLanded.plus(cumLanded(priorQty + line.receivedBaseQuantity).minus(cumLanded(priorQty)));
    }
    receivedNet = round2(receivedNet);
    receivedUsd = round2(receivedUsd);
    receivedLanded = round2(receivedLanded);

    // Proportional tax from the PO's effective rate.
    const poSubtotal = money(po.subtotal);
    const rate = poSubtotal.gt(0) ? money(po.taxAmount).dividedBy(poSubtotal) : new Decimal(0);
    // قرار المالك (٥/٨/٢٦): الإجماليّ المستلَم = **البضاعة + الضريبة فقط**. الشحن/الكمرك خرجا من
    // ذمّة المورّد نهائياً (يُدفعان لشركة نقلٍ أو يكونان مجّانيَّين — لا دخل للمورّد بهما)، ويُسجَّلان
    // مصروفاً مستقلاً أدناه. ومجموع المستلَم عبر الاستلام الكامل يطابق po.total (= البضاعة + الضريبة).
    // Final status: fully received if every item meets its ordered base qty.
    const refreshed = await tx
      .select({ baseQuantity: purchaseOrderItems.baseQuantity, receivedBaseQuantity: purchaseOrderItems.receivedBaseQuantity })
      .from(purchaseOrderItems)
      .where(eq(purchaseOrderItems.purchaseOrderId, input.purchaseOrderId));
    const fullyReceived = refreshed.every((r) => (r.receivedBaseQuantity ?? 0) >= r.baseQuantity);
    const priorTaxRow = (
      await tx
        .select({ v: sql<string>`COALESCE(SUM(${accountingEntries.taxAmount}), 0)` })
        .from(accountingEntries)
        .where(
          sql`${accountingEntries.entryType} = 'PURCHASE' AND ${accountingEntries.purchaseOrderId} = ${input.purchaseOrderId}`,
        )
    )[0];
    const priorTax = money(priorTaxRow?.v ?? "0");
    const receivedTax = cumulativePurchaseTax(String(po.taxAmount), priorTax.toFixed(2), receivedNet, rate, fullyReceived);
    // الأمر الآجل يثبت ذمّة المورد. أمّا الأمر النقدي فيثبت التزام تسوية نقدية مستقلّاً:
    // البضاعة وصلت لكن النقد لا يخرج قبل اعتماد الشخص الثاني، ولا يجوز أن تظهر هذه المهلة
    // التشغيلية ديناً على حساب المورد أو في تقارير AP.
    const receivedTotal = round2(receivedNet.plus(receivedTax));
    const supplierIqd = receivedTotal;
    const automaticCashSettlement = po.settlementType === "CASH";
    const useCashClearing =
      automaticCashSettlement &&
      (await purchaseCashSettlementUsesClearingTx(tx, input.purchaseOrderId));
    const purchaseSettlementRole = useCashClearing
      ? ("OTHER_LIABILITY" as const)
      : ("AP" as const);
    const purchasePostingSource = {
      roleDebits: { INVENTORY: receivedNet, TAX_PAYABLE: receivedTax },
      roleCredits: { [purchaseSettlementRole]: supplierIqd },
    };
    await tx
      .update(purchaseOrders)
      .set({ status: fullyReceived ? "RECEIVED" : "CONFIRMED" })
      .where(eq(purchaseOrders.id, input.purchaseOrderId));

    // PURCHASE ledger entry + AP للآجل أو clearing للنقدي. cost = قيمة البضاعة وحدها
    // (بلا شحن/كمرك — قرار المالك ٥/٨/٢٦)،
    // وهي نفسها التي دخلت WAVG أعلاه ⇒ قيمة المخزون وقيد الشراء متطابقان. قيود PURCHASE لا تدخل
    // حساب الربح (reportsFinancialService يجمع cost لـSALE/RETURN فقط) والاعتراف بتكلفة البضاعة
    // يقع مرّةً واحدةً عند البيع؛ أمّا دفع الشحن النقدي فيبقى طلباً معلّقاً حتى اعتماد المالك أدناه.
    // ملاحظة مرتجع الشراء: بعد إلغاء الرسملة صار المرتجع يعكس AP بقيمة البضاعة فقط بلا بقايا شحنٍ
    // عالقةٍ في الذمّة — وسقفُه في purchaseReturnsService صار WAVG = سعر المورّد (لا شحن فيه).
    await postEntry(tx, {
      entryType: "PURCHASE",
      branchId: Number(po.branchId),
      createdBy: actor.userId,
      purchaseOrderId: input.purchaseOrderId,
      purchaseLiabilityAccount: useCashClearing ? "CASH_CLEARING" : "AP",
      supplierId: Number(po.supplierId),
      cost: round2(receivedNet),
      taxAmount: receivedTax,
      amount: supplierIqd,
      postingIntent: createPostingIntent(
        useCashClearing
          ? "PURCHASE_INVENTORY_CASH_CLEARING"
          : "PURCHASE_INVENTORY",
        "PURCHASE",
        [
          debitLine("INVENTORY", receivedNet),
          ...(receivedTax.isZero()
            ? []
            : [debitLine("TAX_PAYABLE", receivedTax)]),
          creditLine(purchaseSettlementRole, supplierIqd),
        ],
        purchasePostingSource,
      ),
      postingSourceComponents: purchasePostingSource,
    });
    if (!useCashClearing) {
      await adjustSupplierBalance(tx, Number(po.supplierId), supplierIqd);
      if (po.agreedCurrency === "USD") {
        await adjustSupplierBalanceUsd(tx, Number(po.supplierId), receivedUsd);
      }
    }

    // ═══ الشحن/الكمرك: طلب مصروف شركة مرتبط بالاستلام (قرار المالك ٥/٨/٢٦) ═══
    // «الشحن يُسجَّل مصروفاً لحظة الاستلام وتكلفة الصنف سعر المورّد فقط — الشحن مصاريف علينا ولا
    // دخل للمورّد به.» فحصّة هذا الاستلام (`receivedLanded`، تناسبية مع المستلَم فعلاً) تُسجَّل
    // مصروفاً والتزاماً حقيقيين فوراً — ويُنشأ طلب تسوية صفري الأثر. اعتماد مالك آخر وحده
    // يُكمل إيصال الصرف وقيد PAYMENT_OUT، فلا يظهر دفع قبل تنفيذ أداة السداد فعلياً.
    // لا نمرّ بـ`expenseService.createExpense` عمداً: فهو يحصر تسجيل المصروفات بالمدير/الأدمن،
    // والاستلام يقوم به أمين المخزن — والتفويض هنا هو صلاحية الاستلام نفسها، لا صلاحية المصروفات.
    // النقديّ يُنفّذ حصراً من TREASURY عند الاعتماد؛ وغير النقدي يُحفظ مع دليله ويُسوّى على حساب أداته.
    let shippingPaymentRequestReceiptId: number | null = null;
    if (receivedLanded.gt(0)) {
      const shipMethod = input.shippingPaymentMethod ?? "CASH";
      {
        const shippingVoucherReference = `SHIP-${po.poNumber}-${paymentRequestToken}`;
        // الطرف المنسوب إليه المصروف: مورّدٌ مسجَّل إن اختير، وإلّا الاسم الحرّ، وإلّا بديلٌ
        // **صريح الجهالة** (لا اسمٌ عامّ يوهم بأنّه جهة حقيقية) — يظهر في `expenses.payee`
        // وفي الالتزام والسند، فيُلتقَط بالبحث ويُصحَّح لاحقاً عند وصول فاتورة الناقل.
        let beneficiaryName = freeShippingBeneficiary || "ناقل غير محدَّد";
        if (shippingBeneficiarySupplierId != null) {
          const [beneficiary] = await tx
            .select({ id: suppliers.id, name: suppliers.name, isActive: suppliers.isActive })
            .from(suppliers)
            .where(eq(suppliers.id, shippingBeneficiarySupplierId))
            .limit(1);
          if (!beneficiary || beneficiary.isActive === false) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "جهة الشحن المسجّلة غير موجودة أو غير نشطة" });
          }
          beneficiaryName = beneficiary.name.trim();
        }
        // الاعتراف بالمصروف يقع لحظة الاستلام، مستقلاً عن قرار توقيت السداد. الإيصال
        // المعلّق هو حساب clearing تشغيلي: لا يدخل النقد حتى الاعتماد، بينما يبقى
        // expense/ledger قائماً حتى لو رُفضت محاولة الدفع وأُعيد تقديمها.
        const expenseResult = await tx.insert(expenses).values({
          branchId: Number(po.branchId),
          shiftId: null,
          cashBucket: null,
          expenseDate: new Date(),
          category: "TRANSPORT",
          amount: toDbMoney(receivedLanded),
          paymentMethod: "ACCRUAL",
          source: "ACCRUAL",
          description: `شحن/كمرك أمر الشراء ${po.poNumber}`,
          referenceNumber: shippingVoucherReference,
          payee: beneficiaryName,
          receiptId: null,
          status: "ACTIVE",
          createdBy: actor.userId,
        });
        const expenseId = extractInsertId(expenseResult);
        const shippingAccrual = expenseAccrualRecognition(
          "DELIVERY_EXPENSE",
          receivedLanded,
        );
        const recognitionDedupe = `PURCHASE_SHIPPING_ACCRUAL:${input.purchaseOrderId}:${paymentRequestToken}`;
        await postEntry(tx, {
          entryType: "ADJUST",
          branchId: Number(po.branchId),
          createdBy: actor.userId,
          purchaseOrderId: input.purchaseOrderId,
          // الاعتراف مستقل عن محاولة السداد الحالية؛ expense.receiptId يحمل
          // رابط الطلب القابل للاستبدال بعد الرفض من دون قيد ثانٍ.
          receiptId: null,
          amount: receivedLanded,
          postingIntent: shippingAccrual.intent,
          postingSourceComponents: shippingAccrual.sourceComponents,
          dedupeKey: recognitionDedupe,
          notes: `استحقاق مصروف شحن/كمرك — أمر الشراء ${po.poNumber}`,
        });
        const [recognitionEntry] = await tx
          .select({ id: accountingEntries.id })
          .from(accountingEntries)
          .where(eq(accountingEntries.dedupeKey, recognitionDedupe))
          .limit(1);
        if (!recognitionEntry) throw new Error("قيد الاعتراف بمصروف الشحن مفقود");
        const obligation = await createAccrualObligationTx(tx, {
          kind: "PURCHASE_SHIPPING",
          branchId: Number(po.branchId),
          expenseId,
          purchaseOrderId: input.purchaseOrderId,
          sourceKey: recognitionDedupe,
          recognizedAmount: toDbMoney(receivedLanded),
          initialStatus: "ACCRUED_UNPAID",
          beneficiaryType: shippingBeneficiarySupplierId == null ? "OTHER" : "SUPPLIER",
          beneficiarySupplierId: shippingBeneficiarySupplierId,
          beneficiaryName,
          evidenceReference: shippingEvidenceReference,
          plannedPaymentMethod: shipMethod,
          clientRequestId: `purchase-shipping-${paymentRequestToken}`,
          recognizedBy: actor.userId,
          recognizedAt: new Date(),
          recognitionAccountingEntryId: Number(recognitionEntry.id),
        });
        const request = await createSystemPaymentRequestTx(tx, {
          branchId: Number(po.branchId),
          amount: toDbMoney(receivedLanded),
          paymentMethod: shipMethod,
          // المصروف المستحق يقابل ACCRUED_EXPENSES لا AP؛ تصنيف المستفيد المورّد محفوظ
          // في obligation، بينما يبقى السند OTHER حتى لا يحرّك ذمة المورّد مرتين.
          partyType: "OTHER",
          partyId: null,
          counterpartyName: beneficiaryName,
          description: `تسوية مصروف شحن/كمرك — أمر الشراء ${po.poNumber}`,
          referenceNumber: shippingVoucherReference,
          checkNumber: shipMethod === "TRANSFER" ? shippingPaymentReference : null,
          cardLastFour:
            shipMethod === "CARD" ? shippingCardLastFour : null,
          clientRequestId: `purchase-shipping-payment-${paymentRequestToken}`,
        }, actor, {
          kind: "PURCHASE_SHIPPING",
          purchaseOrderId: input.purchaseOrderId,
          requestToken: paymentRequestToken,
          expectedAmount: toDbMoney(receivedLanded),
          sourceShippingTotal: toDbMoney(totalLanded),
          paymentReference:
            shipMethod === "CARD"
              ? shippingCardLastFour
              : shipMethod === "TRANSFER"
                ? shippingPaymentReference
                : null,
          obligationId: Number(obligation.id),
          obligationSourceHash: obligation.sourceHash,
          beneficiaryType: obligation.beneficiaryType,
          beneficiaryId: obligation.beneficiarySupplierId == null ? null : Number(obligation.beneficiarySupplierId),
          beneficiaryNameSnapshot: beneficiaryName,
          sourceEvidenceReference: obligation.evidenceReference,
        });
        shippingPaymentRequestReceiptId = request.receiptId;
        await transitionAccrualObligationTx(tx, {
          obligationId: Number(obligation.id),
          expectedStatus: "ACCRUED_UNPAID",
          nextStatus: "PAYMENT_PENDING",
          eventType: "PAYMENT_REQUESTED",
          actorId: actor.userId,
          receiptId: request.receiptId,
          evidenceReference: shippingEvidenceReference,
          dedupeKey: `ACCRUAL:PAYMENT_REQUESTED:${obligation.id}:${request.receiptId}`,
        });
        await finalizeOwnerSystemVoucherTx(tx, request.receiptId, actor);
      }
    }

    // تسوية المورد: أمر CASH يطلب تلقائياً كامل قيمة **هذا الاستلام**، فلا يتحول اختيار
    // «نقدي» الظاهر في أمر الشراء إلى ذمّة صامتة. الطلب يبقى معلّقاً حتى اعتماد مالك آخر
    // (فصل المهام)، وعند الاعتماد فقط يخرج النقد ويُطفأ AP/حساب التسوية ويزيد paidAmount.
    let supplierPaymentRequestReceiptId: number | null = null;
    const explicitPaidNow = money(input.payment?.amount ?? "0");
    if (automaticCashSettlement && input.payment && !explicitPaidNow.eq(receivedTotal)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `أمر الشراء نقدي: يجب أن تساوي دفعة هذا الاستلام كامل قيمته (${receivedTotal.toFixed(2)})`,
      });
    }
    const paidNow = automaticCashSettlement ? receivedTotal : explicitPaidNow;
    if (paidNow.gt(0)) {
      if (po.agreedCurrency === "USD") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "الفاتورة الدولارية تُسدَّد من شاشة الصيرفة/التسديد لتسجيل مبلغ الدولار وسعر الصرف الفعلي",
        });
      }
      // PROC-05 (تدقيق ٢/٧): السقف الأوّل — رصيد المورد الفعلي (منع AP سالبة على مستوى المورد).
      if (!useCashClearing) {
        const supAfter = money(
          (await tx.select({ b: suppliers.currentBalance }).from(suppliers).where(eq(suppliers.id, Number(po.supplierId))).limit(1))[0]?.b ?? "0",
        );
        if (paidNow.gt(supAfter)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `الدفعة (${paidNow.toFixed(2)}) تتجاوز رصيد المورد المستحقّ (${supAfter.toFixed(2)})` });
        }
      }
      // السقف الحقيقي = رصيد GL المعترف به لهذا PO ناقص طلباته المعلّقة، لا إجمالي الأمر الاسمي.
      // يمنع دفع قيمة غير مستلمة، كما يمنع حجز المبلغ مرتين قبل الاعتماد.
      const poPayable = await purchaseOrderPayableBalanceTx(tx, input.purchaseOrderId);
      const pendingReserved = await pendingPurchaseSupplierPaymentsTx(tx, String(po.poNumber));
      const poAvailable = Decimal.max(poPayable.minus(pendingReserved), 0);
      if (paidNow.gt(poAvailable)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `الدفعة (${paidNow.toFixed(2)}) تتجاوز المستحق المتاح على أمر الشراء (${poAvailable.toFixed(2)}) بعد الطلبات المعلّقة`,
        });
      }
      if (!treasuryPrelocked) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم يُقفل مصدر طلب دفعة المورد النقدية" });
      }
      const paymentRequest = await createSystemPaymentRequestTx(tx, {
        branchId: Number(po.branchId),
        amount: toDbMoney(paidNow),
        paymentMethod: "CASH",
        partyType: "SUPPLIER",
        partyId: Number(po.supplierId),
        description: `طلب دفع مورد لفاتورة الشراء ${po.poNumber}`,
        referenceNumber: `PO-PAY-${po.poNumber}-${paymentRequestToken}`,
        clientRequestId: `purchase-supplier-${paymentRequestToken}`,
      }, actor, {
        kind: "PURCHASE_SUPPLIER",
        purchaseOrderId: input.purchaseOrderId,
        requestToken: paymentRequestToken,
        expectedAmount: toDbMoney(paidNow),
        sourceTotal: toDbMoney(po.total),
        liabilityAccount: useCashClearing ? "CASH_CLEARING" : "AP",
      });
      supplierPaymentRequestReceiptId = paymentRequest.receiptId;
    }

    // Idempotency: سجّل المفتاح بعد نجاح الكتابة (refId = أمر الشراء).
    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "purchase.receive", input.clientRequestId, input.purchaseOrderId, receiveRequestHash);
    }

    return {
      purchaseOrderId: input.purchaseOrderId,
      fullyReceived,
      receivedTotal: receivedTotal.toFixed(2),
      receivedUsd: receivedUsd.toFixed(2),
      shippingPaymentRequestReceiptId,
      supplierPaymentRequestReceiptId,
    };
}
