/**
 * خدمة التسوية التلقائية والمطابقة الذكية لذمم العملاء والموردين (FIFO Auto-Settlement).
 *
 * تغلق الفجوة المحاسبية بين كشف الحساب (الذي يظهر الرصيد صفر بعد سداد بسند قبض عام)
 * وبين أعمار الذمم وحالة الفواتير (التي كانت تظل معلقة وغير مسددة لغياب التخصيص التلقائي).
 */
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type { Tx } from "../../db";
import {
  accountingEntries,
  customers,
  deliveryConsignments,
  invoices,
  purchaseOrders,
  suppliers,
} from "../../../drizzle/schema";
import { isDeadInvoice } from "@shared/predicates";
import { openBalanceExpr } from "@shared/predicates/openBalance";
import { adjustCustomerBalance, computeInvoiceStatus, postEntry } from "../ledgerService";
import { deliveryCustomerCollectionIntent } from "../delivery/posting";
import Decimal from "decimal.js";
import { money, round2, toDbMoney } from "../money";
import { logAuditTx } from "../auditService";
import type { Actor } from "../tx";

export interface AutoSettleCustomerResult {
  customerId: number;
  customerName: string;
  settledInvoicesCount: number;
  partiallySettledInvoicesCount: number;
  totalSettledAmount: string;
  remainingOpenDebt: string;
  settledInvoiceNumbers: string[];
}

export interface AutoSettleSupplierResult {
  supplierId: number;
  supplierName: string;
  settledOrdersCount: number;
  partiallySettledOrdersCount: number;
  totalSettledAmount: string;
  remainingOpenDebt: string;
  settledOrderNumbers: string[];
}

/**
 * تسوية فواتير عميل تلقائياً بنظام FIFO مع أي رصيد دائن أو سداد غير مخصص.
 * - إذا كان رصيد العميل <= 0: يتم إقفال جميع فواتيره المفتوحة كـ PAID.
 * - إذا كان رصيد العميل > 0: يتم تخصيص الفائض (مجموع الفواتير المفتوحة - الرصيد) على أقدم الفواتير.
 */
