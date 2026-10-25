import { formatBaghdadTime } from "./format";
import { unlockLocalSession } from "./localSessionUnlock";
import {
  getNativeDecisionsInbox,
  getNativeOperationsActor,
  getNativeSalesInvoice,
  getNativeSuperAppApprovalInbox,
  getNativeTreasuryDashboard,
  getNativeTreasuryRecentMovements,
  isNativeSecureTransportAvailable,
  listNativeAdminCatalog,
  listNativeBranches,
  listNativeCustomers,
  listNativePurchases,
  listNativeSalesInvoices,
  listNativeSuppliers,
  submitWebPreviewDecisionOnly,
  type OperationsBranchSummary,
} from "./secureTransport";

const DEAD_INVOICE_STATUS_SET = new Set(["CANCELLED", "RETURNED", "SUPERSEDED"]);

/**
 * Android `SecureNativeSessionStore` sets `AUTH_VALIDITY_SECONDS = 30`.
 * Reusing a confirmed local unlock for at most 15s avoids back-to-back prompts
 * during master-detail navigation while guaranteeing proactive re-authentication
 * well before the 30s Keystore window expires. Concurrent calls in `Promise.all`
 * share a single in-flight prompt, and any `E_SECURE_TRANSPORT_SESSION_LOCKED`
 * rejection forces an immediate unlock + single retry.
 */
const ANDROID_UNLOCK_REUSE_WINDOW_MS = 15_000;
let inFlightOperationalUnlock: Promise<void> | null = null;
let lastOperationalUnlockAtMs = 0;

function isSessionLockedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "E_SECURE_TRANSPORT_SESSION_LOCKED") return true;
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === "string" &&
    (message.includes("E_SECURE_TRANSPORT_SESSION_LOCKED") ||
      message.includes("protected work session was not unlocked"))
  );
}

async function ensureOperationalSessionUnlocked(force = false): Promise<void> {
  if (!isNativeSecureTransportAvailable()) return;
  const now = Date.now();
  if (
    !force &&
    lastOperationalUnlockAtMs > 0 &&
    now - lastOperationalUnlockAtMs < ANDROID_UNLOCK_REUSE_WINDOW_MS
  ) {
    return;
  }
  if (!inFlightOperationalUnlock) {
    const pending = unlockLocalSession()
      .then(() => {
        lastOperationalUnlockAtMs = Date.now();
      })
      .finally(() => {
        if (inFlightOperationalUnlock === pending) {
          inFlightOperationalUnlock = null;
        }
      });
    inFlightOperationalUnlock = pending;
  }
  await inFlightOperationalUnlock;
}

async function withOperationalReadUnlock<T>(operation: () => Promise<T>): Promise<T> {
  await ensureOperationalSessionUnlocked(false);
  try {
    return await operation();
  } catch (error) {
    if (!isSessionLockedError(error)) {
      throw error;
    }
    lastOperationalUnlockAtMs = 0;
    await ensureOperationalSessionUnlocked(true);
    return await operation();
  }
}

export function __resetOperationalSessionUnlockForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Test reset helper is restricted to test environments.");
  }
  inFlightOperationalUnlock = null;
  lastOperationalUnlockAtMs = 0;
}

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

function formatOptionalBaghdadTime(raw: unknown, fallback = "—"): string {
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  return formatBaghdadTime(raw) ?? fallback;
}

/**
 * Exact scaled-integer money parser (2 decimal places = cents/fils, HALF_UP)
 * so monetary totals never suffer IEEE-754 floating-point drift.
 */
export function parseMoneyToCents(raw: unknown): bigint {
  if (raw == null) return 0n;
  const text = String(raw).trim().replace(/,/g, "");
  if (!text) return 0n;
  const match = text.match(/^([+-])?(\d+)(?:\.(\d+))?$/);
  if (!match) return 0n;
  const negative = match[1] === "-";
  const whole = BigInt(match[2] || "0");
  const fracRaw = (match[3] || "").padEnd(3, "0");
  const twoDigits = BigInt(fracRaw.slice(0, 2));
  const thirdDigit = Number(fracRaw[2] || "0");
  const roundedFrac = thirdDigit >= 5 ? twoDigits + 1n : twoDigits;
  const magnitude = whole * 100n + roundedFrac;
  return negative ? -magnitude : magnitude;
}

