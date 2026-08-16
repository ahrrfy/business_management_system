// إرجاع إرسالية (البضاعة عادت): عكس SALE + إعادة مخزون + عكس العهدة + رد العربون.
import { TRPCError } from "@trpc/server";
import type Decimal from "decimal.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { deliveryConsignments, deliveryParties, inventoryMovements, invoiceItems, invoices, onlineOrders, productVariants, products, receipts, workOrders } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { applyMovement } from "../inventoryService";
import { createPostingIntent, signedPostingLines, type AccountRole, type PostingSourceComponents } from "../accounting/postingEngine";
import { adjustCustomerBalance, adjustDeliveryBalance, adjustSupplierBalance, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { classifyGiftPosting } from "../sale/giftPosting";
import { resolveBranchCashShiftTx } from "../shiftService";
import {
  assertCashOutAvailable,
  lockCashSourceForUpdate,
  MATERIALIZED_RECEIPT_STATUSES,
} from "../cash/cashAvailability";
import { withTx } from "../tx";
import { appendDeliveryEvent, appendDeliveryLedgerEntry } from "./lifecycle";
import { deliveryCustomerRefundIntent, deliveryFeeHeldPayoutIntent, deliveryReturnSaleIntent, type DeliveryReturnSaleKind } from "./posting";
import type { DeliveryTxActor } from "./types";

/** إرجاع إرسالية (البضاعة عادت): عكس SALE + إعادة مخزون + عكس العهدة + رد العربون. مقيَّد بـDISPATCHED (collected==0). */
export async function returnConsignment(
  consignmentId: number,
  actor: DeliveryTxActor & { clientRequestId?: string | null; refundShiftId?: number | null },
) {
  return withTx(async (tx) => {
    const payloadHash = idempotencyHash({ consignmentId, refundShiftId: actor.refundShiftId ?? null });
    // مراجعة PR #495 (عزل الفرع) — الإرجاع صار `cashierProcedure` بقرار المالك ٦/٨، وبخلاف
    // remit/settle لا يمرّ بـassertPartyInScope في الراوتر (الجهة تُعرَف من الإرسالية لا من
    // المدخل) ⇒ كاشير فرعٍ كان يعكس فاتورة فرعٍ آخر ومخزونَه ويُنقص عهدة مندوبه ويردّ عربوناً
    // من أحد أدراجه بمجرّد تمرير مُعرّف إرسالية. الحارس **قبل** إعادة التشغيل idempotent وقبل
    // أيّ كتابة (قراءة خفيفة بلا قفل — القفل الحقيقيّ أدناه يعيد قراءة الصفّ كاملاً).
    // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران الفروع (owner مُطبَّع ⇒ admin)؛
    // المدير صار مقيَّداً بفرعه (كان `|| manager` يعكس إرسالية فرعٍ آخر ويردّ عربوناً من أدراجه).
    const cnPreview = (
      await tx
        .select({
          id: deliveryConsignments.id,
          branchId: deliveryConsignments.branchId,
          partyId: deliveryConsignments.partyId,
          invoiceId: deliveryConsignments.invoiceId,
          consignmentNumber: deliveryConsignments.consignmentNumber,
          feeSettledAt: deliveryConsignments.feeSettledAt,
        })
        .from(deliveryConsignments)
        .where(eq(deliveryConsignments.id, consignmentId))
        .limit(1)
    )[0];
    if (!cnPreview) throw new TRPCError({ code: "NOT_FOUND", message: "الإرسالية غير موجودة" });
    const scopedBranch = actor.role === "admin" ? null : (actor.branchId ?? null);
    if (scopedBranch != null && Number(cnPreview.branchId) !== scopedBranch) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الإرسالية تخصّ فرعاً آخر" });
    }
    if (actor.clientRequestId) {
      const existingId = await checkIdempotency(tx, "delivery.return", actor.clientRequestId, payloadHash);
      if (existingId != null) {
        if (Number(existingId) !== Number(consignmentId)) throw new TRPCError({ code: "CONFLICT", message: "مفتاح الإرجاع مرتبط بإرسالية أخرى" });
        return { consignmentId, reversed: true as const, idempotentReplay: true as const };
      }
    }
    const invPreview = (
      await tx.select({ paidAmount: invoices.paidAmount }).from(invoices)
        .where(eq(invoices.id, Number(cnPreview.invoiceId))).limit(1)
    )[0];
    if (!invPreview) throw new TRPCError({ code: "NOT_FOUND", message: "فاتورة الإرسالية غير موجودة" });
    const feeRefs = [`DLV-FEE-INV-${Number(cnPreview.invoiceId)}`, String(cnPreview.consignmentNumber)];
    const previewFeeRows = cnPreview.feeSettledAt == null
      ? await tx.select({ direction: receipts.direction, amount: receipts.amount }).from(receipts).where(and(
          eq(receipts.invoiceId, Number(cnPreview.invoiceId)),
          inArray(receipts.referenceNumber, [...feeRefs]),
          inArray(receipts.status, [...MATERIALIZED_RECEIPT_STATUSES]),
          eq(receipts.approvalStatus, "APPROVED"),
        ))
      : [];
    const previewFeeNet = previewFeeRows.reduce(
      (sum, receipt) => receipt.direction === "IN" ? sum.plus(money(receipt.amount)) : sum.minus(money(receipt.amount)),
      money(0),
    );
    const previewNeedsCash = money(invPreview.paidAmount).gt(0) || previewFeeNet.gt(0);
    let prelockedReturnShift: { shiftId: number; openingBalance: string } | null = null;
    if (previewNeedsCash) {
      prelockedReturnShift = await resolveBranchCashShiftTx(
        tx,
        Number(cnPreview.branchId),
        actor.refundShiftId ?? null,
      );
      await lockCashSourceForUpdate(tx, {
        branchId: Number(cnPreview.branchId),
        cashBucket: "DRAWER",
        shiftId: prelockedReturnShift.shiftId,
      });
    }
    // الترتيب الموحد لمسارات التوصيل: source→party→consignment→invoice.
    const party = (
      await tx.select().from(deliveryParties).where(eq(deliveryParties.id, Number(cnPreview.partyId)))
        .for("update").limit(1)
    )[0];
    if (!party) throw new TRPCError({ code: "CONFLICT", message: "جهة توصيل الإرسالية غير موجودة" });
    const cn = (await tx.select().from(deliveryConsignments).where(eq(deliveryConsignments.id, consignmentId)).for("update").limit(1))[0];
    if (!cn) throw new TRPCError({ code: "NOT_FOUND", message: "الإرسالية غير موجودة" });
    if (
      Number(cn.branchId) !== Number(cnPreview.branchId) ||
      Number(cn.partyId) !== Number(cnPreview.partyId) ||
      Number(cn.invoiceId) !== Number(cnPreview.invoiceId)
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّرت أطراف الإرسالية أثناء الإرجاع؛ أعد المحاولة" });
    }
    const replayAfterLock = await checkIdempotency(tx, "delivery.return", actor.clientRequestId, payloadHash);
    if (replayAfterLock != null) return { consignmentId, reversed: true as const, idempotentReplay: true as const };
    if (cn.status !== "DISPATCHED" || cn.moneyStatus === "PARTIAL" || cn.moneyStatus === "SETTLED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "يُرجَع فقط طرد لم يُحصَّل منه شيء؛ بعد التحصيل استعمل مرتجعات البيع" });
    }
    if (cn.parcelStatus === "DELIVERED" || cn.parcelStatus === "RETURNED") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الطرد مسلّم للعميل؛ نفّذ مرتجع بيع موثقاً بدل إرجاع الشحنة" });
    }
    if (cn.parcelStatus !== "ASSIGNED" && cn.parcelStatus !== "FAILED") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الطرد بعهدة السائق؛ سجّل تعذّر التوصيل وعودته للفرع قبل إرجاع البيع" });
    }
    const inv = (await tx.select().from(invoices).where(eq(invoices.id, Number(cn.invoiceId))).for("update").limit(1))[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "فاتورة الإرسالية غير موجودة" });
    // تدقيق ٦/٨ (ث٤): حارسٌ متبادل مع شاشة المرتجعات — فاتورةٌ أُرجع منها شيءٌ سلفاً يقيّد هنا
    // RETURN بكامل الإجمالي ويُعيد **كل** البنود للمخزون ⇒ إيرادٌ معكوسٌ مرّتين ومخزونٌ مضاعف.
    if (money(inv.returnedTotal ?? "0").gt(0)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `الفاتورة أُرجع منها سلفاً (${money(inv.returnedTotal ?? "0").toFixed(2)}) — أكمل الإرجاع من شاشة المرتجعات لا من هنا (وإلّا انعكس البيع مرّتين)`,
      });
    }

    const items = await tx
      .select({
        id: invoiceItems.id,
        variantId: invoiceItems.variantId,
        total: invoiceItems.total,
        unitCost: invoiceItems.unitCost,
        baseQuantity: invoiceItems.baseQuantity,
        isGift: invoiceItems.isGift,
        isService: products.isService,
        isConsignment: products.isConsignment,
        consignorId: products.consignorId,
        productType: products.productType,
      })
      .from(invoiceItems)
      .innerJoin(productVariants, eq(invoiceItems.variantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(eq(invoiceItems.invoiceId, Number(cn.invoiceId)));

    // لا نخمّن من سطر الفاتورة ما خرج من المخزون: نعيد فقط حركات OUT الأصلية المرتبطة
    // بالفاتورة. هكذا لا يتحول ناتج أمر شغل/خدمة مخصّصة إلى مخزون، وتعود مكوّنات البكج
    // ومواد الخدمة بذات الكميات الفعلية التي خرجت، لا بإعادة بناء قد تنجرف عن الحركة الأصلية.
    const originalOut = await tx
      .select({
        variantId: inventoryMovements.variantId,
        quantity: inventoryMovements.quantity,
      })
      .from(inventoryMovements)
      .where(and(
        eq(inventoryMovements.branchId, Number(cn.branchId)),
        eq(inventoryMovements.movementType, "OUT"),
        eq(inventoryMovements.referenceType, "INVOICE"),
        eq(inventoryMovements.referenceId, Number(cn.invoiceId)),
      ));
    const stockOps = new Map<number, number>();
    for (const movement of originalOut) {
      const variantId = Number(movement.variantId);
      stockOps.set(variantId, (stockOps.get(variantId) ?? 0) + Number(movement.quantity));
    }
    // تطبيق مجمَّع بترتيب variantId تصاعدي (اتّساق مع sale/create.ts + returnService).
    const sortedVids = Array.from(stockOps.keys()).sort((a, b) => a - b);
    for (const vid of sortedVids) {
      const qty = stockOps.get(vid)!;
      if (qty <= 0) continue;
      await applyMovement(tx, {
        variantId: vid, branchId: Number(cn.branchId), baseQuantity: qty,
        movementType: "RETURN", referenceType: "DELIVERY_RETURN", referenceId: consignmentId, createdBy: actor.userId,
      });
    }

    // عكس البيع: قيد RETURN بقيم سالبة.
    // تدقيق ٦/٨ (ث٣): الفاتورة قد تحمل عميلاً مسجَّلاً (مسار إسناد الفاتورة يُبقي customerId
    // بخلاف مسار أمر الشغل) ⇒ التعليق القديم «لا AR — customerId=NULL» صار خاطئاً: البضاعة
    // عادت للرفّ والعميل يبقى مديناً بها للأبد. القيد يُختَم بالعميل، والذمّة تُخصَم أدناه.
    const total = money(inv.total);
    const costTotal = money(inv.costTotal);
    const tax = round2(money(inv.taxAmount ?? "0"));
    const deliveryRevenue = round2(money(inv.deliveryFee ?? "0"));
    const sectorRevenue = round2(total.minus(tax).minus(deliveryRevenue));

    // Mirror sale/create.ts exactly: discounts are allocated over paid lines,
    // and each source sector reverses the revenue role it originally credited.
    const revenueItems = items
      .filter((item) => !item.isGift && money(item.total).gt(0))
      .sort((a, b) => Number(a.id) - Number(b.id));
    const revenueBasis = revenueItems.reduce((sum, item) => sum.plus(money(item.total)), money(0));
    const revenueByRole = new Map<AccountRole, Decimal>();
    const returnClasses = new Set<"DIGITAL" | "SERVICE" | "CONSIGNMENT" | "INVENTORY">();
    let allocatedRevenue = money(0);
    for (let index = 0; index < revenueItems.length; index++) {
      const item = revenueItems[index]!;
      const amount = index === revenueItems.length - 1
        ? round2(sectorRevenue.minus(allocatedRevenue))
        : round2(sectorRevenue.times(money(item.total)).div(revenueBasis));
      allocatedRevenue = allocatedRevenue.plus(amount);
      const returnClass = item.productType === "DIGITAL_CARD"
        ? "DIGITAL"
        : item.isService
          ? "SERVICE"
          : item.isConsignment
            ? "CONSIGNMENT"
            : "INVENTORY";
      returnClasses.add(returnClass);
      const role: AccountRole = inv.sourceType === "WORKORDER"
        ? "SALES_FLEX"
        : returnClass === "DIGITAL"
          ? "OTHER_REVENUE"
          : returnClass === "SERVICE"
            ? "SALES_PRINT"
            : "SALES_STATIONERY";
      revenueByRole.set(role, round2((revenueByRole.get(role) ?? money(0)).plus(amount)));
    }
    const returnKind: DeliveryReturnSaleKind = inv.sourceType === "WORKORDER"
      ? "WORK_ORDER_SERVICE"
      : returnClasses.size > 1
        ? "MIXED"
        : returnClasses.has("DIGITAL")
          ? "DIGITAL"
          : returnClasses.has("SERVICE")
            ? "SERVICE"
            : returnClasses.has("CONSIGNMENT")
              ? "CONSIGNMENT"
              : "INVENTORY";

    const byConsignor = new Map<number, { paid: Decimal; gift: Decimal }>();
    let ownedInventoryCost = money(0);
    let giftCost = money(0);
    let ownedGiftCost = money(0);
    for (const item of items) {
      const share = round2(money(item.unitCost).times(item.baseQuantity));
      if (item.isGift) {
        giftCost = giftCost.plus(share);
        if (!item.isConsignment) ownedGiftCost = ownedGiftCost.plus(share);
      } else if (!item.isService && !item.isConsignment) {
        ownedInventoryCost = ownedInventoryCost.plus(share);
      }
      if (item.isConsignment) {
        if (item.consignorId == null) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: `صنف أمانة بلا مودع في الفاتورة ${inv.invoiceNumber}` });
        }
        const consignorId = Number(item.consignorId);
        const split = byConsignor.get(consignorId) ?? { paid: money(0), gift: money(0) };
        if (item.isGift) split.gift = split.gift.plus(share);
        else split.paid = split.paid.plus(share);
        byConsignor.set(consignorId, split);
      }
    }
    ownedInventoryCost = round2(ownedInventoryCost);
    giftCost = round2(giftCost);
    ownedGiftCost = round2(ownedGiftCost);

    const invCustomerId = inv.customerId != null ? Number(inv.customerId) : null;
    const revenueBeforeTax = round2(total.minus(tax));
    // A returned delivery cancels the work order and does not put consumed
    // materials back into stock or WIP. Keep that material COGS as the loss of
    // the cancelled job; only the sale revenue is reversed. Inventory sales
    // still reverse their physically-restocked owned cost as usual.
    const operationalReturnCost = inv.sourceType === "WORKORDER"
      ? money(0)
      : costTotal.neg();
    const operationalReturnRevenue = revenueBeforeTax.neg();
    const revenueRoleEntries = Array.from(revenueByRole.entries()).map(([role, amount]) => ({
      role: role as "SALES_FLEX" | "SALES_PRINT" | "SALES_STATIONERY" | "OTHER_REVENUE",
      amount,
    }));
    const reversesOwnedInventory = returnKind === "INVENTORY" ||
      returnKind === "DIGITAL" || returnKind === "MIXED";
    const roleDebits: Partial<Record<AccountRole, Decimal>> = {};
    for (const { role, amount } of revenueRoleEntries) roleDebits[role] = amount;
    if (deliveryRevenue.gt(0)) roleDebits.DELIVERY_REVENUE = deliveryRevenue;
    if (tax.gt(0)) roleDebits.TAX_PAYABLE = tax;
    if (reversesOwnedInventory && ownedInventoryCost.gt(0)) {
      roleDebits.INVENTORY = ownedInventoryCost;
    }
    const returnPostingSourceComponents: PostingSourceComponents = {
      roleDebits,
      roleCredits: {
        AR: total,
        ...(reversesOwnedInventory && ownedInventoryCost.gt(0)
          ? { COGS: ownedInventoryCost }
          : {}),
      },
    };
    if (total.gt(0)) {
      await postEntry(tx, {
        entryType: "RETURN", branchId: Number(cn.branchId), invoiceId: Number(cn.invoiceId),
        customerId: invCustomerId,
        revenue: operationalReturnRevenue,
        cost: operationalReturnCost,
        profit: round2(operationalReturnRevenue.minus(operationalReturnCost)),
        amount: total.neg(),
        taxAmount: tax.neg(),
        postingSourceComponents: returnPostingSourceComponents,
        postingIntent: deliveryReturnSaleIntent({
          kind: returnKind,
          sectorRevenue,
          revenueByRole: revenueRoleEntries,
          deliveryRevenue,
          tax,
          total,
          ownedInventoryCost,
        }),
        notes: `إرجاع إرسالية ${cn.consignmentNumber}`,
      });
    }

    // Gift expense reverses only for goods that physically returned. The
    // consignor part is a memo here because its GIFTS_PROMO leg is reversed by
    // PURCHASE_CONSIGNMENT below; owned goods restore INVENTORY directly.
    if (giftCost.gt(0)) {
      const giftPosting = classifyGiftPosting(giftCost, ownedGiftCost, -1);
      await postEntry(tx, {
        entryType: "GIFT_OUT",
        dedupeKey: `GIFT:DELIVERY_RETURN:${Number(cn.invoiceId)}`,
        branchId: Number(cn.branchId),
        invoiceId: Number(cn.invoiceId),
        customerId: invCustomerId,
        revenue: money(0),
        cost: giftCost.neg(),
        profit: giftCost,
        amount: giftCost.neg(),
        postingSourceComponents: giftPosting.sourceComponents,
        notes: `عكس هدايا إرسالية ${cn.consignmentNumber}; consignmentRemainder=${toDbMoney(giftPosting.consignmentRemainder)}`,
        postingIntent: giftPosting.intent,
      });
    }

    // Returned consignment goods no longer create a debt to the consignor.
    // Reverse both paid and gift shares with the original invoice link so the
    // commission/net-sales filters also see the exact mirror entry.
    for (const consignorId of Array.from(byConsignor.keys()).sort((a, b) => a - b)) {
      const split = byConsignor.get(consignorId)!;
      const paidShare = round2(split.paid);
      const giftShare = round2(split.gift);
      const share = round2(paidShare.plus(giftShare));
      if (share.lte(0)) continue;
      await postEntry(tx, {
        entryType: "PURCHASE",
        dedupeKey: `CONSIG:DELIVERY_RETURN:${Number(cn.invoiceId)}:${consignorId}`,
        supplierId: consignorId,
        invoiceId: Number(cn.invoiceId),
        branchId: Number(cn.branchId),
        amount: share.neg(),
        revenue: money(0),
        cost: money(0),
        profit: money(0),
        notes: `عكس استحقاق أمانة — إرجاع إرسالية ${cn.consignmentNumber}`,
        postingIntent: createPostingIntent("PURCHASE_CONSIGNMENT", "PURCHASE", [
          ...signedPostingLines("COGS", "CONSIGNMENT_PAYABLE", paidShare.neg()),
          ...signedPostingLines("GIFTS_PROMO", "CONSIGNMENT_PAYABLE", giftShare.neg()),
        ], {
          roleDebits: { CONSIGNMENT_PAYABLE: share },
          roleCredits: { COGS: paidShare, GIFTS_PROMO: giftShare },
        }),
        postingSourceComponents: {
          roleDebits: { CONSIGNMENT_PAYABLE: share },
          roleCredits: { COGS: paidShare, GIFTS_PROMO: giftShare },
        },
      });
      await adjustSupplierBalance(tx, consignorId, share.neg());
    }
    await tx.update(invoices).set({ status: "RETURNED", returnedTotal: toDbMoney(total) }).where(eq(invoices.id, Number(cn.invoiceId)));

    // تحرير التعرض التشغيلي. في المرحلة الثانية لا ترتفع العهدة النقدية عند
    // الإسناد. أما الصفوف المرحّلة فتحمل custodyRecognizedAt لأن رصيدها القديم
    // كان تعرّضاً مُسجلاً في currentBalance؛ نعكس منه ما بقي فعلاً، ثم نحرر
    // الباقي كتعرّض غير محصّل حتى تبقى معادلتا العهدة والتعرض متوازنتين.
    const outstanding = round2(money(cn.codAmount).minus(money(cn.collectedAmount)));
    if (outstanding.gt(0)) {
      const cachedCustody = money(party?.currentBalance ?? "0");
      const legacyCustody = cn.custodyRecognizedAt == null
        ? money(0)
        : round2(outstanding.lt(cachedCustody) ? outstanding : cachedCustody);
      if (legacyCustody.gt(0)) {
        await adjustDeliveryBalance(tx, Number(cn.partyId), legacyCustody.neg());
        await appendDeliveryLedgerEntry(tx, {
          eventKey: `CN:${consignmentId}:COD_REMITTED:LEGACY_RETURN`,
          partyId: Number(cn.partyId),
          consignmentId,
          branchId: Number(cn.branchId),
          entryType: "COD_REMITTED",
          amount: toDbMoney(legacyCustody),
          actorUserId: actor.userId,
          notes: `عكس عهدة مرحّلة بعد إرجاع ${cn.consignmentNumber}`,
        });
      }

      const exposureToRelease = round2(outstanding.minus(legacyCustody));
      if (exposureToRelease.gt(0)) {
        await appendDeliveryLedgerEntry(tx, {
          eventKey: `CN:${consignmentId}:COD_RELEASED:RETURN`,
          partyId: Number(cn.partyId),
          consignmentId,
          branchId: Number(cn.branchId),
          entryType: "COD_RELEASED",
          amount: toDbMoney(exposureToRelease),
          actorUserId: actor.userId,
          notes: `تحرير تحصيل متوقع بعد إرجاع ${cn.consignmentNumber}`,
        });
      }
    }

    // رد العربون نقداً إن وُجد (paidAmount على فاتورة COD = العربون).
    const deposit = round2(money(inv.paidAmount));
    if (deposit.gt(0)) {
      // الدرج مورد فرعٍ لا مستخدم — الإرجاع صلاحية مدير (managerProcedure، «إجراء تصحيحيّ») قد يختلف
      // عن الكاشير صاحب درج الاستقبال الذي قبض العربون فعلاً. shiftIdForCashTx القديمة كانت تنسب
      // الاسترداد لوردية الفاعل نفسه (إن وُجدت) أو تُسقطه في TREASURY بمعزلٍ عن أيّ Z-report — كلاهما
      // قد يُخفي خروج النقد الفعليّ عن صاحب الدرج الحقيقيّ. مرآة إصلاح returnService.ts (بلاغ مالك
      // ٢/٨/٢٦): resolveBranchCashShiftTx يبحث في ورديات الفرع المفتوحة كلّها، ويتحقّق أنّ الدرج
      // المستهدَف يحمل هذا المبلغ الآن فعلياً (نمط cashDropService — لا عجز أثناء العمل).
      const resolved = prelockedReturnShift;
      if (!resolved) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تغيّرت المقبوضات أثناء إرجاع الإرسالية؛ أعد المحاولة",
        });
      }
      await assertCashOutAvailable(tx, {
        branchId: Number(cn.branchId), cashBucket: "DRAWER", shiftId: resolved.shiftId,
        amount: deposit, operation: "رد عربون إرجاع الإرسالية",
      });
      const rOut = await tx.insert(receipts).values({
        branchId: Number(cn.branchId), shiftId: resolved.shiftId, direction: "OUT", amount: toDbMoney(deposit),
        paymentMethod: "CASH", cashBucket: "DRAWER", status: "COMPLETED", invoiceId: Number(cn.invoiceId),
        referenceNumber: `RET-${cn.consignmentNumber}`, description: `رد عربون إرجاع ${cn.consignmentNumber}`, createdBy: actor.userId,
      });
      await postEntry(tx, {
        entryType: "PAYMENT_OUT", branchId: Number(cn.branchId), invoiceId: Number(cn.invoiceId),
        postingIntent: deliveryCustomerRefundIntent(deposit, "DRAWER"),
        postingSourceComponents: {
          roleDebits: { AR: deposit },
          roleCredits: { CASH: deposit },
        },
        customerId: invCustomerId,
        receiptId: extractInsertId(rOut), amount: deposit, notes: `رد عربون ${cn.consignmentNumber}`,
      });
      await tx.update(invoices).set({ paidAmount: "0.00" }).where(eq(invoices.id, Number(cn.invoiceId)));
    }

    // تدقيق ٦/٨ (ث٣) — **خصم ذمّة العميل** (طلب المالك الحرفيّ: «لكي يتم خصم الذمم منه»):
    // ما لم يُستردّ نقداً من المدفوع يبقى ديناً على العميل عن بضاعةٍ عادت للرفّ. يُخصَم هنا
    // بنفس دلالة returnService (الجزء غير المستردّ نقداً يسقط من الذمّة).
    if (invCustomerId != null) {
      const arDrop = round2(total.minus(deposit));
      if (arDrop.gt(0)) await adjustCustomerBalance(tx, invCustomerId, arDrop.neg());
    }

    // تدقيق ٦/٨ (ث٢) — **ردّ أمانة أجرة التوصيل** إن قُبضت في الاستقبال ولم تُصرف للمندوب:
    // التوصيل لم يقع، فالأمانة مالُ الزبون لا مالُ المكتبة ولا المندوب. بلا هذا الردّ تبقى
    // في الدرج بلا مالكٍ وتُرحَّل للخزينة كأنها إيراد.
    //
    // ⚠️ مراجعة PR #495 (ازدواج ردّ الأمانة): «مقبوضةٌ في الاستقبال» (COUNTER) تُصرَف للمندوب
    // **لحظة الإسناد** (dispatchInvoice/dispatch: settleFeeNow) بإيصال OUT مرجعُه **رقم
    // الإرسالية** لا `DLV-FEE-INV-{الفاتورة}` ⇒ الاستعلام القديم كان لا يرى الصرف فيرى الوارد
    // الأصليّ موجباً ويردّه **ثانيةً**: خروجُ نقدٍ مرّتين مقابل قبضةٍ واحدة، وΣ(DELIVERY_FEE_HELD)
    // ينقلب −الأجرة بدل صفر (ينسف ثابت «الأمانة مُبرَّأة ⇔ Σ=0»). الآن حارسان:
    //   (١) `feeSettledAt` — الأمانة غادرت الدرج إلى المندوب فلا التزامَ باقياً يُحرَّر.
    //   (٢) صافي الإيصالات يشمل صرف الأجرة برقم الإرسالية أيضاً (تصفيةٌ ذاتية للحالات القديمة).
    // ما دُفع للمندوب فعلاً ثم أراد المالك ردّه للزبون = **مصروفٌ على المكتبة** بسند صرفٍ
    // صريح، لا تحريرٌ ثانٍ لنفس الأمانة. (يُعلَن للواجهة بـ`feeAlreadyPaidToCourier`.)
    const heldRef = `DLV-FEE-INV-${Number(cn.invoiceId)}`;
    const feeHeldRows = await tx
      .select({ direction: receipts.direction, amount: receipts.amount, referenceNumber: receipts.referenceNumber })
      .from(receipts)
      .where(and(
        eq(receipts.invoiceId, Number(cn.invoiceId)),
        inArray(receipts.referenceNumber, [heldRef, String(cn.consignmentNumber)]),
        inArray(receipts.status, [...MATERIALIZED_RECEIPT_STATUSES]),
        eq(receipts.approvalStatus, "APPROVED"),
      ))
      // current read after the source mutex: a stale snapshot must never authorize a refund.
      .for("update");
    const feeHeldNet = round2(feeHeldRows.reduce(
      (sum, receipt) => receipt.direction === "IN"
        ? sum.plus(money(receipt.amount))
        : sum.minus(money(receipt.amount)),
      money(0),
    ));
    // الإفصاح: أمانةٌ قُبضت فعلاً (وارِدٌ موجب) ثم غادرت الدرج إلى المندوب ⇒ لا التزامَ باقياً
    // نُحرّره، لكن الكاشير يجب أن يعلم (ردُّها للزبون قرارُ إدارةٍ يُسجَّل مصروفاً).
    const feeCollected = round2(feeHeldRows.reduce(
      (sum, receipt) => receipt.direction === "IN" && receipt.referenceNumber === heldRef
        ? sum.plus(money(receipt.amount))
        : sum,
      money(0),
    ));
    const feeAlreadyPaidToCourier = cn.feeSettledAt != null && feeCollected.gt(0);
    if (feeHeldNet.gt(0) && cn.feeSettledAt == null) {
      const feeShift = prelockedReturnShift;
      if (!feeShift) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تغيّرت أمانة أجرة التوصيل أثناء الإرجاع؛ أعد المحاولة",
        });
      }
      await assertCashOutAvailable(tx, {
        branchId: Number(cn.branchId), cashBucket: "DRAWER", shiftId: feeShift.shiftId,
        amount: feeHeldNet, operation: "رد أمانة أجرة التوصيل",
      });
      const feeOut = await tx.insert(receipts).values({
        branchId: Number(cn.branchId), shiftId: feeShift.shiftId, invoiceId: Number(cn.invoiceId),
        direction: "OUT", amount: toDbMoney(feeHeldNet), paymentMethod: "CASH", cashBucket: "DRAWER",
        status: "COMPLETED", partyType: "OTHER",
        referenceNumber: `DLV-FEE-INV-${Number(cn.invoiceId)}`,
        description: `ردّ أمانة أجرة توصيل — إرجاع ${cn.consignmentNumber}`,
        createdBy: actor.userId,
      });
      await postEntry(tx, {
        entryType: "DELIVERY_FEE_HELD",
        postingIntent: deliveryFeeHeldPayoutIntent(feeHeldNet.neg(), "DRAWER"),
        postingSourceComponents: {
          roleDebits: { COURIER_PAYABLE: feeHeldNet },
          roleCredits: { CASH: feeHeldNet },
        },
        dedupeKey: `DELIVERY_FEE_HELD_REFUND:${consignmentId}`,
        branchId: Number(cn.branchId), invoiceId: Number(cn.invoiceId),
        receiptId: extractInsertId(feeOut),
        amount: feeHeldNet.neg(),
        notes: `ردّ أمانة أجرة توصيل — إرجاع ${cn.consignmentNumber}`,
      });
    }

    const returnedAt = new Date();
    await tx.update(deliveryConsignments).set({
      status: "RETURNED",
      parcelStatus: "RETURNED",
      moneyStatus: "CANCELLED",
      returnedAt,
      settledAt: returnedAt,
    }).where(eq(deliveryConsignments.id, consignmentId));
    if (cn.workOrderId != null) {
      await tx.update(workOrders).set({ status: "CANCELLED" }).where(eq(workOrders.id, Number(cn.workOrderId)));
    }
    if (cn.sourceType === "ONLINE_ORDER") {
      await tx.update(onlineOrders).set({ status: "CANCELLED" }).where(eq(onlineOrders.id, Number(cn.sourceId)));
    }
    await appendDeliveryEvent(tx, {
      eventKey: `CN:${consignmentId}:RETURNED:${actor.clientRequestId ?? "legacy"}`,
      consignmentId,
      eventType: "RETURNED",
      fromParcelStatus: cn.parcelStatus,
      toParcelStatus: "RETURNED",
      fromMoneyStatus: cn.moneyStatus,
      toMoneyStatus: "CANCELLED",
      actorUserId: actor.userId,
      payload: { invoiceId: Number(cn.invoiceId) },
    });
    if (actor.clientRequestId) await recordIdempotencyKey(tx, "delivery.return", actor.clientRequestId, consignmentId, payloadHash);
    void party;
    return {
      consignmentId,
      reversed: true as const,
      invoiceId: Number(cn.invoiceId),
      /** أمانة أجرةٍ صُرفت للمندوب قبل الإرجاع ⇒ لم تُردّ هنا (ردُّها للزبون قرارُ مالكٍ = مصروف). */
      feeAlreadyPaidToCourier,
      deliveryFee: String(cn.deliveryFee ?? "0"),
    };
  });
}
