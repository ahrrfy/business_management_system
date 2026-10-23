import { D } from "@/lib/money";
import { describe, expect, it } from "vitest";
import {
  computePOSTotals,
  computePosSaleReceiptSnapshot,
  computeSplitLegFingerprint,
  evaluatePosCreditPrompt,
  validatePosSaleBeforeSubmit,
} from "../posTotals";
import type { CartItem, POSTab, PosPaymentLegDraft } from "../posShared";
import { deliverySendsPayment } from "../deliveryMode";
import { deliveryFeeTenderForGoods } from "../feeTenderUi";

function makeItem(price: number, qty = 1): CartItem {
  return {
    row: {
      productId: 1,
      productUnitId: 10,
      productName: "دفتر تجارب",
      price: String(price),
      contractUnitPrice: String(price),
      currency: "IQD",
      unitName: "قطعة",
      barcode: "123456",
      sku: "SKU1",
      stockQty: "100",
      minQty: "0",
      categoryName: "قرطاسية",
    } as any,
    qty,
    disc: 0,
    origPrice: price,
  };
}

function makeTab(overrides: Partial<POSTab> = {}): POSTab {
  return {
    id: 1,
    label: "فاتورة 1",
    cart: [],
    payInput: "",
    method: "CASH",
    selId: null,
    numMode: "PAY",
    customerId: null,
    tierOverride: null,
    clientRequestId: "req-1",
    couponInput: "",
    couponCode: null,
    couponLabel: null,
    paymentRef: "",
    externalPayment: null,
    dueDate: "",
    invoiceDiscountPct: "",
    ...overrides,
  };
}

describe("computePOSTotals — credit and customer payment logic", () => {
  it("treats payInput='0' as full credit when customer is selected", () => {
    const cart = [makeItem(10000, 1)];
    const activeTab = makeTab({
      customerId: 42,
      payInput: "0",
    });

    const res = computePOSTotals({ cart, activeTab });
    expect(res.isCredit).toBe(true);
    expect(res.paid).toBe(0);
    expect(res.credit).toBe(10000);
    expect(res.total).toBe(10000);
  });

  it("does not treat payInput='0' as credit when customer is null (cash customer)", () => {
    const cart = [makeItem(10000, 1)];
    const activeTab = makeTab({
      customerId: null,
      payInput: "0",
    });

    const res = computePOSTotals({ cart, activeTab });
    expect(res.isCredit).toBe(false);
    expect(res.isChange).toBe(false);
  });

  it("calculates partial payment credit correctly when customer is selected", () => {
    const cart = [makeItem(10000, 1)];
    const activeTab = makeTab({
      customerId: 42,
      payInput: "3000",
    });

    const res = computePOSTotals({ cart, activeTab });
    expect(res.isCredit).toBe(true);
    expect(res.paid).toBe(3000);
    expect(res.credit).toBe(7000);
  });

  it("calculates full payment without credit", () => {
    const cart = [makeItem(10000, 1)];
    const activeTab = makeTab({
      customerId: 42,
      payInput: "10000",
    });

    const res = computePOSTotals({ cart, activeTab });
    expect(res.isCredit).toBe(false);
    expect(res.isChange).toBe(true);
    expect(res.paid).toBe(10000);
    expect(res.change).toBe(0);
    expect(res.credit).toBe(0);
  });
});

