import { formatBaghdadTime } from "./format";

export const getBackendUrl = (): string => {
  let expoApiUrl: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Constants = require("expo-constants");
    expoApiUrl = (Constants?.default || Constants)?.expoConfig?.extra?.apiBaseUrl;
  } catch {
    // In Node test environments where expo-constants is not available
  }

  const configured =
    expoApiUrl ||
    process.env.EXPO_PUBLIC_API_URL ||
    process.env.ERP_API_BASE_URL;
  if (configured && typeof configured === "string" && configured.trim().length > 0) {
    return configured.trim();
  }
  if (typeof window !== "undefined" && window.location && window.location.origin) {
    if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
      return "http://localhost:3000";
    }
    return window.location.origin;
  }
  return "https://srv1548487.hstgr.cloud";
};

export function getTodayBaghdadYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Baghdad",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function formatYmdInBaghdad(dateInput?: string | Date | null): string {
  if (!dateInput) return "";
  const d = typeof dateInput === "string" ? new Date(dateInput) : dateInput;
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Baghdad",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

async function trpcQuery<T>(path: string, input?: Record<string, unknown>): Promise<T> {
  const url = new URL(`${getBackendUrl()}/api/trpc/${path}`);
  if (input !== undefined) {
    url.searchParams.set("batch", "1");
    url.searchParams.set("input", JSON.stringify({ "0": { json: input } }));
  }
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "x-erp-csrf": "1",
    },
    credentials: "include",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.json?.message || `خطأ في الاتصال بالخادم (${res.status})`);
  }
  const data = await res.json();
  if (input !== undefined && Array.isArray(data)) {
    if (data[0]?.error) {
      throw new Error(data[0].error.json?.message || "خطأ في معالجة الطلب");
    }
    return data[0]?.result?.data?.json as T;
  }
  if (data?.error) {
    throw new Error(data.error.json?.message || "خطأ في معالجة الطلب");
  }
  return data?.result?.data?.json as T;
}

async function trpcMutation<T>(path: string, input?: Record<string, unknown>): Promise<T> {
  const url = `${getBackendUrl()}/api/trpc/${path}?batch=1`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-erp-csrf": "1",
    },
    credentials: "include",
    body: JSON.stringify({ "0": { json: input ?? {} } }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.json?.message || `خطأ في الاتصال بالخادم (${res.status})`);
  }
  const data = await res.json();
  if (Array.isArray(data)) {
    if (data[0]?.error) {
      throw new Error(data[0].error.json?.message || "خطأ في معالجة الطلب");
    }
    return data[0]?.result?.data?.json as T;
  }
  if (data?.error) {
    throw new Error(data.error.json?.message || "خطأ في معالجة الطلب");
  }
  return data?.result?.data?.json as T;
}

export type RealInvoice = {
  id: string;
  invoiceNumber: string;
  customerName: string;
  customerPhone?: string;
  salespersonName?: string;
  branchName: string;
  amount: number;
  paidAmount: number;
  remainingAmount: number;
  paymentMethod: "CASH" | "CARD" | "WALLET" | "TRANSFER" | "MIXED" | "CREDIT";
  status: "PAID" | "PENDING" | "CANCELLED" | "RETURNED" | "SUPERSEDED" | "PARTIALLY_PAID";
  createdAt: string;
  invoiceDateYmd: string;
  itemCount: number;
  items: { name: string; qty: number; unitPrice: number; total: number; unitName?: string }[];
};