export function centsToMoneyNumber(cents: bigint): number {
  return Number(cents) / 100;
}

export function sumMoneyValues(values: readonly unknown[]): number {
  let acc = 0n;
  for (const val of values) {
    acc += parseMoneyToCents(val);
  }
  return centsToMoneyNumber(acc);
}

function buildBranchMap(branches: readonly OperationsBranchSummary[]): Map<number, OperationsBranchSummary> {
  const map = new Map<number, OperationsBranchSummary>();
  for (const b of branches) {
    map.set(b.id, b);
  }
  return map;
}

function resolveBranchLabel(
  branchId: unknown,
  explicitName: unknown,
  branchMap: ReadonlyMap<number, OperationsBranchSummary>,
  fallbackMain = "الفرع الرئيسي - المنصور",
): string {
  if (typeof explicitName === "string" && explicitName.trim().length > 0) {
    return explicitName.trim();
  }
  const numericId = typeof branchId === "number" ? branchId : Number(branchId);
  if (Number.isInteger(numericId) && branchMap.has(numericId)) {
    return branchMap.get(numericId)!.name;
  }
  return numericId === 2 ? "فرع الكرادة" : fallbackMain;
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
    return await withOperationalReadUnlock(async () => {
      const [rawList, branches] = await Promise.all([
        listNativeSalesInvoices({
          limit: options?.limit ?? 50,
          offset: options?.offset ?? 0,
        }),
        listNativeBranches().catch((err) => {
          if (isSessionLockedError(err)) throw err;
          return [] as OperationsBranchSummary[];
        }),
      ]);
      if (!Array.isArray(rawList)) return [];
      const branchMap = buildBranchMap(branches);

      return rawList.map((row) => {
        const amountCents = parseMoneyToCents(row.total);
        const paidCents = parseMoneyToCents(row.paidAmount);
        const returnedCents = parseMoneyToCents(row.returnedTotal);
        const amount = centsToMoneyNumber(amountCents);
        const paid = centsToMoneyNumber(paidCents);

        const rawStatus = String(row.status || "").toUpperCase();
        let status: RealInvoice["status"] = "PENDING";
        if (rawStatus === "CANCELLED") {
          status = "CANCELLED";
        } else if (rawStatus === "RETURNED") {
          status = "RETURNED";
        } else if (rawStatus === "SUPERSEDED") {
          status = "SUPERSEDED";
        } else if (paidCents + returnedCents >= amountCents && amountCents > 0n) {
          status = "PAID";
        } else if (paidCents > 0n && paidCents + returnedCents < amountCents) {
          status = "PARTIALLY_PAID";
        } else if (rawStatus === "COMPLETED" || rawStatus === "PAID") {
          status = "PAID";
        }

        const rawRemainingCents = amountCents - paidCents - returnedCents;
        const remainingCents =
          DEAD_INVOICE_STATUS_SET.has(status) || rawRemainingCents <= 0n ? 0n : rawRemainingCents;
        const remainingAmount = centsToMoneyNumber(remainingCents);

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

        const branchName = resolveBranchLabel(row.branchId, row.branchName, branchMap);
        const invoiceDateRaw = (row.invoiceDate ?? row.createdAt) as string | undefined;
        const invoiceDateYmd =
          formatYmdInBaghdad(invoiceDateRaw) ||
          (typeof invoiceDateRaw === "string" ? invoiceDateRaw.slice(0, 10) : "");

        const invoiceLabel = String(row.invoiceNumber || row.id);
        return {
          id: String(row.id),
          invoiceNumber: invoiceLabel,
          customerName: typeof row.customerName === "string" && row.customerName ? row.customerName : "عميل نقدي",
          customerPhone: typeof row.customerPhone === "string" && row.customerPhone ? row.customerPhone : undefined,
          salespersonName: typeof row.salespersonName === "string" && row.salespersonName ? row.salespersonName : undefined,
          branchName,
          amount,
          paidAmount: paid,
          remainingAmount,
          paymentMethod,
          status,
          createdAt: formatOptionalBaghdadTime(invoiceDateRaw),
          invoiceDateYmd,
          itemCount: Number(row.itemCount ?? 1),
          items: [
            {
              name: `فاتورة مبيعات رقم ${invoiceLabel}`,
              qty: 1,
              unitPrice: amount,
              total: amount,
            },
          ],
        };
      });
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
    return await withOperationalReadUnlock(async () => {
      const raw = await getNativeSalesInvoice(invoiceId);
      if (!raw) return null;
      const rawItems = Array.isArray(raw.items) ? (raw.items as Record<string, unknown>[]) : [];
      const items = rawItems.map((it) => ({
        name:
          (typeof it.productName === "string" && it.productName) ||
          (typeof it.variantName === "string" && it.variantName) ||
          `صنف #${String(it.productId ?? "")}`,
        qty: Number(it.quantity ?? it.baseQuantity ?? 1),
        unitPrice: centsToMoneyNumber(parseMoneyToCents(it.unitPrice)),
        total: centsToMoneyNumber(parseMoneyToCents(it.total)),
        unitName: typeof it.unitName === "string" && it.unitName ? it.unitName : undefined,
      }));
      const rawPayments = Array.isArray(raw.payments) ? (raw.payments as Record<string, unknown>[]) : [];
      const payments = rawPayments.map((p) => ({
        amount: centsToMoneyNumber(parseMoneyToCents(p.amount)),
        paymentMethod: typeof p.paymentMethod === "string" && p.paymentMethod ? p.paymentMethod : "CASH",
        createdAt: formatOptionalBaghdadTime(p.createdAt),
      }));
      return {
        id: String(raw.id),
        invoiceNumber: String(raw.invoiceNumber || raw.id),
        items,
        payments,
      };
    });
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

function rowUnitStock(row: Record<string, unknown>): number {
  const factorNum = Number(row.conversionFactor);
  const factor = factorNum > 0 ? factorNum : 1;
  const base = Number(row.availableBase ?? row.stockBase ?? 0);
  return Math.floor(base / factor);
}

function mapCatalogRowToInventoryItem(
  row: Record<string, unknown>,
  branchMansourQty: number,
  branchKarradaQty: number,
): RealInventoryItem {
  const reorder = Number(row.reorderPoint ?? row.minStock ?? 5);
  const totalAvailable = branchMansourQty + branchKarradaQty;
  let status: RealInventoryItem["status"] = "IN_STOCK";
  if (totalAvailable <= 0) status = "OUT_OF_STOCK";
  else if (totalAvailable <= reorder) status = "LOW_STOCK";

  return {
    id: String(row.productId),
    name: typeof row.productName === "string" && row.productName ? row.productName : "صنف بدون اسم",
    barcode: typeof row.barcode === "string" && row.barcode ? row.barcode : "لا يوجد باركود",
    category: typeof row.categoryName === "string" && row.categoryName ? row.categoryName : "عام",
    branchMansourQty,
    branchKarradaQty,
    reorderLevel: reorder,
    unitPrice: centsToMoneyNumber(parseMoneyToCents(row.price)),
    unit: typeof row.unitName === "string" && row.unitName ? row.unitName : "قطعة",
    status,
  };
}

export async function fetchRealInventory(options?: {
  query?: string;
  limit?: number;
}): Promise<RealInventoryItem[]> {
  try {
    return await withOperationalReadUnlock(async () => {
      const limit = options?.limit ?? 60;
      const q = options?.query?.trim() || undefined;
      const [actor, branches] = await Promise.all([
        getNativeOperationsActor(),
        listNativeBranches().catch((err) => {
          if (isSessionLockedError(err)) throw err;
          return [] as OperationsBranchSummary[];
        }),
      ]);

      if (!actor) return [];

      const mainBranch = branches.find((b) => b.type === "MAIN") ?? branches.find((b) => b.id === 1);
      const salesBranch =
        branches.find((b) => b.type === "SALES" && b.id !== (mainBranch?.id ?? 1)) ??
        branches.find((b) => b.id === 2);
      const mainBranchId = mainBranch?.id ?? 1;
      const salesBranchId = salesBranch?.id ?? 2;

      // Matches server/routers/catalogRouter.ts `scopeBranch`: ONLY `role === "admin"`
      // crosses branches on `catalog.adminList`; non-admin actors are clamped to
      // `ctx.user.branchId`, so querying two branchIds for non-admins would return
      // the same branch twice and 2× double stock!
      if (actor.role === "admin") {
        const [mansourRes, karradaRes] = await Promise.all([
          listNativeAdminCatalog({ branchId: mainBranchId, limit, q }),
          salesBranchId !== mainBranchId
            ? listNativeAdminCatalog({ branchId: salesBranchId, limit, q }).catch((err) => {
                if (isSessionLockedError(err)) throw err;
                return null;
              })
            : Promise.resolve(null),
        ]);

        if (!Array.isArray(mansourRes?.rows)) return [];

        const karradaStockMap = new Map<number, number>();
        if (Array.isArray(karradaRes?.rows)) {
          for (const r of karradaRes.rows) {
            karradaStockMap.set(Number(r.productId), rowUnitStock(r));
          }
        }

        return mansourRes.rows.map((row) => {
          const mansourQty = rowUnitStock(row);
          const karradaQty = karradaStockMap.get(Number(row.productId)) ?? 0;
          return mapCatalogRowToInventoryItem(row, mansourQty, karradaQty);
        });
      }

      if (actor.branchId == null || actor.branchId <= 0) {
        return [];
      }

      const scopedRes = await listNativeAdminCatalog({
        branchId: actor.branchId,
        limit,
        q,
      });
      if (!Array.isArray(scopedRes?.rows)) return [];

      const isKarradaScoped = actor.branchId === salesBranchId && salesBranchId !== mainBranchId;
      return scopedRes.rows.map((row) => {
        const stock = rowUnitStock(row);
        return isKarradaScoped
          ? mapCatalogRowToInventoryItem(row, 0, stock)
          : mapCatalogRowToInventoryItem(row, stock, 0);
      });
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
    return await withOperationalReadUnlock(async () => {
      const rawList = await listNativeCustomers();
      if (!Array.isArray(rawList)) return [];

      return rawList.map((row) => ({
        id: String(row.id),
        name: typeof row.name === "string" && row.name ? row.name : "عميل غير مسمى",
        phone:
          (typeof row.phone === "string" && row.phone) ||
          (typeof row.whatsapp === "string" && row.whatsapp) ||
          "لا يوجد هاتف",
        type: typeof row.customerType === "string" && row.customerType ? row.customerType : "فرد",
        balance: centsToMoneyNumber(parseMoneyToCents(row.currentBalance)),
        priceTier: row.defaultPriceTier === "WHOLESALE" ? "جملة" : "مفرد",
        city: typeof row.city === "string" && row.city ? row.city : undefined,
        district: typeof row.district === "string" && row.district ? row.district : undefined,
        invoiceCount: 0,
      }));
    });
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
    return await withOperationalReadUnlock(async () => {
      const inbox = await getNativeDecisionsInbox(40).catch((err) => {
        if (isSessionLockedError(err)) throw err;
        return null;
      });
      if (inbox?.rows && Array.isArray(inbox.rows) && inbox.rows.length > 0) {
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

          const summaryItems = Array.isArray(row.summaryItems)
            ? (row.summaryItems as Record<string, unknown>[])
            : null;
          const notes =
            (typeof row.reason === "string" && row.reason) ||
            (summaryItems
              ? summaryItems.map((s) => `${String(s.label ?? "")}: ${String(s.value ?? "")}`).join(" · ")
              : "بانتظار المراجعة والاعتماد");

          return {
            id: `${String(row.kind)}-${String(row.id)}`,
            numericId: Number(row.id),
            kind: String(row.kind),
            type,
            title: typeof row.title === "string" && row.title ? row.title : "طلب اعتماد معلق",
            amount: row.amount != null ? centsToMoneyNumber(parseMoneyToCents(row.amount)) : undefined,
            requesterName:
              typeof row.requestedByName === "string" && row.requestedByName
                ? row.requestedByName
                : "مستخدم النظام",
            branchName:
              typeof row.branchName === "string" && row.branchName ? row.branchName : "الفرع الرئيسي",
            notes,
            createdAt: formatOptionalBaghdadTime(row.requestedAt),
            status: "PENDING",
            expectedVersion: typeof row.expectedVersion === "number" ? row.expectedVersion : null,
            allowedActions: Array.isArray(row.allowedActions)
              ? (row.allowedActions as ("APPROVE" | "REJECT" | "WITHDRAW")[])
              : undefined,
          };
        });
      }

      const rawList = await getNativeSuperAppApprovalInbox({ limit: 40, offset: 0 });
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
          id: `${kind}-${String(row.id)}`,
          numericId: Number(row.id),
          kind,
          type,
          title: typeof row.title === "string" && row.title ? row.title : "طلب اعتماد معلق",
          amount: row.amount != null ? centsToMoneyNumber(parseMoneyToCents(row.amount)) : undefined,
          requesterName:
            typeof row.requesterName === "string" && row.requesterName ? row.requesterName : "مستخدم النظام",
          branchName:
            typeof row.branchName === "string" && row.branchName ? row.branchName : "الفرع الرئيسي",
          notes:
            (typeof row.detail === "string" && row.detail) ||
            (typeof row.notes === "string" && row.notes) ||
            "بانتظار المراجعة والاعتماد",
          createdAt: formatOptionalBaghdadTime(row.createdAt ?? new Date().toISOString()),
          status: "PENDING",
          expectedVersion: null,
        };
      });
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
  return submitWebPreviewDecisionOnly(input);
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
  return withOperationalReadUnlock(async () => {
    const [dashboard, branches] = await Promise.all([
      getNativeTreasuryDashboard(),
      listNativeBranches().catch((err) => {
        if (isSessionLockedError(err)) throw err;
        return [] as OperationsBranchSummary[];
      }),
    ]);
    const branchMap = buildBranchMap(branches);

    const rawTreasuries = Array.isArray(dashboard?.treasuryBalances)
      ? (dashboard.treasuryBalances as Record<string, unknown>[])
      : [];
    const rawDrawers = Array.isArray(dashboard?.drawerBalances)
      ? (dashboard.drawerBalances as Record<string, unknown>[])
      : [];

    let treasuryBalanceCents = 0n;
    for (const b of rawTreasuries) {
      treasuryBalanceCents += parseMoneyToCents(b.balance);
    }
    let drawerBalanceCents = 0n;
    for (const d of rawDrawers) {
      drawerBalanceCents += parseMoneyToCents(d.expectedCash);
    }

    const todayReceiptsCents = parseMoneyToCents(dashboard?.todayReceiptsTotal);
    const todayExpensesCents = parseMoneyToCents(dashboard?.todayExpensesTotal);

    const branchTreasuries = rawTreasuries.map((b) => ({
      branchId: Number(b.branchId || 1),
      branchName: resolveBranchLabel(b.branchId, b.branchName, branchMap),
      balance: centsToMoneyNumber(parseMoneyToCents(b.balance)),
    }));

    const activeDrawers = rawDrawers.map((d) => ({
      shiftId: Number(d.shiftId || 1),
      cashierName: typeof d.cashierName === "string" && d.cashierName ? d.cashierName : "كاشير مناوب",
      branchName: resolveBranchLabel(d.branchId, d.branchName, branchMap, "الفرع الرئيسي"),
      expectedCash: centsToMoneyNumber(parseMoneyToCents(d.expectedCash)),
    }));

    let recentMovements: RealTreasuryOverview["recentMovements"] = [];
    try {
      const rows = await getNativeTreasuryRecentMovements(10);
      recentMovements = rows.map((m, idx) => ({
        id: String(m.id ?? `mov-${idx + 1}`),
        type: m.type === "EXPENSE" ? "EXPENSE" : "RECEIPT",
        amount: centsToMoneyNumber(parseMoneyToCents(m.amount)),
        description:
          (typeof m.description === "string" && m.description) ||
          (typeof m.categoryName === "string" && m.categoryName) ||
          (m.type === "EXPENSE" ? "صرف مصاريف تشغيلية" : "مقبوضات مبيعات"),
        branchName: resolveBranchLabel(m.branchId, m.branchName, branchMap, "الفرع الرئيسي"),
        createdAt: formatOptionalBaghdadTime(m.createdAt ?? new Date().toISOString(), "اليوم"),
      }));
    } catch (err) {
      if (isSessionLockedError(err)) throw err;
      recentMovements = [];
    }

    return {
      treasuryBalance: centsToMoneyNumber(treasuryBalanceCents),
      drawerBalance: centsToMoneyNumber(drawerBalanceCents),
      totalLiquidCash: centsToMoneyNumber(treasuryBalanceCents + drawerBalanceCents),
      todayReceipts: centsToMoneyNumber(todayReceiptsCents),
      todayExpenses: centsToMoneyNumber(todayExpensesCents),
      netTodayCashFlow: centsToMoneyNumber(todayReceiptsCents - todayExpensesCents),
      openShiftsCount:
        typeof dashboard?.openShiftsCount === "number" ? dashboard.openShiftsCount : activeDrawers.length,
      branchTreasuries,
      activeDrawers,
      recentMovements,
    };
  });
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
    return await withOperationalReadUnlock(async () => {
      const rawList = await listNativeSuppliers();
      if (!Array.isArray(rawList)) return [];

      return rawList.map((row) => ({
        id: String(row.id),
        name: typeof row.name === "string" && row.name ? row.name : "مورد غير مسمى",
        phone:
          (typeof row.phone === "string" && row.phone) ||
          (typeof row.mobile === "string" && row.mobile) ||
          "لا يوجد هاتف",
        currentBalance: centsToMoneyNumber(parseMoneyToCents(row.currentBalance)),
        contactPerson:
          typeof row.contactPerson === "string" && row.contactPerson ? row.contactPerson : undefined,
        address: typeof row.address === "string" && row.address ? row.address : undefined,
      }));
    });
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
  status: "DRAFT" | "SENT" | "CONFIRMED" | "RECEIVED" | "CANCELLED";
  orderDate: string;
};

export async function fetchRealPurchases(): Promise<RealPurchaseOrder[]> {
  try {
    return await withOperationalReadUnlock(async () => {
      const rows = await listNativePurchases(40);
      return rows.map((row) => {
        const rawStatus = String(row.status || row.poStatus || "CONFIRMED").toUpperCase();
        const status: RealPurchaseOrder["status"] =
          rawStatus === "DRAFT" ||
          rawStatus === "SENT" ||
          rawStatus === "RECEIVED" ||
          rawStatus === "CANCELLED"
            ? rawStatus
            : "CONFIRMED";
        return {
          id: String(row.id),
          poNumber: typeof row.poNumber === "string" && row.poNumber ? row.poNumber : `PO-${String(row.id)}`,
          supplierName:
            typeof row.supplierName === "string" && row.supplierName ? row.supplierName : "مورد معتمد",
          total: centsToMoneyNumber(parseMoneyToCents(row.total)),
          paidAmount: centsToMoneyNumber(parseMoneyToCents(row.paidAmount)),
          currency:
            (typeof row.agreedCurrency === "string" && row.agreedCurrency) ||
            (typeof row.poCurrency === "string" && row.poCurrency) ||
            "IQD",
          status,
          orderDate: formatOptionalBaghdadTime(row.orderDate ?? row.createdAt),
        };
      });
    });
  } catch (error) {
    console.error("fetchRealPurchases failed:", error);
    return [];
  }
}