describe("evaluatePosCreditPrompt — credit limit pre-flight evaluation", () => {
  it("returns null when not a credit sale", () => {
    const res = evaluatePosCreditPrompt({
      selectedCustomer: { creditLimit: "0", currentBalance: "0" },
      isCredit: false,
      creditAmount: 0,
    });
    expect(res).toBeNull();
  });

  it("returns null when customer is null or undefined", () => {
    const res = evaluatePosCreditPrompt({
      selectedCustomer: null,
      isCredit: true,
      creditAmount: 5000,
    });
    expect(res).toBeNull();
  });

  it("returns null when customer has unlimited credit (creditLimit: null)", () => {
    const res = evaluatePosCreditPrompt({
      selectedCustomer: { creditLimit: null, currentBalance: "100000" },
      isCredit: true,
      creditAmount: 500000,
    });
    expect(res).toBeNull();
  });

  it("returns prompt for cash-only customer (creditLimit: 0) without debt", () => {
    const res = evaluatePosCreditPrompt({
      selectedCustomer: { creditLimit: "0", currentBalance: "0" },
      isCredit: true,
      creditAmount: 15000,
    });
    expect(res).toContain("هذا العميل نقديٌّ فقط (حدّ ائتمانه صفر)");
    expect(res).toContain("موافقة مدير");
    expect(res).not.toContain("رصيد سابق");
  });

  it("returns prompt mentioning existing debt for cash-only customer with balance", () => {
    const res = evaluatePosCreditPrompt({
      selectedCustomer: { creditLimit: "0", currentBalance: "25000.00" },
      isCredit: true,
      creditAmount: 10000,
    });
    expect(res).toContain("هذا العميل نقديٌّ فقط (حدّ ائتمانه صفر)");
    expect(res).toContain("رصيد سابق (25000.00)");
    expect(res).toContain("موافقة مدير");
  });

  it("returns null when purchase is within positive credit limit", () => {
    const res = evaluatePosCreditPrompt({
      selectedCustomer: { creditLimit: "100000.00", currentBalance: "40000.00" },
      isCredit: true,
      creditAmount: 50000, // 40000 + 50000 = 90000 <= 100000
    });
    expect(res).toBeNull();
  });

  it("returns prompt when purchase exceeds credit limit", () => {
    const res = evaluatePosCreditPrompt({
      selectedCustomer: { creditLimit: "100000.00", currentBalance: "40000.00" },
      isCredit: true,
      creditAmount: 70000, // 40000 + 70000 = 110000 > 100000
    });
    expect(res).toContain("تجاوز حدّ الائتمان");
    expect(res).toContain("على العميل 40000.00");
    expect(res).toContain("وهذا البيع يضيف 70000.00");
    expect(res).toContain("وسقفه 100000.00");
    expect(res).toContain("المتاح 60000.00");
    expect(res).toContain("موافقة مدير");
  });

  it("handles customer balance already at or above limit", () => {
    const res = evaluatePosCreditPrompt({
      selectedCustomer: { creditLimit: "50000.00", currentBalance: "55000.00" },
      isCredit: true,
      creditAmount: 10000,
    });
    expect(res).toContain("المتاح 0.00");
    expect(res).toContain("موافقة مدير");
  });
});

function makeConfirmedLeg(
  id: string,
  method: PosPaymentLegDraft["method"],
  amount: string,
  paymentRef = "",
  attemptId = 101,
): PosPaymentLegDraft {
  const base: PosPaymentLegDraft = {
    id,
    method,
    amount,
    paymentRef,
    externalPayment: null,
  };
  if (method !== "CASH") {
    base.externalPayment = {
      attemptId,
      requestId: `req-${id}`,
      fingerprint: computeSplitLegFingerprint(base),
      state: "CONFIRMED",
      deviceId: "DEV-1",
    };
  }
  return base;
}

