/**
 * خدمة التسوية التلقائية والمطابقة الذكية لذمم العملاء والموردين (FIFO Auto-Settlement).
 *
 * تغلق الفجوة المحاسبية بين كشف الحساب (الذي يظهر الرصيد صفر بعد سداد بسند قبض عام)
 * وبين أعمار الذمم وحالة الفواتير (التي كانت تظل معلقة وغير مسددة لغياب التخصيص التلقائي).
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { Tx } from "../../db";
import { customers, invoices, purchaseOrders, suppliers } from "../../../drizzle/schema";
import { isDeadInvoice } from "@shared/predicates";
import { computeInvoiceStatus } from "../ledgerService";
import { money, toDbMoney } from "../money";
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

  // فرز الفواتير في الذاكرة لتطبيق قاعدة الأسبقية المحاسبية FIFO (تاريخ الفاتورة ثم رقمها)
  openInvoices.sort((a, b) => {
    const da = new Date(a.invoiceDate).getTime();
    const db = new Date(b.invoiceDate).getTime();
    if (da !== db) return da - db;
    return a.id - b.id;
  });

  // حساب إجمالي متبقي الفواتير المفتوحة
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

  const currentBalance = money(cust.currentBalance);

  // الرصيد المتاح للتسوية:
  // إذا كان رصيد العميل صفراً أو سالباً (دائناً): كل الفواتير المفتوحة مستحقة للإقفال التام
  // إذا كان موجباً: الفارق بين مجموع الفواتير المفتوحة والرصيد الحالي يمثل دفعات غير مخصصة
  let availableCredit = currentBalance.lte(0)
    ? totalOpenInvoiceRemaining
    : totalOpenInvoiceRemaining.minus(currentBalance);

  if (availableCredit.lte(0)) {
    return {
      customerId,
      customerName: cust.name,
      settledInvoicesCount: 0,
      partiallySettledInvoicesCount: 0,
      totalSettledAmount: "0.00",
      remainingOpenDebt: toDbMoney(totalOpenInvoiceRemaining),
      settledInvoiceNumbers: [],
    };
  }

  let settledCount = 0;
  let partiallySettledCount = 0;
  let totalSettled = money(0);
  const settledInvoiceNumbers: string[] = [];

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

    if (newStatus === "PAID") {
      settledCount++;
      settledInvoiceNumbers.push(inv.invoiceNumber);
    } else {
      partiallySettledCount++;
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

  const remainingOpenDebt = totalOpenInvoiceRemaining.minus(totalSettled);

  return {
    customerId,
    customerName: cust.name,
    settledInvoicesCount: settledCount,
    partiallySettledInvoicesCount: partiallySettledCount,
    totalSettledAmount: toDbMoney(totalSettled),
    remainingOpenDebt: toDbMoney(remainingOpenDebt.gt(0) ? remainingOpenDebt : money(0)),
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
 * تسوية شاملة لجميع العملاء الذين رصيدهم صفر لكن لديهم فواتير معلقة مفتوحة.
 */
export async function autoSettleZeroBalanceAccountsTx(
  tx: Tx,
  actor: Actor,
  limit = 50,
): Promise<{
  customerCount: number;
  settledInvoicesCount: number;
  settledAccountsCount: number;
  totalSettledInvoices: number;
  totalSettledAmount: string;
}> {
  // جلب العملاء الذين رصيدهم صفر ولديهم فواتير معلقة بترتيب تصاعدي محدد لمنع التعارض
  const zeroBalanceCustomersWithOpenInvoices = await tx
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
    .where(sql`${customers.currentBalance} <= 0`)
    .groupBy(customers.id)
    .orderBy(asc(customers.id))
    .limit(limit);

  let customerCount = 0;
  let settledInvoicesCount = 0;
  let totalSettled = money(0);

  for (const c of zeroBalanceCustomersWithOpenInvoices) {
    const res = await autoSettleCustomerAccountTx(tx, Number(c.id), actor);
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