export async function fetchRealInvoices(options?: {
  limit?: number;
  offset?: number;
}): Promise<RealInvoice[]> {
  try {
    const rawList = await trpcQuery<any[]>("sales.list", {
      limit: options?.limit ?? 50,
      offset: options?.offset ?? 0,
    });
    if (!Array.isArray(rawList)) return [];

    return rawList.map((row) => {
      const amount = parseFloat(row.total || "0");
      const paid = parseFloat(row.paidAmount || "0");
      const remainingAmount = Math.max(0, amount - paid);

      const rawStatus = String(row.status || "").toUpperCase();
      let status: RealInvoice["status"] = "PENDING";
      if (rawStatus === "CANCELLED") {
        status = "CANCELLED";
      } else if (rawStatus === "RETURNED") {
        status = "RETURNED";
      } else if (rawStatus === "SUPERSEDED") {
        status = "SUPERSEDED";
      } else if (paid >= amount && amount > 0) {
        status = "PAID";
      } else if (paid > 0 && paid < amount) {
        status = "PARTIALLY_PAID";
      } else if (rawStatus === "COMPLETED" || rawStatus === "PAID") {
        status = "PAID";
      }

      let paymentMethod: RealInvoice["paymentMethod"] = "CASH";
      const rawPm = String(row.paymentMethod || "").toUpperCase();
      if (rawPm === "CARD" || rawPm === "QI_CARD") {
        paymentMethod = "CARD";
      } else if (rawPm === "WALLET" || rawPm === "ZAIN_CASH") {
        paymentMethod = "WALLET";
      } else if (rawPm === "TRANSFER") {
        paymentMethod = "TRANSFER";
      } else if (rawPm === "MIXED") {
        paymentMethod = "MIXED";
      } else if (rawPm === "DEBT" || rawPm === "CREDIT" || status === "PENDING") {
        paymentMethod = "CREDIT";
      }

      const branchName = row.branchId === 2 ? "فرع الكرادة" : "الفرع الرئيسي - المنصور";
      const invoiceDateRaw = row.invoiceDate || row.createdAt;
      const invoiceDateYmd = formatYmdInBaghdad(invoiceDateRaw) || (typeof invoiceDateRaw === "string" ? invoiceDateRaw.slice(0, 10) : "");

      return {
        id: String(row.id),
        invoiceNumber: String(row.invoiceNumber || row.id),
        customerName: row.customerName || "عميل نقدي",
        customerPhone: row.customerPhone || undefined,
        salespersonName: row.salespersonName || undefined,
        branchName,
        amount,
        paidAmount: paid,
        remainingAmount,
        paymentMethod,
        status,
        createdAt: formatBaghdadTime(invoiceDateRaw) ?? "—",
        invoiceDateYmd,
        itemCount: Number(row.itemCount ?? 1),
        items: [
          {
            name: `فاتورة مبيعات رقم ${row.invoiceNumber || row.id}`,
            qty: 1,
            unitPrice: amount,
            total: amount,
          },
        ],
      };
    });
  } catch (error) {
    console.error("fetchRealInvoices failed:", error);
    throw error;
  }
}

export async function fetchRealInvoiceDetails(invoiceId: number): Promise<{
  id: string;
  invoiceNumber: string;
  items: { name: string; qty: number; unitPrice: number; total: number; unitName?: string }[];
  payments: { amount: number; paymentMethod: string; createdAt: string }[];
} | null> {
  try {
    const raw = await trpcQuery<any>("sales.get", { invoiceId });
    if (!raw) return null;
    const items = (raw.items || []).map((it: any) => ({
      name: it.productName || it.variantName || `صنف #${it.productId}`,
      qty: Number(it.quantity ?? it.baseQuantity ?? 1),
      unitPrice: parseFloat(it.unitPrice || "0"),
      total: parseFloat(it.total || "0"),
      unitName: it.unitName || undefined,
    }));
    const payments = (raw.payments || []).map((p: any) => ({
      amount: parseFloat(p.amount || "0"),
      paymentMethod: p.paymentMethod || "CASH",
      createdAt: formatBaghdadTime(p.createdAt) ?? "—",
    }));
    return {
      id: String(raw.id),
      invoiceNumber: String(raw.invoiceNumber || raw.id),
      items,
      payments,
    };
  } catch (err) {
    console.error(`fetchRealInvoiceDetails(${invoiceId}) failed:`, err);
    return null;
  }
}

export type RealInventoryItem = {
  id: string;
  name: string;
  barcode: string;
  category: string;
  branchMansourQty: number;
  branchKarradaQty: number;
  reorderLevel: number;
  unitPrice: number;
  unit: string;
  status: "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";
};