export async function autoSettleCustomerAccountTx(
  tx: Tx,
  customerId: number,
  actor: Actor,
): Promise<AutoSettleCustomerResult> {
  // 1) قفل الفواتير المفتوحة أولاً بترتيب معرفاتها (invoices -> customers)
  // لمنع تعارض الأقفال التبادلي (ABBA deadlock) مع مسارات سداد الفواتير وسندات القبض المخصصة
  const openInvoices = await tx
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.customerId, customerId),
        sql`${invoices.status} IN ('PENDING', 'PARTIALLY_PAID')`,
      ),
    )
    .orderBy(asc(invoices.id))
    .for("update");

  // 2) قفل سجل العميل ثانياً
  const [cust] = await tx
    .select()
    .from(customers)
    .where(eq(customers.id, customerId))
    .for("update");

  if (!cust) {
    throw new Error(`العميل #${customerId} غير موجود`);
  }

  if (openInvoices.length === 0) {
    return {
      customerId,
      customerName: cust.name,
      settledInvoicesCount: 0,
      partiallySettledInvoicesCount: 0,
      totalSettledAmount: "0.00",
      remainingOpenDebt: "0.00",
      settledInvoiceNumbers: [],
    };
  }

  let settledCount = 0;
  let partiallySettledCount = 0;
  let totalSettled = money(0);
  const settledInvoiceNumbers: string[] = [];

  // -------------------------------------------------------------
  // المرحلة الأولى: مطابقة وتسوية فواتير التوصيل المحصلة (Delivery Reconciliation)
  // -------------------------------------------------------------
  // جلب كافة الإرساليات المرتبطة بالفواتير المفتوحة والتي تم تحصيلها أو تسويتها مع شركة/مندوب التوصيل
  const openInvoiceIds = openInvoices.map((inv) => inv.id);
  const deliveryRows = await tx
    .select({
      id: deliveryConsignments.id,
      consignmentNumber: deliveryConsignments.consignmentNumber,
      invoiceId: deliveryConsignments.invoiceId,
      branchId: deliveryConsignments.branchId,
      partyId: deliveryConsignments.partyId,
      codAmount: deliveryConsignments.codAmount,
      collectedAmount: deliveryConsignments.collectedAmount,
      moneyStatus: deliveryConsignments.moneyStatus,
      status: deliveryConsignments.status,
    })
    .from(deliveryConsignments)
    .where(
      and(
        inArray(deliveryConsignments.invoiceId, openInvoiceIds),
        or(
          eq(deliveryConsignments.moneyStatus, "SETTLED"),
          sql`CAST(${deliveryConsignments.collectedAmount} AS DECIMAL(15,2)) > 0`,
        ),
      ),
    );

  let currentCustBalance = money(cust.currentBalance);

  for (const cn of deliveryRows) {
    const inv = openInvoices.find((i) => i.id === Number(cn.invoiceId));
    if (!inv || isDeadInvoice(inv)) continue;

    const net = money(inv.total).minus(money(inv.returnedTotal ?? "0"));
    const currentPaid = money(inv.paidAmount);
    const invoiceNeeded = Decimal.max(net.minus(currentPaid), 0);
    if (invoiceNeeded.lte(0)) continue;

    const targetCollected =
      cn.moneyStatus === "SETTLED" && money(cn.collectedAmount).isZero()
        ? money(cn.codAmount)
        : money(cn.collectedAmount);

    if (targetCollected.lte(0)) continue;

    // فحص ما تم تقييده مسبقاً لصالح العميل من هذه الإرسالية في دفتر الأستاذ
    const creditedRow = (
      await tx
        .select({
          v: sql<string>`COALESCE(SUM(CAST(${accountingEntries.amount} AS DECIMAL(15,2))), 0)`,
        })
        .from(accountingEntries)
        .where(
          and(
            eq(accountingEntries.entryType, "PAYMENT_IN"),
            or(
              eq(accountingEntries.dedupeKey, `PAYMENT_IN:COURIER_DELIVERY:${Number(cn.id)}`),
              sql`${accountingEntries.dedupeKey} LIKE ${`PAYMENT_IN:COURIER_DELIVERY_SUPP:${Number(cn.id)}:%`}`,
              sql`${accountingEntries.dedupeKey} LIKE ${`PAYMENT_IN:REMIT:${Number(cn.id)}:%`}`,
              eq(accountingEntries.dedupeKey, `PAYMENT_IN:WRITEOFF:CN:${Number(cn.id)}`),
              eq(accountingEntries.dedupeKey, `PAYMENT_IN:DELIVERY_RECONCILE:${Number(cn.id)}`),
            ),
          ),
        )
    )[0];

    const alreadyCredited = round2(money(creditedRow?.v ?? "0"));
    const uncredited = Decimal.max(round2(targetCollected.minus(alreadyCredited)), 0);

    if (uncredited.gt(0)) {
      // المبلغ حُصّل من العميل عبر التوصيل ولم يُقيّد دفترياً على حسابه:
      // ١) نثبت قيد PAYMENT_IN ذري بالدفتر
      // ٢) نخفض رصيد العميل بالدفتر
      // ٣) نخصص السداد للفاتورة
      const allocToInvoice = Decimal.min(uncredited, invoiceNeeded);

      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        dedupeKey: `PAYMENT_IN:DELIVERY_RECONCILE:${cn.id}`,
        postingIntent: deliveryCustomerCollectionIntent(uncredited),
        branchId: Number(cn.branchId),
        invoiceId: Number(cn.invoiceId),
        customerId,
        deliveryPartyId: Number(cn.partyId),
        amount: uncredited,
        notes: `تسوية تحصيل توصيل ${cn.consignmentNumber} غير مقيد سابقاً`,
      });

      await adjustCustomerBalance(tx, customerId, uncredited.neg());
      currentCustBalance = currentCustBalance.minus(uncredited);

      const newPaid = currentPaid.plus(allocToInvoice);
      const newStatus = computeInvoiceStatus(inv.total, toDbMoney(newPaid), inv.returnedTotal ?? "0");

      await tx
        .update(invoices)
        .set({
          paidAmount: toDbMoney(newPaid),
          status: newStatus,
          paymentDate: new Date(),
          paymentMethod: sql`COALESCE(${invoices.paymentMethod}, 'CASH')`,
        })
        .where(eq(invoices.id, inv.id));

      inv.paidAmount = toDbMoney(newPaid);
      inv.status = newStatus;
      totalSettled = totalSettled.plus(allocToInvoice);

      if (newStatus === "PAID") {
        settledCount++;
        settledInvoiceNumbers.push(inv.invoiceNumber);
      } else {
        partiallySettledCount++;
      }
    } else {
      // المبلغ حُصّل وقُيّد في ذمة العميل سابقاً ولكن الفاتورة ظلت معلقة أو غير مكتملة الدفع
      const missingOnInvoice = Decimal.max(Decimal.min(invoiceNeeded, targetCollected.minus(currentPaid)), 0);
      if (missingOnInvoice.gt(0)) {
        const newPaid = currentPaid.plus(missingOnInvoice);
        const newStatus = computeInvoiceStatus(inv.total, toDbMoney(newPaid), inv.returnedTotal ?? "0");

        await tx
          .update(invoices)
          .set({
            paidAmount: toDbMoney(newPaid),
            status: newStatus,
            paymentDate: new Date(),
            paymentMethod: sql`COALESCE(${invoices.paymentMethod}, 'CASH')`,
          })
          .where(eq(invoices.id, inv.id));

        inv.paidAmount = toDbMoney(newPaid);
        inv.status = newStatus;
        totalSettled = totalSettled.plus(missingOnInvoice);

        if (newStatus === "PAID") {
          settledCount++;
          settledInvoiceNumbers.push(inv.invoiceNumber);
        } else {
          partiallySettledCount++;
        }
      }
    }
  }

  // -------------------------------------------------------------
  // المرحلة الثانية: تسوية FIFO مع أي رصيد دائن أو سدادات عامة غير مخصصة
  // -------------------------------------------------------------
  // فرز الفواتير في الذاكرة لتطبيق قاعدة الأسبقية المحاسبية FIFO (تاريخ الفاتورة ثم رقمها)
  openInvoices.sort((a, b) => {
    const da = new Date(a.invoiceDate).getTime();
    const db = new Date(b.invoiceDate).getTime();
    if (da !== db) return da - db;
    return a.id - b.id;
  });

  // حساب إجمالي متبقي الفواتير المفتوحة بعد تسوية التوصيل
  let totalOpenInvoiceRemaining = money(0);
  for (const inv of openInvoices) {
    if (isDeadInvoice(inv)) continue;
    const net = money(inv.total).minus(money(inv.returnedTotal ?? "0"));
    const paid = money(inv.paidAmount);
    const rem = net.minus(paid);
    if (rem.gt(0)) {
      totalOpenInvoiceRemaining = totalOpenInvoiceRemaining.plus(rem);
    }
  }

  // الرصيد المتاح للتسوية:
  // إذا كان رصيد العميل صفراً أو سالباً (دائناً): كل الفواتير المفتوحة مستحقة للإقفال التام
  // إذا كان موجباً: الفارق بين مجموع الفواتير المفتوحة والرصيد الحالي يمثل دفعات غير مخصصة
  let availableCredit = currentCustBalance.lte(0)
    ? totalOpenInvoiceRemaining
    : Decimal.max(totalOpenInvoiceRemaining.minus(currentCustBalance), 0);

  if (availableCredit.gt(0)) {
    for (const inv of openInvoices) {
      if (availableCredit.lte(0)) break;
      if (isDeadInvoice(inv)) continue;

      const net = money(inv.total).minus(money(inv.returnedTotal ?? "0"));
      const currentPaid = money(inv.paidAmount);
      const needed = net.minus(currentPaid);
      if (needed.lte(0)) continue;

      const allocate = availableCredit.lt(needed) ? availableCredit : needed;
      const newPaid = currentPaid.plus(allocate);
      availableCredit = availableCredit.minus(allocate);
      totalSettled = totalSettled.plus(allocate);

      const newStatus = computeInvoiceStatus(inv.total, toDbMoney(newPaid), inv.returnedTotal ?? "0");

      await tx
        .update(invoices)
        .set({
          paidAmount: toDbMoney(newPaid),
          status: newStatus,
          paymentDate: new Date(),
        })
        .where(eq(invoices.id, inv.id));

      inv.paidAmount = toDbMoney(newPaid);
      inv.status = newStatus;

      if (newStatus === "PAID") {
        if (!settledInvoiceNumbers.includes(inv.invoiceNumber)) {
          settledCount++;
          settledInvoiceNumbers.push(inv.invoiceNumber);
        }
      } else {
        partiallySettledCount++;
      }
    }
  }

  if (totalSettled.gt(0)) {
    await logAuditTx(tx, actor, {
      action: "customer.autoSettle",
      entityType: "customer",
      entityId: customerId,
      newValue: {
        settledInvoicesCount: settledCount,
        partiallySettledInvoicesCount: partiallySettledCount,
        totalSettledAmount: toDbMoney(totalSettled),
        settledInvoiceNumbers,
      },
    });
  }

  // حساب المتبقي النهائي بعد كافة مراحل التسوية
  let finalRemainingOpenDebt = money(0);
  for (const inv of openInvoices) {
    if (isDeadInvoice(inv)) continue;
    const net = money(inv.total).minus(money(inv.returnedTotal ?? "0"));
    const paid = money(inv.paidAmount);
    const rem = net.minus(paid);
    if (rem.gt(0)) {
      finalRemainingOpenDebt = finalRemainingOpenDebt.plus(rem);
    }
  }

  return {
    customerId,
    customerName: cust.name,
    settledInvoicesCount: settledCount,
    partiallySettledInvoicesCount: partiallySettledCount,
    totalSettledAmount: toDbMoney(totalSettled),
    remainingOpenDebt: toDbMoney(finalRemainingOpenDebt.gt(0) ? finalRemainingOpenDebt : money(0)),
    settledInvoiceNumbers,
  };
}

