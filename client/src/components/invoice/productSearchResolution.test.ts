import { describe, expect, it, vi } from "vitest";
import {
  beginPricingSelectionIntent,
  buildProductPricingContext,
  createPricingIntentEpoch,
  createPricingContextRequestGuard,
  createLatestPricingRequestGuard,
  resolveExactBeforeFuzzy,
} from "./productSearchResolution";

describe("product search resolution order", () => {
  it("does not read fuzzy results after an exact match", async () => {
    const fuzzy = vi.fn(() => "fuzzy");
    await expect(resolveExactBeforeFuzzy(async () => "FOUND", fuzzy)).resolves.toEqual({ status: "FOUND" });
    expect(fuzzy).not.toHaveBeenCalled();
  });

  it("uses fuzzy results only after authoritative NOT_FOUND", async () => {
    const fuzzy = vi.fn(() => "fuzzy");
    await expect(resolveExactBeforeFuzzy(async () => "NOT_FOUND", fuzzy)).resolves.toEqual({ status: "NOT_FOUND", fuzzy: "fuzzy" });
    expect(fuzzy).toHaveBeenCalledOnce();
  });

  it("does not bypass blocked ambiguity or inactive collisions", async () => {
    const fuzzy = vi.fn(() => "wrong-owner");
    await expect(resolveExactBeforeFuzzy(async () => "BLOCKED", fuzzy)).resolves.toEqual({ status: "BLOCKED" });
    expect(fuzzy).not.toHaveBeenCalled();
  });

  it("does not fall back to a fuzzy row after the pricing context becomes stale", async () => {
    const fuzzy = vi.fn(() => "old-context-row");
    await expect(resolveExactBeforeFuzzy(async () => "STALE", fuzzy)).resolves.toEqual({ status: "STALE" });
    expect(fuzzy).not.toHaveBeenCalled();
  });
});

describe("pricing context request guard", () => {
  it("يرفض استجابة A المتأخرة بعد بدء B", async () => {
    const guard = createLatestPricingRequestGuard();
    let currentContext = "customer:A";
    const applied: string[] = [];
    let resolveA!: (value: string) => void;
    let resolveB!: (value: string) => void;
    const responseA = new Promise<string>((resolve) => { resolveA = resolve; });
    const responseB = new Promise<string>((resolve) => { resolveB = resolve; });

    const run = async (context: string, response: Promise<string>) => {
      const token = guard.begin(context);
      const value = await response;
      if (guard.isCurrent(token, currentContext)) applied.push(value);
    };

    const a = run(currentContext, responseA);
    currentContext = "customer:B";
    const b = run(currentContext, responseB);
    resolveB("B");
    await b;
    resolveA("A");
    await a;

    expect(applied).toEqual(["B"]);
  });

  it("يبطل طلب B عند رجوع المستخدم إلى A المثبتة قبل وصول B", async () => {
    const guard = createLatestPricingRequestGuard();
    let committedCustomer = "A";
    let resolveB!: (value: string) => void;
    const responseB = new Promise<string>((resolve) => { resolveB = resolve; });

    const selectCustomer = async (nextCustomer: string, response: Promise<string>) => {
      const intent = beginPricingSelectionIntent(
        guard,
        `customer:${nextCustomer}`,
        committedCustomer,
        nextCustomer,
      );
      // هذا هو مسار early-return الحقيقي: حتى الاختيار غير المتغيّر أعلن جيلاً جديداً أعلاه.
      if (!intent.changed) return;

      const resolvedCustomer = await response;
      if (guard.isCurrent(intent.token, intent.token.context)) {
        committedCustomer = resolvedCustomer;
      }
    };

    const pendingB = selectCustomer("B", responseB);
    await selectCustomer("A", Promise.resolve("A"));
    resolveB("B");
    await pendingB;

    expect(committedCustomer).toBe("A");
  });
});