export async function fetchRealInventory(options?: {
  query?: string;
  limit?: number;
}): Promise<RealInventoryItem[]> {
  try {
    const [mansourRes, karradaRes] = await Promise.all([
      trpcQuery<{ rows: any[] }>("catalog.adminList", {
        branchId: 1,
        limit: options?.limit ?? 60,
        q: options?.query?.trim() || undefined,
      }),
      trpcQuery<{ rows: any[] }>("catalog.adminList", {
        branchId: 2,
        limit: options?.limit ?? 60,
        q: options?.query?.trim() || undefined,
      }).catch(() => null),
    ]);

    if (!mansourRes?.rows || !Array.isArray(mansourRes.rows)) return [];

    const karradaStockMap = new Map<number, number>();
    if (karradaRes?.rows && Array.isArray(karradaRes.rows)) {
      for (const r of karradaRes.rows) {
        const factor = Number(r.conversionFactor) > 0 ? Number(r.conversionFactor) : 1;
        const base = Number(r.availableBase ?? r.stockBase ?? 0);
        karradaStockMap.set(Number(r.productId), Math.floor(base / factor));
      }
    }

    return mansourRes.rows.map((row) => {
      const factor = Number(row.conversionFactor) > 0 ? Number(row.conversionFactor) : 1;
      const base = Number(row.availableBase ?? row.stockBase ?? 0);
      const stock = Math.floor(base / factor);
      const karradaQty = karradaStockMap.get(Number(row.productId)) ?? 0;
      const reorder = Number(row.reorderPoint ?? row.minStock ?? 5);
      const totalAvailable = stock + karradaQty;
      let status: RealInventoryItem["status"] = "IN_STOCK";
      if (totalAvailable <= 0) status = "OUT_OF_STOCK";
      else if (totalAvailable <= reorder) status = "LOW_STOCK";

      return {
        id: String(row.productId),
        name: row.productName || "صنف بدون اسم",
        barcode: row.barcode || "لا يوجد باركود",
        category: row.categoryName || "عام",
        branchMansourQty: stock,
        branchKarradaQty: karradaQty,
        reorderLevel: reorder,
        unitPrice: parseFloat(row.price || "0"),
        unit: row.unitName || "قطعة",
        status,
      };
    });
  } catch (error) {
    console.error("fetchRealInventory failed:", error);
    throw error;
  }
}

export type RealCustomer = {
  id: string;
  name: string;
  phone: string;
  type: string;
  balance: number;
  priceTier: string;
  city?: string;
  district?: string;
  invoiceCount: number;
};

export async function fetchRealCustomers(): Promise<RealCustomer[]> {
  try {
    const rawList = await trpcQuery<any[]>("customers.list");
    if (!Array.isArray(rawList)) return [];

    return rawList.map((row) => ({
      id: String(row.id),
      name: row.name || "عميل غير مسمى",
      phone: row.phone || row.whatsapp || "لا يوجد هاتف",
      type: row.customerType || "فرد",
      balance: parseFloat(row.currentBalance || "0"),
      priceTier: row.defaultPriceTier === "WHOLESALE" ? "جملة" : "مفرد",
      city: row.city || undefined,
      district: row.district || undefined,
      invoiceCount: 0,
    }));
  } catch (error) {
    console.error("fetchRealCustomers failed:", error);
    throw error;
  }
}

export type RealApproval = {
  id: string;
  numericId: number;
  kind: string;
  type: "DISCOUNT" | "CREDIT" | "EXPENSE" | "LEAVE" | "STOCK_ADJUSTMENT";
  title: string;
  amount?: number;
  requesterName: string;
  branchName: string;
  notes: string;
  createdAt: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  expectedVersion?: number | null;
  allowedActions?: ("APPROVE" | "REJECT" | "WITHDRAW")[];
};

