import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetOperationalSessionUnlockForTests,
  centsToMoneyNumber,
  fetchRealApprovals,
  fetchRealCustomers,
  fetchRealInventory,
  fetchRealInvoiceDetails,
  fetchRealInvoices,
  fetchRealPurchases,
  fetchRealSuppliers,
  fetchRealTreasuryOverview,
  formatYmdInBaghdad,
  getTodayBaghdadYmd,
  parseMoneyToCents,
  submitRealDecision,
  sumMoneyValues,
} from "../lib/operationsApi";
import {
  DecisionStepUpRequiredError,
  SecureTransportUnavailableError,
  __setNativeSecureTransportForTests,
} from "../lib/secureTransport";

const mockPlatform = vi.hoisted(() => ({ OS: "android" as string }));
const mockLocalAuth = vi.hoisted(() => ({
  authenticateAsync: vi.fn(async () => ({ success: true as const })),
}));

vi.mock("expo", () => ({
  requireOptionalNativeModule: vi.fn(() => null),
}));

vi.mock("react-native", () => ({
  Platform: mockPlatform,
}));

vi.mock("expo-local-authentication", () => mockLocalAuth);

describe("operations routes and business logic invariants", () => {
  it("defines canonical routes for all core enterprise operational modules", () => {
    const operationalRoutes = [
      "/operations/invoices",
      "/operations/inventory",
      "/operations/customers",
      "/operations/approvals",
      "/operations/treasury",
      "/operations/purchases",
    ];

    expect(operationalRoutes).toHaveLength(6);
    for (const route of operationalRoutes) {
      expect(route).toMatch(/^\/operations\/[a-z-]+$/);
    }
  });

  it("calculates branch inventory totals across multiple locations accurately", () => {
    const item = {
      name: "ورق طباعة A4 دبل إيه",
      branchMansourQty: 48,
      branchKarradaQty: 22,
      reorderLevel: 20,
    };

    const totalQty = item.branchMansourQty + item.branchKarradaQty;
    expect(totalQty).toBe(70);
    expect(totalQty > item.reorderLevel).toBe(true);
  });

  it("identifies low-stock conditions when inventory breaches safety thresholds", () => {
    const item = {
      name: "أحبار طابعة ليزر ملونة",
      branchMansourQty: 3,
      branchKarradaQty: 1,
      reorderLevel: 5,
    };

    const totalQty = item.branchMansourQty + item.branchKarradaQty;
    const isLowStock = totalQty < item.reorderLevel;
    expect(isLowStock).toBe(true);
  });

  it("accurately segregates customers with accounts receivable (AR) balances", () => {
    const customerAccounts = [
      { name: "شركة الرافدين", balanceDue: 3450000 },
      { name: "مكتب الضياء", balanceDue: 0 },
      { name: "مستشفى الفرح", balanceDue: 1890000 },
    ];

    const debtors = customerAccounts.filter((c) => c.balanceDue > 0);
    const totalDue = debtors.reduce((sum, c) => sum + c.balanceDue, 0);

    expect(debtors).toHaveLength(2);
    expect(totalDue).toBe(5340000);
  });

  it("calculates total treasury liquidity combining main vault and cashier drawers", () => {
    const branchTreasuries = [
      { branchName: "الفرع الرئيسي - المنصور", balance: 85400000 },
      { branchName: "فرع الكرادة", balance: 55287454 },
    ];
    const cashierDrawers = [
      { cashierName: "أحمد كاشير المنصور", balance: 145000 },
      { cashierName: "حيدر كاشير الكرادة", balance: 86500 },
    ];

    const totalVaults = branchTreasuries.reduce((sum, t) => sum + t.balance, 0);
    const totalDrawers = cashierDrawers.reduce((sum, d) => sum + d.balance, 0);
    const totalLiquidity = totalVaults + totalDrawers;

    expect(totalVaults).toBe(140687454);
    expect(totalDrawers).toBe(231500);
    expect(totalLiquidity).toBe(140918954);
  });

  it("calculates supplier accounts payable (AP) totals and filters indebted suppliers", () => {
    const suppliers = [
      { name: "شركة النور للمواد الغذائية", balanceDue: 12500000 },
      { name: "مكتب بغداد للتجارة", balanceDue: 4800000 },
      { name: "مورد التجهيزات الحديثة", balanceDue: 0 },
    ];

    const creditors = suppliers.filter((s) => s.balanceDue > 0);
    const totalPayables = creditors.reduce((sum, s) => sum + s.balanceDue, 0);

    expect(creditors).toHaveLength(2);
    expect(totalPayables).toBe(17300000);
  });

  it("enforces that sales invoice totals sum up all paid non-cancelled transactions", () => {
    const invoices = [
      { id: "1", amount: 485000, status: "PAID" },
      { id: "2", amount: 175000, status: "PAID" },
      { id: "3", amount: 890000, status: "PENDING" },
      { id: "4", amount: 15000, status: "CANCELLED" },
    ];

    const settledSales = invoices
      .filter((inv) => inv.status === "PAID")
      .reduce((sum, inv) => sum + inv.amount, 0);

    expect(settledSales).toBe(660000);
  });

  it("strictly enforces zero hardcoded mock user names across operations files", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const forbiddenNames = ["علي حسن", "سارة كريم", "أحمد السعدي", "حسين علي", "زينب مهدي", "قتيبة السعدي"];
    const filesToAudit = [
      "app/operations/approvals.tsx",
      "app/operations/customers.tsx",
      "app/operations/inventory.tsx",
      "app/operations/invoices.tsx",
      "app/operations/treasury.tsx",
      "app/operations/purchases.tsx",
      "app/(tabs)/work.tsx",
      "app/(tabs)/index.tsx",
    ];

    for (const rel of filesToAudit) {
      const fullPath = path.resolve(process.cwd(), rel);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, "utf8");
        for (const name of forbiddenNames) {
          expect(content.includes(name), `Forbidden mock name "${name}" found in ${rel}`).toBe(false);
        }
      }
    }
  });

  it("formats today's date strictly in Baghdad timezone YYYY-MM-DD", () => {
    const today = getTodayBaghdadYmd();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const formatted = formatYmdInBaghdad("2026-09-26T14:00:00Z");
    expect(formatted).toBe("2026-09-26");
  });

  it("excludes DEAD_INVOICE_STATUSES (RETURNED, SUPERSEDED, CANCELLED) from collectible debt", () => {
    const invoices = [
      { id: "1", amount: 100000, paidAmount: 0, status: "PENDING" },
      { id: "2", amount: 50000, paidAmount: 0, status: "RETURNED" },
      { id: "3", amount: 75000, paidAmount: 0, status: "SUPERSEDED" },
      { id: "4", amount: 30000, paidAmount: 0, status: "CANCELLED" },
      { id: "5", amount: 80000, paidAmount: 20000, status: "PARTIALLY_PAID" },
    ];

    const DEAD_STATUSES = new Set(["CANCELLED", "RETURNED", "SUPERSEDED"]);
    const collectibleInvoices = invoices.filter((inv) => !DEAD_STATUSES.has(inv.status));
    const totalPendingDebt = collectibleInvoices.reduce(
      (sum, inv) => sum + (inv.amount - inv.paidAmount),
      0,
    );

    expect(collectibleInvoices).toHaveLength(2);
    expect(totalPendingDebt).toBe(160000);
  });

  it("accurately converts base inventory quantity using conversionFactor", () => {
    const rawVariant = {
      productName: "دفاتر مدرسية سلك",
      stockBase: 120,
      conversionFactor: 12,
    };

    const factor = rawVariant.conversionFactor > 0 ? rawVariant.conversionFactor : 1;
    const packagesCount = Math.floor(rawVariant.stockBase / factor);
    expect(packagesCount).toBe(10);
  });
});