/**
 * تسوية أوامر شراء مورد تلقائياً بنظام FIFO مع أي سداد غير مخصص.
 */
export async function autoSettleSupplierAccountTx(
  tx: Tx,
  supplierId: number,
  actor: Actor,
): Promise<AutoSettleSupplierResult> {
  // 1) قفل أوامر الشراء المفتوحة أولاً بترتيب معرفاتها (purchaseOrders -> suppliers)
  // لمنع أي تعارض أقفال تبادلي مع مسارات سداد المشتريات
  const openOrders = await tx
    .select()
    .from(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.supplierId, supplierId),
        sql`${purchaseOrders.status} IN ('CONFIRMED', 'RECEIVED')`,
        sql`${purchaseOrders.paidAmount} < ${purchaseOrders.total}`,
      ),
    )
    .orderBy(asc(purchaseOrders.id))
    .for("update");

  // 2) قفل سجل المورد ثانياً
  const [sup] = await tx
    .select()
    .from(suppliers)
    .where(eq(suppliers.id, supplierId))
    .for("update");

  if (!sup) {
    throw new Error(`المورد #${supplierId} غير موجود`);
  }

  if (openOrders.length === 0) {
    return {
      supplierId,
      supplierName: sup.name,
      settledOrdersCount: 0,
      partiallySettledOrdersCount: 0,
      totalSettledAmount: "0.00",
      remainingOpenDebt: "0.00",
      settledOrderNumbers: [],
    };
  }

  // فرز أوامر الشراء في الذاكرة لتطبيق قاعدة FIFO (تاريخ الطلب ثم رقمه)
  openOrders.sort((a, b) => {
    const da = new Date(a.orderDate).getTime();
    const db = new Date(b.orderDate).getTime();
    if (da !== db) return da - db;
    return a.id - b.id;
  });

  let totalOpenPoRemaining = money(0);
  for (const po of openOrders) {
    const total = money(po.total);
    const paid = money(po.paidAmount);
    const rem = total.minus(paid);
    if (rem.gt(0)) {
      totalOpenPoRemaining = totalOpenPoRemaining.plus(rem);
    }
  }

  const currentBalance = money(sup.currentBalance);

  // في الموردين: currentBalance موجب = علينا له (AP)
  // إذا كان رصيد المورد <= 0: كل الأوامر تسدد بالكامل
  // إذا كان موجباً: الفارق بين الأوامر المفتوحة والرصيد الحالي يمثل سداداً غير مخصص
  let availableCredit = currentBalance.lte(0)
    ? totalOpenPoRemaining
    : totalOpenPoRemaining.minus(currentBalance);

  if (availableCredit.lte(0)) {
    return {
      supplierId,
      supplierName: sup.name,
      settledOrdersCount: 0,
      partiallySettledOrdersCount: 0,
      totalSettledAmount: "0.00",
      remainingOpenDebt: toDbMoney(totalOpenPoRemaining),
      settledOrderNumbers: [],
    };
  }

  let settledCount = 0;
  let partiallySettledCount = 0;
  let totalSettled = money(0);
  const settledOrderNumbers: string[] = [];

  for (const po of openOrders) {
    if (availableCredit.lte(0)) break;

    const total = money(po.total);
    const currentPaid = money(po.paidAmount);
    const needed = total.minus(currentPaid);
    if (needed.lte(0)) continue;

    const allocate = availableCredit.lt(needed) ? availableCredit : needed;
    const newPaid = currentPaid.plus(allocate);
    availableCredit = availableCredit.minus(allocate);
    totalSettled = totalSettled.plus(allocate);

    await tx
      .update(purchaseOrders)
      .set({
        paidAmount: toDbMoney(newPaid),
      })
      .where(eq(purchaseOrders.id, po.id));

    if (newPaid.gte(total)) {
      settledCount++;
      settledOrderNumbers.push(po.poNumber);
    } else {
      partiallySettledCount++;
    }
  }

  if (totalSettled.gt(0)) {
    await logAuditTx(tx, actor, {
      action: "supplier.autoSettle",
      entityType: "supplier",
      entityId: supplierId,
      newValue: {
        settledOrdersCount: settledCount,
        partiallySettledOrdersCount: partiallySettledCount,
        totalSettledAmount: toDbMoney(totalSettled),
        settledOrderNumbers,
      },
    });
  }

  const remainingOpenDebt = totalOpenPoRemaining.minus(totalSettled);

  return {
    supplierId,
    supplierName: sup.name,
    settledOrdersCount: settledCount,
    partiallySettledOrdersCount: partiallySettledCount,
    totalSettledAmount: toDbMoney(totalSettled),
    remainingOpenDebt: toDbMoney(remainingOpenDebt.gt(0) ? remainingOpenDebt : money(0)),
    settledOrderNumbers,
  };
}