export async function fetchRealApprovals(): Promise<RealApproval[]> {
  try {
    const inbox = await trpcQuery<{ rows: any[] }>("decisions.inbox", { limit: 40 }).catch(() => null);
    if (inbox?.rows && Array.isArray(inbox.rows)) {
      return inbox.rows.map((row) => {
        let type: RealApproval["type"] = "EXPENSE";
        const kind = String(row.kind || "").toLowerCase();
        if (kind.includes("stock") || kind.includes("inventory")) {
          type = "STOCK_ADJUSTMENT";
        } else if (kind.includes("leave") || kind.includes("hr")) {
          type = "LEAVE";
        } else if (kind.includes("sale") || kind.includes("discount")) {
          type = "DISCOUNT";
        } else if (kind.includes("credit") || kind.includes("voucher")) {
          type = "CREDIT";
        }

        const notes =
          row.reason ||
          (Array.isArray(row.summaryItems)
            ? row.summaryItems.map((s: any) => `${s.label}: ${s.value}`).join(" · ")
            : "بانتظار المراجعة والاعتماد");

        return {
          id: `${row.kind}-${row.id}`,
          numericId: Number(row.id),
          kind: String(row.kind),
          type,
          title: row.title || "طلب اعتماد معلق",
          amount: row.amount ? parseFloat(row.amount) : undefined,
          requesterName: row.requestedByName || "مستخدم النظام",
          branchName: row.branchName || "الفرع الرئيسي",
          notes,
          createdAt: formatBaghdadTime(row.requestedAt) ?? "—",
          status: "PENDING",
          expectedVersion: row.expectedVersion ?? null,
          allowedActions: row.allowedActions,
        };
      });
    }

    const rawList = await trpcQuery<any[]>("superApp.approvalInbox", { limit: 40 });
    if (!Array.isArray(rawList)) return [];

    return rawList.map((row) => {
      let kind = "expense.approve";
      let type: RealApproval["type"] = "EXPENSE";
      if (row.kind === "inventory") {
        kind = "inventory.adjustment.approve";
        type = "STOCK_ADJUSTMENT";
      } else if (row.kind === "leave") {
        kind = "hr.leave.decide";
        type = "LEAVE";
      } else if (row.kind === "voucher") {
        kind = "treasury.voucher.approve";
        type = "CREDIT";
      } else if (row.kind === "sales_control") {
        kind = "sales.control.approve";
        type = "DISCOUNT";
      }

      return {
        id: `${kind}-${row.id}`,
        numericId: Number(row.id),
        kind,
        type,
        title: row.title || "طلب اعتماد معلق",
        amount: row.amount ? parseFloat(String(row.amount)) : undefined,
        requesterName: row.requesterName || "مستخدم النظام",
        branchName: row.branchName || "الفرع الرئيسي",
        notes: row.detail || row.notes || "بانتظار المراجعة والاعتماد",
        createdAt: formatBaghdadTime(row.createdAt || new Date().toISOString()) ?? "—",
        status: "PENDING",
        expectedVersion: null,
      };
    });
  } catch (error) {
    console.error("fetchRealApprovals failed:", error);
    return [];
  }
}