describe("computePOSTotals & helpers — split / mixed payment legs", () => {
  it("computes exact Cash + Card split payment with confirmed external attempt", () => {
    const cart = [makeItem(10000, 1)];
    const activeTab = makeTab({
      paymentLegs: [
        makeConfirmedLeg("leg-1", "CASH", "6000"),
        makeConfirmedLeg("leg-2", "CARD", "4000", "auth-7788", 202),
      ],
    });

    const res = computePOSTotals({ cart, activeTab });
    expect(res.isSplitPayment).toBe(true);
    expect(res.paid).toBe(10000);
    expect(res.total).toBe(10000);
    expect(res.change).toBe(0);
    expect(res.credit).toBe(0);
    expect(res.isChange).toBe(true);
    expect(res.isCredit).toBe(false);
    expect(res.splitInvalidLeg).toBe(false);
    expect(res.splitNonCashOverpay).toBe(false);
    expect(res.externalPaymentConfirmed).toBe(true);
  });

  it("allows cash overpayment in Cash + Card split and caps cash leg in receipt snapshot", () => {
    const cart = [makeItem(10000, 1)];
    const activeTab = makeTab({
      paymentLegs: [
        makeConfirmedLeg("leg-1", "CARD", "4000", "AUTH-1", 301),
        makeConfirmedLeg("leg-2", "CASH", "7500"),
      ],
    });

    const res = computePOSTotals({ cart, activeTab });
    expect(res.isSplitPayment).toBe(true);
    expect(res.paid).toBe(11500);
    expect(res.change).toBe(1500);
    expect(res.isChange).toBe(true);
    expect(res.splitNonCashOverpay).toBe(false);
    expect(res.externalPaymentConfirmed).toBe(true);

    const snap = computePosSaleReceiptSnapshot({
      activeTab,
      effectiveTotalD: res.effectiveTotalD,
      cashRoundedPaidD: res.cashRoundedPaidD,
      paidD: res.paidD,
      isCredit: res.isCredit,
      codMode: res.codMode,
    });
    expect(snap.effectiveMethodCode).toBe("MIXED");
    expect(snap.method).toBe("مختلطة");
    expect(snap.received).toBe(10000);
    expect(snap.change).toBe(1500);
    expect(snap.paymentLegs).toEqual([
      { method: "بطاقة", amount: 4000, reference: "AUTH-1" },
      { method: "نقدي", amount: 6000, reference: null },
    ]);
  });

  it("flags splitNonCashOverpay when non-cash legs exceed invoice total", () => {
    const cart = [makeItem(10000, 1)];
    const activeTab = makeTab({
      paymentLegs: [
        makeConfirmedLeg("leg-1", "CARD", "7000", "AUTH-1", 401),
        makeConfirmedLeg("leg-2", "TRANSFER", "4000", "TRX-2", 402),
      ],
    });

    const res = computePOSTotals({ cart, activeTab });
    expect(res.splitNonCashOverpay).toBe(true);
    expect(res.externalPaymentConfirmed).toBe(false);

    const err = validatePosSaleBeforeSubmit({
      activeTab,
      cart,
      codMode: res.codMode,
      isSplitPayment: res.isSplitPayment,
      splitInvalidLeg: res.splitInvalidLeg,
      splitNonCashOverpay: res.splitNonCashOverpay,
      externalPaymentConfirmed: res.externalPaymentConfirmed,
      isCredit: res.isCredit,
    });
    expect(err).toContain("مجموع الدفعات غير النقدية لا يمكن أن يتجاوز إجمالي الفاتورة");
  });

  it("blocks externalPaymentConfirmed when a non-cash leg is unconfirmed or its amount/reference drifted", () => {
    const cart = [makeItem(10000, 1)];
    const leg2 = makeConfirmedLeg("leg-2", "CARD", "4000", "AUTH-1", 501);
    const driftedLeg2: PosPaymentLegDraft = { ...leg2, amount: "4500" };
    const activeTab = makeTab({
      paymentLegs: [
        makeConfirmedLeg("leg-1", "CASH", "5500"),
        driftedLeg2,
      ],
    });

    const res = computePOSTotals({ cart, activeTab });
    expect(res.externalPaymentConfirmed).toBe(false);
  });

  it("flags splitInvalidLeg when fewer than 2 legs or a leg has zero/empty amount", () => {
    const cart = [makeItem(10000, 1)];
    const singleLegTab = makeTab({
      paymentLegs: [makeConfirmedLeg("leg-1", "CASH", "10000")],
    });
    expect(computePOSTotals({ cart, activeTab: singleLegTab }).splitInvalidLeg).toBe(true);

    const zeroLegTab = makeTab({
      paymentLegs: [
        makeConfirmedLeg("leg-1", "CASH", "10000"),
        makeConfirmedLeg("leg-2", "CARD", "0", "AUTH-1", 601),
      ],
    });
    expect(computePOSTotals({ cart, activeTab: zeroLegTab }).splitInvalidLeg).toBe(true);
  });

  it("supports partial split payment with remaining credit on customer account", () => {
    const cart = [makeItem(10000, 1)];
    const activeTab = makeTab({
      customerId: 42,
      paymentLegs: [
        makeConfirmedLeg("leg-1", "CASH", "3000"),
        makeConfirmedLeg("leg-2", "WALLET", "4000", "ZAIN-99", 701),
      ],
    });

    const res = computePOSTotals({ cart, activeTab });
    expect(res.isSplitPayment).toBe(true);
    expect(res.isCredit).toBe(true);
    expect(res.paid).toBe(7000);
    expect(res.credit).toBe(3000);
    expect(res.externalPaymentConfirmed).toBe(true);
  });

  it("parses thousands separators and Arabic numerals in split payment leg amounts without truncating", () => {
    const cart = [makeItem(40000, 1)];
    const activeTab = makeTab({
      paymentLegs: [
        makeConfirmedLeg("leg-1", "CASH", "25,000"),
        makeConfirmedLeg("leg-2", "CARD", "١٥٬٠٠٠", "AUTH-AR", 801),
      ],
    });

    const res = computePOSTotals({ cart, activeTab });
    expect(res.paid).toBe(40000);
    expect(res.change).toBe(0);
    expect(res.credit).toBe(0);
    expect(res.isCredit).toBe(false);
    expect(res.splitInvalidLeg).toBe(false);
    expect(res.externalPaymentConfirmed).toBe(true);
  });
});