/**
 * تسوية شاملة لجميع حسابات العملاء التي تحوي سدادات غير مخصصة أو فواتير مفتوحة برصيد صفر/دائن.
 */
export async function autoSettleAllAccountsTx(
  tx: Tx,
  actor: Actor,
  limit = 500,
): Promise<{
  customerCount: number;
  settledInvoicesCount: number;
  settledAccountsCount: number;
  totalSettledInvoices: number;
  totalSettledAmount: string;
}> {
  const openBal = openBalanceExpr(
    { total: invoices.total, paidAmount: invoices.paidAmount, returnedTotal: invoices.returnedTotal },
    "COLLECTIBLE",
  );
  // 1) جلب العملاء الذين لديهم فواتير معلقة مع وجود سداد غير مخصص (الرصيد <= 0 أو مجموع الفواتير المفتوحة > الرصيد)
  const customersWithUnsettledCredits = await tx
    .select({
      id: customers.id,
    })
    .from(customers)
    .innerJoin(
      invoices,
      and(
        eq(invoices.customerId, customers.id),
        sql`${invoices.status} IN ('PENDING', 'PARTIALLY_PAID')`,
      ),
    )
    .groupBy(customers.id, customers.currentBalance)
    .having(
      sql`${customers.currentBalance} <= 0 OR SUM(${openBal}) > CAST(${customers.currentBalance} AS DECIMAL(15,2))`,
    )
    .orderBy(asc(customers.id))
    .limit(limit);

  // 2) جلب العملاء الذين لديهم فواتير معلقة مرتبطة بإرساليات توصيل محصلة أو مسواة
  const customersWithSettledDelivery = await tx
    .select({
      id: customers.id,
    })
    .from(customers)
    .innerJoin(
      invoices,
      and(
        eq(invoices.customerId, customers.id),
        sql`${invoices.status} IN ('PENDING', 'PARTIALLY_PAID')`,
      ),
    )
    .innerJoin(
      deliveryConsignments,
      and(
        eq(deliveryConsignments.invoiceId, invoices.id),
        or(
          eq(deliveryConsignments.moneyStatus, "SETTLED"),
          sql`CAST(${deliveryConsignments.collectedAmount} AS DECIMAL(15,2)) > 0`,
        ),
      ),
    )
    .groupBy(customers.id)
    .orderBy(asc(customers.id))
    .limit(limit);

  // دمج قائمتي العملاء المستحقين للتسوية بدون تكرار
  const candidateIds = Array.from(
    new Set([
      ...customersWithUnsettledCredits.map((c) => Number(c.id)),
      ...customersWithSettledDelivery.map((c) => Number(c.id)),
    ]),
  )
    .sort((a, b) => a - b)
    .slice(0, limit);

  let customerCount = 0;
  let settledInvoicesCount = 0;
  let totalSettled = money(0);

  for (const cid of candidateIds) {
    const res = await autoSettleCustomerAccountTx(tx, cid, actor);
    if (res.settledInvoicesCount > 0 || res.partiallySettledInvoicesCount > 0) {
      customerCount++;
      settledInvoicesCount += res.settledInvoicesCount + res.partiallySettledInvoicesCount;
      totalSettled = totalSettled.plus(money(res.totalSettledAmount));
    }
  }

  return {
    customerCount,
    settledInvoicesCount,
    settledAccountsCount: customerCount,
    totalSettledInvoices: settledInvoicesCount,
    totalSettledAmount: toDbMoney(totalSettled),
  };
}