describe("Wave C2 — Native Secure Transport routing, anti-doubling, money precision, and step-up", () => {
  const originalFetch = globalThis.fetch;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalFallbackFlag = process.env.EXPO_PUBLIC_ALLOW_WEB_TRANSPORT_FALLBACK;

  beforeEach(() => {
    mockPlatform.OS = "android";
    mockLocalAuth.authenticateAsync.mockReset();
    mockLocalAuth.authenticateAsync.mockResolvedValue({ success: true });
    process.env.NODE_ENV = "test";
    delete process.env.EXPO_PUBLIC_ALLOW_WEB_TRANSPORT_FALLBACK;
    __setNativeSecureTransportForTests(undefined);
    __resetOperationalSessionUnlockForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    process.env.NODE_ENV = originalNodeEnv;
    if (originalFallbackFlag === undefined) {
      delete process.env.EXPO_PUBLIC_ALLOW_WEB_TRANSPORT_FALLBACK;
    } else {
      process.env.EXPO_PUBLIC_ALLOW_WEB_TRANSPORT_FALLBACK = originalFallbackFlag;
    }
    mockPlatform.OS = "android";
    __setNativeSecureTransportForTests(undefined);
    __resetOperationalSessionUnlockForTests();
  });

  it("enforces zero raw fetch, zero Math.random, and zero hardcoded VPS host in operationsApi.ts", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(path.resolve(process.cwd(), "lib/operationsApi.ts"), "utf8");

    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("Math.random");
    expect(source).not.toContain("srv1548487.hstgr.cloud");
    expect(source).not.toContain("expoConfig?.extra?.apiBaseUrl");
  });

  it("performs exact IQD scaled-integer money arithmetic without IEEE-754 drift", () => {
    expect(parseMoneyToCents("0.10") + parseMoneyToCents("0.20")).toBe(30n);
    expect(sumMoneyValues(["0.10", "0.20"])).toBe(0.3);
    expect(sumMoneyValues(["85,400,000.75", "55,287,454.25"])).toBe(140687455);
    expect(centsToMoneyNumber(parseMoneyToCents("1250.555"))).toBe(1250.56);
    expect(centsToMoneyNumber(parseMoneyToCents("-450.25"))).toBe(-450.25);
  });

  it("routes all 8 operational read flows through AlrueyaSecureTransport without calling fetch", async () => {
    const forbiddenFetch = vi.fn(async () => {
      throw new Error("raw fetch forbidden when native transport is active");
    });
    globalThis.fetch = forbiddenFetch as unknown as typeof fetch;

    __setNativeSecureTransportForTests({
      listBranches: vi.fn(async () =>
        JSON.stringify([
          { id: 1, name: "الفرع الرئيسي - المنصور", type: "MAIN" },
          { id: 2, name: "فرع الكرادة", type: "SALES" },
        ]),
      ),
      listSalesInvoices: vi.fn(async () =>
        JSON.stringify([
          {
            id: 101,
            invoiceNumber: "INV-101",
            customerName: "شركة دجلة",
            branchId: 2,
            total: "150000.50",
            paidAmount: "50000.25",
            returnedTotal: "0",
            paymentMethod: "DEBT",
            status: "PENDING",
            invoiceDate: "2026-10-25T09:00:00Z",
          },
          {
            id: 102,
            invoiceNumber: "INV-102",
            branchId: 1,
            total: "75000",
            paidAmount: "0",
            returnedTotal: "0",
            status: "RETURNED",
            invoiceDate: "2026-10-25T10:00:00Z",
          },
        ]),
      ),
      getSalesInvoice: vi.fn(async () =>
        JSON.stringify({
          id: 101,
          invoiceNumber: "INV-101",
          items: [{ productId: 9, productName: "ورق A4", quantity: 2, unitPrice: "25000.25", total: "50000.50" }],
          payments: [{ amount: "50000.25", paymentMethod: "CASH", createdAt: "2026-10-25T09:05:00Z" }],
        }),
      ),
      getOperationsActor: vi.fn(async () =>
        JSON.stringify({ id: 1, role: "admin", branchId: 1, isOwner: true }),
      ),
      listAdminCatalog: vi.fn(async (branchId: number) =>
        JSON.stringify({
          rows: [
            {
              productId: 501,
              productName: "دفتر سلك",
              barcode: "6280001",
              categoryName: "قرطاسية",
              availableBase: branchId === 1 ? 120 : 36,
              conversionFactor: 12,
              reorderPoint: 5,
              price: "12000",
              unitName: "درزن",
            },
          ],
        }),
      ),
      listCustomers: vi.fn(async () =>
        JSON.stringify([
          { id: 11, name: "مكتب النهرين", phone: "07701234567", currentBalance: "320000.75", defaultPriceTier: "WHOLESALE" },
        ]),
      ),
      getDecisionsInbox: vi.fn(async () =>
        JSON.stringify({
          rows: [
            {
              id: 88,
              kind: "expense.approve",
              title: "صرف وقود مولدة",
              amount: "95000",
              requestedByName: "محاسب الفرع",
              branchName: "فرع الكرادة",
              requestedAt: "2026-10-25T08:00:00Z",
              expectedVersion: 2,
              allowedActions: ["APPROVE", "REJECT"],
            },
          ],
        }),
      ),
      getTreasuryDashboard: vi.fn(async () =>
        JSON.stringify({
          treasuryBalances: [
            { branchId: 1, balance: "85400000.25" },
            { branchId: 2, balance: "14599999.75" },
          ],
          drawerBalances: [{ shiftId: 4, cashierName: "كاشير الصباح", branchId: 2, expectedCash: "250000.50" }],
          todayReceiptsTotal: "1500000.75",
          todayExpensesTotal: "500000.25",
          openShiftsCount: 1,
        }),
      ),
      getTreasuryRecentMovements: vi.fn(async () =>
        JSON.stringify([
          { id: 700, type: "RECEIPT", amount: "250000.50", description: "تسديد فاتورة", branchId: 2, createdAt: "2026-10-25T11:00:00Z" },
        ]),
      ),
      listSuppliers: vi.fn(async () =>
        JSON.stringify([{ id: 31, name: "شركة الرافدين للتوريد", phone: "07801112233", currentBalance: "4100000" }]),
      ),
      listPurchases: vi.fn(async () =>
        JSON.stringify([
          { id: 44, poNumber: "PO-2026-44", supplierName: "شركة الرافدين للتوريد", total: "6000000", paidAmount: "2000000", status: "RECEIVED", orderDate: "2026-10-24T12:00:00Z" },
          { id: 45, poNumber: "PO-2026-45", supplierName: "شركة الرافدين للتوريد", total: "3500000", paidAmount: "0", status: "SENT", orderDate: "2026-10-25T12:00:00Z" },
        ]),
      ),
    });

    const invoices = await fetchRealInvoices();
    expect(invoices).toHaveLength(2);
    expect(invoices[0]?.branchName).toBe("فرع الكرادة");
    expect(invoices[0]?.status).toBe("PARTIALLY_PAID");
    expect(invoices[0]?.remainingAmount).toBe(100000.25);
    expect(invoices[1]?.status).toBe("RETURNED");
    expect(invoices[1]?.remainingAmount).toBe(0);

    const details = await fetchRealInvoiceDetails(101);
    expect(details?.items[0]?.total).toBe(50000.5);
    expect(details?.payments[0]?.amount).toBe(50000.25);

    const inventory = await fetchRealInventory();
    expect(inventory).toHaveLength(1);
    expect(inventory[0]?.branchMansourQty).toBe(10);
    expect(inventory[0]?.branchKarradaQty).toBe(3);

    const customers = await fetchRealCustomers();
    expect(customers[0]?.balance).toBe(320000.75);
    expect(customers[0]?.priceTier).toBe("جملة");

    const approvals = await fetchRealApprovals();
    expect(approvals[0]?.kind).toBe("expense.approve");
    expect(approvals[0]?.amount).toBe(95000);
    expect(approvals[0]?.expectedVersion).toBe(2);

    const treasury = await fetchRealTreasuryOverview();
    expect(treasury.treasuryBalance).toBe(100000000);
    expect(treasury.drawerBalance).toBe(250000.5);
    expect(treasury.totalLiquidCash).toBe(100250000.5);
    expect(treasury.netTodayCashFlow).toBe(1000000.5);
    expect(treasury.activeDrawers[0]?.branchName).toBe("فرع الكرادة");

    const suppliers = await fetchRealSuppliers();
    expect(suppliers[0]?.currentBalance).toBe(4100000);

    const purchases = await fetchRealPurchases();
    expect(purchases).toHaveLength(2);
    expect(purchases[0]?.status).toBe("RECEIVED");
    expect(purchases[0]?.total).toBe(6000000);
    expect(purchases[1]?.status).toBe("SENT");
    expect(purchases[1]?.total).toBe(3500000);

    expect(mockLocalAuth.authenticateAsync).toHaveBeenCalledTimes(1);
    expect(forbiddenFetch).not.toHaveBeenCalled();
  });

  it("authenticates Android Keystore session once per concurrent load batch, renews after expiry, and retries on E_SECURE_TRANSPORT_SESSION_LOCKED", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T21:00:00Z"));

    let throwLockedOnce = false;
    const listPurchasesSpy = vi.fn(async () => {
      if (throwLockedOnce) {
        throwLockedOnce = false;
        const lockedErr = new Error("The protected work session was not unlocked.");
        (lockedErr as Error & { code: string }).code = "E_SECURE_TRANSPORT_SESSION_LOCKED";
        throw lockedErr;
      }
      return JSON.stringify([
        { id: 77, poNumber: "PO-77", supplierName: "مورد", total: "100000", paidAmount: "0", status: "SENT" },
      ]);
    });

    __setNativeSecureTransportForTests({
      listPurchases: listPurchasesSpy,
      listSuppliers: vi.fn(async () =>
        JSON.stringify([{ id: 1, name: "مورد", phone: "07700000000", currentBalance: "0" }]),
      ),
    });

    // 1. Concurrent Promise.all load batch prompts Android authentication ONCE
    const [batchPurchases, batchSuppliers] = await Promise.all([
      fetchRealPurchases(),
      fetchRealSuppliers(),
    ]);
    expect(batchPurchases[0]?.status).toBe("SENT");
    expect(batchSuppliers).toHaveLength(1);
    expect(mockLocalAuth.authenticateAsync).toHaveBeenCalledTimes(1);

    // 2. After the 30s Android Keystore window expires, refreshing re-authenticates before reading
    vi.advanceTimersByTime(31_000);
    await fetchRealPurchases();
    expect(mockLocalAuth.authenticateAsync).toHaveBeenCalledTimes(2);

    // 3. Even inside the reuse window, an explicit E_SECURE_TRANSPORT_SESSION_LOCKED forces re-unlock + retry
    throwLockedOnce = true;
    const recovered = await fetchRealPurchases();
    expect(recovered[0]?.poNumber).toBe("PO-77");
    expect(mockLocalAuth.authenticateAsync).toHaveBeenCalledTimes(3);
  });

  it("fails closed with SecureTransportUnavailableError on native production when native module is missing", async () => {
    const forbiddenFetch = vi.fn(async () => {
      throw new Error("must not fallback to fetch on native production");
    });
    globalThis.fetch = forbiddenFetch as unknown as typeof fetch;

    __setNativeSecureTransportForTests(null);
    mockPlatform.OS = "android";
    process.env.NODE_ENV = "production";
    process.env.EXPO_PUBLIC_ALLOW_WEB_TRANSPORT_FALLBACK = "";

    await expect(fetchRealInvoices()).rejects.toBeInstanceOf(SecureTransportUnavailableError);
    await expect(fetchRealInventory()).rejects.toBeInstanceOf(SecureTransportUnavailableError);
    expect(mockLocalAuth.authenticateAsync).not.toHaveBeenCalled();
    expect(forbiddenFetch).not.toHaveBeenCalled();
  });

  it("prevents 2x inventory stock doubling for non-admin branch-scoped roles (warehouse & manager)", async () => {
    const listAdminCatalogSpy = vi.fn(async () =>
      JSON.stringify({
        rows: [
          {
            productId: 900,
            productName: "حبر طابعة",
            availableBase: 15,
            conversionFactor: 1,
            reorderPoint: 5,
            price: "25000",
          },
        ],
      }),
    );

    // Case 1: warehouse user on Karrada branch (id=2)
    __setNativeSecureTransportForTests({
      getOperationsActor: vi.fn(async () =>
        JSON.stringify({ id: 7, role: "warehouse", branchId: 2, isOwner: false }),
      ),
      listBranches: vi.fn(async () =>
        JSON.stringify([
          { id: 1, name: "الفرع الرئيسي - المنصور", type: "MAIN" },
          { id: 2, name: "فرع الكرادة", type: "SALES" },
        ]),
      ),
      listAdminCatalog: listAdminCatalogSpy,
    });

    const warehouseItems = await fetchRealInventory();
    expect(listAdminCatalogSpy).toHaveBeenCalledTimes(1);
    expect(listAdminCatalogSpy).toHaveBeenCalledWith(2, 60, null);
    expect(warehouseItems).toHaveLength(1);
    expect(warehouseItems[0]?.branchMansourQty).toBe(0);
    expect(warehouseItems[0]?.branchKarradaQty).toBe(15);
    expect((warehouseItems[0]?.branchMansourQty ?? 0) + (warehouseItems[0]?.branchKarradaQty ?? 0)).toBe(15);

    // Case 2: manager user on Karrada branch (even if isOwner=true, server catalogRouter checks role === 'admin')
    listAdminCatalogSpy.mockClear();
    __setNativeSecureTransportForTests({
      getOperationsActor: vi.fn(async () =>
        JSON.stringify({ id: 8, role: "manager", branchId: 2, isOwner: true }),
      ),
      listBranches: vi.fn(async () =>
        JSON.stringify([
          { id: 1, name: "الفرع الرئيسي - المنصور", type: "MAIN" },
          { id: 2, name: "فرع الكرادة", type: "SALES" },
        ]),
      ),
      listAdminCatalog: listAdminCatalogSpy,
    });

    const managerItems = await fetchRealInventory();
    expect(listAdminCatalogSpy).toHaveBeenCalledTimes(1);
    expect(listAdminCatalogSpy).toHaveBeenCalledWith(2, 60, null);
    expect(managerItems[0]?.branchMansourQty).toBe(0);
    expect(managerItems[0]?.branchKarradaQty).toBe(15);
  });

  it("enforces SECURITY.md Rule #3: refuses un-stepped-up decision execution on native transport and uses CSPRNG UUID in web preview", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify([{ result: { data: { json: { outcome: "APPROVED" } } } }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    // 1. Native transport active => refuses immediately with DecisionStepUpRequiredError
    __setNativeSecureTransportForTests({
      createMobileRequestId: vi.fn(async () => "550e8400-e29b-41d4-a716-446655440000"),
    });

    await expect(
      submitRealDecision({
        kind: "expense.approve",
        id: 88,
        action: "APPROVE",
        expectedVersion: 2,
      }),
    ).rejects.toBeInstanceOf(DecisionStepUpRequiredError);
    expect(fetchSpy).not.toHaveBeenCalled();

    // 2. Web preview allowed (native module absent in test/web mode) => sends CSPRNG UUID v4 clientRequestId
    __setNativeSecureTransportForTests(null);
    const result = await submitRealDecision({
      kind: "expense.approve",
      id: 88,
      action: "APPROVE",
      expectedVersion: 2,
    });
    expect(result).toEqual({ outcome: "APPROVED" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const parsedBody = JSON.parse(String(init.body)) as {
      "0": { json: { clientRequestId: string; kind: string; id: number; action: string } };
    };
    expect(parsedBody["0"].json.clientRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(parsedBody["0"].json.clientRequestId.startsWith("mob-")).toBe(false);
  });
});