describe("held delivery fee and external payment binding",()=>{
  function delivery(fee="5000"):NonNullable<POSTab["delivery"]>{return {governorate:"baghdad",address:"Baghdad",partyId:1,partyType:"INDIVIDUAL",partyName:"Courier",externalTrackingRef:"",fee,feeManual:true,feeCollection:"COUNTER",recipientName:"Buyer",recipientPhone:"+9647700000000",customerPhone:"07700000000"};}
  it("cash fee-only COD leaves goods unpaid and does not link the fee to a nonexistent goods leg",()=>{
    const tab=makeTab({method:"CASH",payInput:"0",delivery:delivery()});
    const totals=computePOSTotals({cart:[makeItem(50000)],activeTab:tab});
    expect(totals.codMode).toBe(true);expect(totals.paid).toBe(0);expect(totals.credit).toBe(50000);
    expect(totals.deliveryPayload).toMatchObject({feeCollection:"COUNTER",fee:"5000.00"});
    const sendsGoodsPayment=deliverySendsPayment(tab.method,totals.paidD);
    expect(sendsGoodsPayment).toBe(false);
    expect(deliveryFeeTenderForGoods(tab.method,sendsGoodsPayment)).toEqual({method:"CASH"});
    expect(deliveryFeeTenderForGoods(tab.method,sendsGoodsPayment)).not.toHaveProperty("combinedWithPaymentIndex");
  });
  it.each(["CASH","CARD"] as const)("%s goods paid with the held fee retains the actual rail and one combined goods allocation",method=>{
    const tab=makeTab({method,payInput:"50000",paymentRef:method==="CARD"?"FEE-PROOF":"",delivery:delivery()});
    const totals=computePOSTotals({cart:[makeItem(50000)],activeTab:tab});
    expect(totals.total).toBe(50000);expect(totals.paid).toBe(50000);
    expect(deliveryFeeTenderForGoods(method,deliverySendsPayment(method,totals.paidD))).toEqual({method,combinedWithPaymentIndex:0});
    if(method==="CARD")expect(totals.externalPaymentAmount).toBe("55000.00");
  });
  it("confirms 55,000 while goods allocation stays 50,000",()=>{
    const tab=makeTab({method:"CARD",payInput:"50000",paymentRef:"FEE-PROOF",delivery:delivery()});
    const totals=computePOSTotals({cart:[makeItem(50000)],activeTab:tab});
    expect(totals.total).toBe(50000);expect(totals.paid).toBe(50000);expect(totals.externalPaymentAmount).toBe("55000.00");
    tab.externalPayment={attemptId:1,requestId:"one",fingerprint:totals.externalPaymentFingerprint,state:"CONFIRMED",deviceId:"DEVICE"};
    expect(computePOSTotals({cart:[makeItem(50000)],activeTab:tab}).externalPaymentConfirmed).toBe(true);
    tab.delivery!.fee="6000";
    expect(computePOSTotals({cart:[makeItem(50000)],activeTab:tab}).externalPaymentConfirmed).toBe(false);
  });
  it("split tender adds the fee to the first rail proof only",()=>{
    const first=makeConfirmedLeg("one","CARD","30000","REF1");
    first.externalPayment!.fingerprint=computeSplitLegFingerprint(first,D(5000));
    const tab=makeTab({delivery:delivery(),paymentLegs:[first,makeConfirmedLeg("two","CASH","20000")]});
    const totals=computePOSTotals({cart:[makeItem(50000)],activeTab:tab});
    expect(totals.paid).toBe(50000);expect(totals.externalPaymentConfirmed).toBe(true);
    expect(computeSplitLegFingerprint(first,D(5000))).toContain("35000.00");
    tab.delivery!.fee="6000";
    expect(computePOSTotals({cart:[makeItem(50000)],activeTab:tab}).externalPaymentConfirmed).toBe(false);
  });
});