/**
 * تسوية شاملة لجميع حسابات الموردين التي تحوي سدادات غير مخصصة أو أوامر شراء مفتوحة برصيد دائن غير مطابق.
 */
export async function autoSettleAllSuppliersTx(
  tx: Tx,
  actor: Actor,
  limit = 500,
): Promise<{
  supplierCount: number;
  settledOrdersCount: number;
  settledAccountsCount: number;
  totalSettledOrders: number;
  totalSettledAmount: string;
}> {
  const suppliersWithUnsettledCredits = await tx
    .select({
      id: suppliers.id,
    })
    .from(suppliers)
    .innerJoin(
      purchaseOrders,
      and(
        eq(purchaseOrders.supplierId, suppliers.id),
        sql`${purchaseOrders.status} IN ('CONFIRMED', 'RECEIVED')`,
        sql`CAST(${purchaseOrders.paidAmount} AS DECIMAL(15,2)) < CAST(${purchaseOrders.total} AS DECIMAL(15,2))`,
      ),
    )
    .groupBy(suppliers.id, suppliers.currentBalance)
    .having(
      sql`${suppliers.currentBalance} <= 0 OR SUM(CAST(${purchaseOrders.total} AS DECIMAL(15,2)) - CAST(${purchaseOrders.paidAmount} AS DECIMAL(15,2))) > CAST(${suppliers.currentBalance} AS DECIMAL(15,2))`,
    )
    .orderBy(asc(suppliers.id))
    .limit(limit);

  let supplierCount = 0;
  let settledOrdersCount = 0;
  let totalSettled = money(0);

  for (const s of suppliersWithUnsettledCredits) {
    const res = await autoSettleSupplierAccountTx(tx, Number(s.id), actor);
    if (res.settledOrdersCount > 0 || res.partiallySettledOrdersCount > 0) {
      supplierCount++;
      settledOrdersCount += res.settledOrdersCount + res.partiallySettledOrdersCount;
      totalSettled = totalSettled.plus(money(res.totalSettledAmount));
    }
  }

  return {
    supplierCount,
    settledOrdersCount,
    settledAccountsCount: supplierCount,
    totalSettledOrders: settledOrdersCount,
    totalSettledAmount: toDbMoney(totalSettled),
  };
}

/**
 * تسوية متوافقة رجعياً لحسابات العملاء ذات الرصيد الصفري أو السداد غير المخصص.
 */
export async function autoSettleZeroBalanceAccountsTx(
  tx: Tx,
  actor: Actor,
  limit = 500,
): Promise<{
  customerCount: number;
  settledInvoicesCount: number;
  settledAccountsCount: number;
  totalSettledInvoices: number;
  totalSettledAmount: string;
}> {
  return autoSettleAllAccountsTx(tx, actor, limit);
}