export async function submitRealDecision(input: {
  kind: string;
  id: number;
  action: "APPROVE" | "REJECT";
  reason?: string;
  expectedVersion?: number | null;
}): Promise<{ outcome: string }> {
  const clientRequestId = `mob-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  return trpcMutation<{ outcome: string }>("decisions.decide", {
    kind: input.kind,
    id: input.id,
    action: input.action,
    clientRequestId,
    reason: input.reason?.trim() || undefined,
    expectedVersion: input.expectedVersion ?? null,
  });
}

export type RealTreasuryOverview = {
  treasuryBalance: number;
  drawerBalance: number;
  totalLiquidCash: number;
  todayReceipts: number;
  todayExpenses: number;
  netTodayCashFlow: number;
  openShiftsCount: number;
  branchTreasuries: { branchId: number; branchName: string; balance: number }[];
  activeDrawers: { shiftId: number; cashierName: string; branchName: string; expectedCash: number }[];
  recentMovements: { id: string; type: "RECEIPT" | "EXPENSE"; amount: number; description: string; branchName: string; createdAt: string }[];
};

export async function fetchRealTreasuryOverview(): Promise<RealTreasuryOverview> {
  const dashboard = await trpcQuery<any>("treasury.getDashboard");
  const treasuryBalance = (dashboard?.treasuryBalances || []).reduce(
    (sum: number, b: any) => sum + parseFloat(b.balance || "0"),
    0,
  );
  const drawerBalance = (dashboard?.drawerBalances || []).reduce(
    (sum: number, d: any) => sum + parseFloat(d.expectedCash || "0"),
    0,
  );
  const todayReceipts = parseFloat(dashboard?.todayReceiptsTotal || "0");
  const todayExpenses = parseFloat(dashboard?.todayExpensesTotal || "0");

  const branchTreasuries = (dashboard?.treasuryBalances || []).map((b: any) => ({
    branchId: b.branchId || 1,
    branchName: b.branchName || (b.branchId === 2 ? "فرع الكرادة" : "الفرع الرئيسي - المنصور"),
    balance: parseFloat(b.balance || "0"),
  }));

  const activeDrawers = (dashboard?.drawerBalances || []).map((d: any) => ({
    shiftId: d.shiftId || 1,
    cashierName: d.cashierName || "كاشير مناوب",
    branchName: d.branchName || (d.branchId === 2 ? "فرع الكرادة" : "الفرع الرئيسي"),
    expectedCash: parseFloat(d.expectedCash || "0"),
  }));

  let recentMovements: RealTreasuryOverview["recentMovements"] = [];
  try {
    const movementsRes = await trpcQuery<any>("treasury.getRecentMovements", { limit: 10 });
    const rows = movementsRes?.rows || (Array.isArray(movementsRes) ? movementsRes : []);
    recentMovements = rows.map((m: any) => ({
      id: String(m.id || Math.random()),
      type: m.type === "EXPENSE" ? "EXPENSE" : "RECEIPT",
      amount: parseFloat(m.amount || "0"),
      description: m.description || m.categoryName || (m.type === "EXPENSE" ? "صرف مصاريف تشغيلية" : "مقبوضات مبيعات"),
      branchName: m.branchId === 2 ? "فرع الكرادة" : "الفرع الرئيسي",
      createdAt: formatBaghdadTime(m.createdAt || new Date().toISOString()) ?? "اليوم",
    }));
  } catch {
    recentMovements = [];
  }

  return {
    treasuryBalance,
    drawerBalance,
    totalLiquidCash: treasuryBalance + drawerBalance,
    todayReceipts,
    todayExpenses,
    netTodayCashFlow: todayReceipts - todayExpenses,
    openShiftsCount: dashboard?.openShiftsCount || activeDrawers.length,
    branchTreasuries,
    activeDrawers,
    recentMovements,
  };
}

export type RealSupplier = {
  id: string;
  name: string;
  phone: string;
  currentBalance: number;
  contactPerson?: string;
  address?: string;
};

export async function fetchRealSuppliers(): Promise<RealSupplier[]> {
  try {
    const rawList = await trpcQuery<any[]>("suppliers.list");
    if (!Array.isArray(rawList)) return [];

    return rawList.map((row) => ({
      id: String(row.id),
      name: row.name || "مورد غير مسمى",
      phone: row.phone || row.mobile || "لا يوجد هاتف",
      currentBalance: parseFloat(row.currentBalance || "0"),
      contactPerson: row.contactPerson || undefined,
      address: row.address || undefined,
    }));
  } catch (error) {
    console.error("fetchRealSuppliers failed:", error);
    return [];
  }
}

export type RealPurchaseOrder = {
  id: string;
  poNumber: string;
  supplierName: string;
  total: number;
  paidAmount: number;
  currency: string;
  status: "DRAFT" | "CONFIRMED" | "RECEIVED" | "CANCELLED";
  orderDate: string;
};

export async function fetchRealPurchases(): Promise<RealPurchaseOrder[]> {
  try {
    const result = await trpcQuery<any>("purchases.list", { limit: 40 });
    const rows = result?.rows || (Array.isArray(result) ? result : []);

    return rows.map((row: any) => ({
      id: String(row.id),
      poNumber: row.poNumber || `PO-${row.id}`,
      supplierName: row.supplierName || "مورد معتمد",
      total: parseFloat(row.total || "0"),
      paidAmount: parseFloat(row.paidAmount || "0"),
      currency: row.agreedCurrency || row.poCurrency || "IQD",
      status: row.status || row.poStatus || "CONFIRMED",
      orderDate: formatBaghdadTime(row.orderDate || row.createdAt) ?? "—",
    }));
  } catch (error) {
    console.error("fetchRealPurchases failed:", error);
    return [];
  }
}