describe("parallel barcode pricing context guard", () => {
  it("يقبل مسحين سريعين في سياق التسعير نفسه ولو وصلت استجابتهما بترتيب معكوس", async () => {
    const guard = createPricingContextRequestGuard("customer:A");
    const added: string[] = [];
    let resolveFirst!: (value: string) => void;
    let resolveSecond!: (value: string) => void;
    const firstResponse = new Promise<string>((resolve) => { resolveFirst = resolve; });
    const secondResponse = new Promise<string>((resolve) => { resolveSecond = resolve; });

    const scan = async (response: Promise<string>) => {
      const token = guard.capture();
      const item = await response;
      if (guard.isCurrent(token, "customer:A")) added.push(item);
    };

    const first = scan(firstResponse);
    const second = scan(secondResponse);
    resolveSecond("second");
    resolveFirst("first");
    await Promise.all([first, second]);

    expect(added).toEqual(["second", "first"]);
  });

  it("يبطل كل المسوح القديمة عند تغيّر سياق العميل أو الفئة", async () => {
    const guard = createPricingContextRequestGuard("customer:A");
    let currentContext = "customer:A";
    const added: string[] = [];
    let resolveOld!: (value: string) => void;
    const oldResponse = new Promise<string>((resolve) => { resolveOld = resolve; });

    const oldToken = guard.capture();
    const oldScan = oldResponse.then((item) => {
      if (guard.isCurrent(oldToken, currentContext)) added.push(item);
    });

    currentContext = "customer:B";
    guard.sync(currentContext);
    const newToken = guard.capture();
    if (guard.isCurrent(newToken, currentContext)) added.push("new-context");
    resolveOld("old-context");
    await oldScan;

    expect(added).toEqual(["new-context"]);
  });

  it("يبطل مسح الشراء عند تغيّر العملة أو سعر التثبيت مع ثبات بقية السياق", () => {
    const context = (purchaseCurrency: string, purchaseAgreedRate: string) => buildProductPricingContext({
      invoiceType: "PURCHASE",
      branchId: 1,
      tier: "RETAIL",
      customerId: 7,
      purchaseCurrency,
      purchaseAgreedRate,
    });
    const initialContext = context("USD", " 1300.000 ");
    expect(initialContext).toBe(context("usd", "1300.000"));

    const guard = createPricingContextRequestGuard(initialContext);
    const beforeRateChange = guard.capture();
    const changedRateContext = context("USD", "1400.000");
    guard.sync(changedRateContext);
    expect(guard.isCurrent(beforeRateChange, changedRateContext)).toBe(false);

    const beforeCurrencyChange = guard.capture();
    const changedCurrencyContext = context("IQD", "1400.000");
    guard.sync(changedCurrencyContext);
    expect(guard.isCurrent(beforeCurrencyChange, changedCurrencyContext)).toBe(false);
  });

  it("يبطل intent جديد نتيجة المسح القديمة فوراً قبل إعادة render لسياق الأسعار", async () => {
    const contextGuard = createPricingContextRequestGuard("customer:A");
    const intentEpoch = createPricingIntentEpoch();
    const contextToken = contextGuard.capture();
    const intentToken = intentEpoch.capture();
    const added: string[] = [];
    let resolveOldScan!: (value: string) => void;
    const oldScanResponse = new Promise<string>((resolve) => { resolveOldScan = resolve; });

    const oldScan = oldScanResponse.then((item) => {
      // لم يحدث render بعد، لذلك ما زال سياق props الظاهر A. الـepoch المشترك وحده يغلق النافذة.
      if (
        contextGuard.isCurrent(contextToken, "customer:A") &&
        intentEpoch.isCurrent(intentToken)
      ) {
        added.push(item);
      }
    });

    intentEpoch.invalidate();
    resolveOldScan("priced-for-A");
    await oldScan;

    expect(contextGuard.isCurrent(contextToken, "customer:A")).toBe(true);
    expect(added).toEqual([]);
  });
});
