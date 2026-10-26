// اختبارات لفّ نص أسماء الأصناف في الراسم الحراري المُعلَّم (الجزء النقي — بلا Canvas حقيقي)
import { afterEach, describe, expect, it, vi } from "vitest";
import { receiptToCanvas, wrapLines } from "./receiptRaster";
import { buildBrandedReceipt } from "@/components/pos/posShared";

/** قياس زائف: عرض كل محرف = 10px ⇒ maxW=100 يستوعب 10 محارف */
const ctx = { measureText: (s: string) => ({ width: s.length * 10 }) };

describe("wrapLines — لفّ أسماء الأصناف", () => {
  it("نص قصير يبقى سطراً واحداً كما هو", () => {
    expect(wrapLines(ctx, "قلم أزرق", 200)).toEqual(["قلم أزرق"]);
  });

  it("نص أطول من العرض يلتفّ على سطرين دون فقدان كلمات", () => {
    const lines = wrapLines(ctx, "دفتر مدرسي ٩٦ ورقة", 100);
    expect(lines.length).toBe(2);
    expect(lines.join(" ")).toBe("دفتر مدرسي ٩٦ ورقة");
    for (const l of lines) expect(ctx.measureText(l).width).toBeLessThanOrEqual(100);
  });

  it("الفائض عن سطرين يُقصّ ويُختم آخر سطر بـ«…»", () => {
    const lines = wrapLines(ctx, "اسم منتج طويل جداً يتجاوز السطرين المسموحين في عمود الصنف", 100);
    expect(lines.length).toBe(2);
    expect(lines[1].endsWith("…")).toBe(true);
    for (const l of lines) expect(ctx.measureText(l).width).toBeLessThanOrEqual(100);
  });

  it("كلمة واحدة أعرض من العمود تُقصّ بـ«…» ضمن العرض", () => {
    const lines = wrapLines(ctx, "كلمةواحدةطويلةجداًبلامسافات", 100);
    expect(lines.length).toBe(1);
    expect(lines[0].endsWith("…")).toBe(true);
    expect(ctx.measureText(lines[0]).width).toBeLessThanOrEqual(100);
  });

  it("نص فارغ يعيد سطراً فارغاً واحداً (لا ينهار)", () => {
    expect(wrapLines(ctx, "", 100)).toEqual([""]);
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("compact 80mm receipt", () => {
  function canvasFixture() {
    const text: Array<{ value: string; y: number; font: string }> = [];
    const images: Array<{ width: number; height: number; smooth: boolean }> = [];
    const context = {
      save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(),
      drawImage: vi.fn((_image: unknown, _x: number, _y: number, width: number, height: number) => images.push({ width, height, smooth: context.imageSmoothingEnabled })),
      fillText: vi.fn((value: string, _x: number, y: number) => text.push({ value, y, font: context.font })),
      setLineDash: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      arcTo: vi.fn(), closePath: vi.fn(), measureText: (s: string) => ({ width: s.length * 10 }),
      font: "", imageSmoothingEnabled: true,
    };
    const canvas = { width: 0, height: 0, getContext: () => context };
    vi.stubGlobal("document", { fonts: { load: () => Promise.resolve([]) }, createElement: () => canvas });
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    });
    return { canvas, context, text, images };
  }
  const sale = { receiptNumber: "12345", date: "23/10/2026", time: "10:00", cashierName: "كاشير",
    items: [{ name: "دفتر", quantity: 1, price: "1000", total: "1000" }], subtotal: "1000", total: "1000", paid: "1000", paymentMethod: "نقدي" };

  it.each(["النسخة الأصلية", "نسخة معاد طباعتها — بالقيم الحالية", "نسخة معاد طباعتها — بالقيم الحالية ومعلومات السداد والمرتجع المسجلة وقت الطباعة"])("renders and measures copy label %s above the thermal receipt items", async (copyLabel) => {
    canvasFixture();
    const plain = await receiptToCanvas(sale);
    const fixture = canvasFixture();
    const labeled = await receiptToCanvas({ ...sale, copyLabel });
    const header = fixture.text.filter((entry) => entry.y < fixture.text.find((entry) => entry.value === "المنتج")!.y);
    expect(header.map((entry) => entry.value).join(" ")).toContain(copyLabel);
    expect(labeled!.height).toBeGreaterThan(plain!.height);
    expect(Math.max(...fixture.text.map((entry) => entry.y))).toBeLessThan(labeled!.height);
  });

  it.each([
    { kind: "COD", received: 0, credit: 0, isCredit: false, delivery: true },
    { kind: "CREDIT", received: 4000, credit: 6000, isCredit: true, delivery: false },
    { kind: "CASH", received: 10000, credit: 0, isCredit: false, delivery: false },
  ])("preserves $kind semantics from the real POS receipt builder through silent rendering", async ({ kind, received, credit, isCredit, delivery }) => {
    const fixture = canvasFixture();
    const receipt = buildBrandedReceipt({ invoiceNumber: "POS-MODE", invoiceId: 1, date: "24/10/2026", lines: [{ name: "دفتر", unit: "قطعة", qty: 1, price: 10000, total: 10000 }], total: 10000,
      received, change: 0, credit, isCredit, method: "نقدي", delivery: delivery ? { partyName: "مندوب", fee: "2000", feeCollection: "COURIER" } : null });
    await receiptToCanvas(receipt);
    const content = fixture.text.map((entry) => entry.value).join(" ");
    if (kind === "COD") {
      expect(receipt.paymentMode).toBe("COD"); expect(content).toContain("المطلوب عند الاستلام (COD)"); expect(content).not.toContain("آجل"); expect(content).toContain("12,000 د.ع");
    } else if (kind === "CREDIT") {
      expect(content).toContain("متبقٍّ (آجل)"); expect(content).toContain("6,000 د.ع"); expect(content).not.toContain("COD");
    } else {
      expect(content).not.toContain("آجل"); expect(content).not.toContain("COD");
    }
  });

  it("prints a sharp physical QR around32mm while shortening the one-item receipt", async () => {
    const fixture = canvasFixture();
    const result = await receiptToCanvas(sale);
    expect(result!.height).toBeLessThanOrEqual(1120);
    expect(fixture.images.some((image) => image.width >= 250 && image.width === image.height && !image.smooth)).toBe(true);
    expect(fixture.text.find((entry) => entry.value === "دفتر")!.font).toContain("22px");
    const { RECEIPT_PHONES } = await import("./brand");
    for (const contact of RECEIPT_PHONES) {
      expect(fixture.text.map((entry) => entry.value)).toContain(contact.n);
      expect(fixture.text.map((entry) => entry.value)).toContain(contact.l);
    }
  });
  it("marks reprinted invoice copies on the silent thermal raster", async () => {
    const fixture = canvasFixture();
    await receiptToCanvas({
      ...sale,
      copyLabel: "نسخة معاد طباعتها — بالقيم الحالية",
    });
    expect(fixture.text.map((entry) => entry.value).join(" ")).toContain(
      "نسخة معاد طباعتها — بالقيم الحالية",
    );
  });
  it("retains an issued coupon code and every redemption condition in silent printing", async () => {
    const fixture = canvasFixture();
    await receiptToCanvas({ ...sale, bounceBackCoupon: { code: "NEXT-AUDIT01", headline: "هدية الزيارة القادمة", discountText: "5%", minSpendText: "الحد الأدنى10000", validToText: "حتى31/10/2026" } });
    const content = fixture.text.map((entry) => entry.value).join(" ");
    for (const value of ["NEXT-AUDIT01", "5%", "الحد الأدنى10000", "حتى31/10/2026"]) expect(content).toContain(value);
  });
  it("collects only the current merchandise debt plus courier fee after a partial return", async () => {
    const fixture = canvasFixture();
    await receiptToCanvas({ ...sale, total: "100000", subtotal: "100000", paid: "10000", credit: "50000", returnedTotal: "40000", currentTotal: "60000", remainingAmount: "50000",
      delivery: { partyName: "مندوب", fee: "5000", feeCollection: "COURIER" } });
    const content = fixture.text.map((entry) => entry.value).join(" ");
    expect(content).toContain("55,000 د.ع"); expect(content).not.toContain("95,000");
    expect(content).toContain("المرتجع:"); expect(content).toContain("40,000"); expect(content).toContain("60,000");
  });
  it.each(["CANCELLED", "RETURNED", "SUPERSEDED"])("keeps historical fees without collecting or claiming prepayment on %s", async (status) => {
    const fixture = canvasFixture();
    await receiptToCanvas({ ...sale, total: "100000", subtotal: "100000", paid: "10000", credit: "90000", status,
      delivery: { partyName: "مندوب", fee: "5000", feeCollection: "COURIER" } });
    const content = fixture.text.map((entry) => entry.value).join(" ");
    expect(content).toContain("5,000"); expect(content).toContain("الحالة:");
    expect(content).not.toContain("يدفع الزبون"); expect(content).not.toContain("المطلوب من الزبون"); expect(content).not.toContain("مدفوع بالكامل"); expect(content).not.toContain("مدفوعة مسبقاً"); expect(content).not.toContain("متبقٍّ (آجل):");
  });
  it("prints all product-name words and grows the actual canvas for long items", async () => {
    const fixture = canvasFixture();
    const name = Array.from({ length: 60 }, (_, index) => `صنف${index}`).join(" ");
    const result = await receiptToCanvas({ ...sale, items: Array.from({ length: 6 }, () => ({ ...sale.items[0], name })) });
    const content = fixture.text.map((entry) => entry.value).join(" ");
    for (let index = 0; index < 60; index++) expect(content).toContain(`صنف${index}`);
    expect(result!.height).toBeLessThan(fixture.canvas.height);
    expect(Math.max(...fixture.text.map((entry) => entry.y))).toBeLessThan(result!.height);
  });
});

describe("receiptToCanvas — سعة الإيصال", () => {
  it("لا يقصّ تذييل إيصال قصير يجمع الوردية والعربون والآجل والتوصيل", async () => {
    const context = {
      save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(), fillText: vi.fn(),
      setLineDash: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      arcTo: vi.fn(), closePath: vi.fn(),
      measureText: (s: string) => ({ width: s.length * 10 }),
      fillStyle: "", strokeStyle: "", lineWidth: 1, textAlign: "start", font: "",
      textBaseline: "alphabetic", direction: "rtl",
    };
    const canvas = { width: 0, height: 0, getContext: () => context };
    vi.stubGlobal("document", {
      fonts: { load: () => Promise.resolve([]) },
      createElement: () => canvas,
    });
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    });

    const drawn = await receiptToCanvas({
      receiptNumber: "INV-CLIP-1", date: "2026-08-11", time: "18:30",
      cashierName: "موظف الخدمة", customerName: "عميل الاختبار", shiftId: 12,
      items: [{ name: "دفتر", quantity: 1, price: "1000", total: "1000" }],
      subtotal: "1000", total: "1000", paymentMethod: "نقدي", paid: "250", change: "0",
      heldDeposits: "500", credit: "750",
      delivery: {
        partyName: "مندوب الاختبار", fee: "250", feeCollection: "COURIER",
        address: "بغداد — عنوان اختبار كامل",
      },
    });

    expect(drawn).not.toBeNull();
    expect(drawn!.height).toBeLessThan(canvas.height);
  });

  it("فاتورة مدفوعة مسبقاً بالكامل مع توصيل تطلب فقط أجرة التوصيل وتفصح عن السداد المسبق", async () => {
    const fillTextCalls: string[] = [];
    const context = {
      save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(),
      fillText: vi.fn((text: string) => fillTextCalls.push(String(text))),
      setLineDash: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      arcTo: vi.fn(), closePath: vi.fn(),
      measureText: (s: string) => ({ width: s.length * 10 }),
      fillStyle: "", strokeStyle: "", lineWidth: 1, textAlign: "start", font: "",
      textBaseline: "alphabetic", direction: "rtl",
    };
    const canvas = { width: 0, height: 0, getContext: () => context };
    vi.stubGlobal("document", {
      fonts: { load: () => Promise.resolve([]) },
      createElement: () => canvas,
    });
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    });

    await receiptToCanvas({
      receiptNumber: "INV-PAID-DLV", date: "2026-09-24", time: "12:00",
      cashierName: "كاشير", customerName: "زبون نقدي", shiftId: 1,
      items: [{ name: "بضاعة مدفوعة", quantity: 1, price: "50000", total: "50000" }],
      subtotal: "50000", total: "50000", paymentMethod: "نقدي", paid: "50000", change: "0",
      delivery: {
        partyName: "شركة البراق", fee: "5000", feeCollection: "COURIER",
        address: "البصرة",
      },
    });

    // لا يجوز مطلقاً أن يظهر إجمالي 55,000 د.ع على الزبون
    expect(fillTextCalls.some((t) => t.includes("55,000"))).toBe(false);
    // يجب أن يظهر فقط أجرة التوصيل 5,000 د.ع مع إفصاح السداد المسبق
    expect(fillTextCalls.some((t) => t.includes("يدفع الزبون (أجرة التوصيل فقط):"))).toBe(true);
    expect(fillTextCalls.some((t) => t.includes("5,000 د.ع"))).toBe(true);
    expect(fillTextCalls.some((t) => t.includes("البضاعة مدفوعة مسبقاً بالكامل"))).toBe(true);
  });

  it("يطبع اسم المنشأة والشهرة وعنوانها ديناميكياً ويتجاوز قسم الهواتف عند تفريغها", async () => {
    const { setDynamicCompanyProfile, RECEIPT_PHONES } = await import("./brand");
    const defaultContacts = [...RECEIPT_PHONES];
    expect(defaultContacts.length).toBeGreaterThan(0);
    setDynamicCompanyProfile({
      name: "شركة سومر للحلول الطباعية",
      short: "سومر برنت",
      subtitle: "مطبعة رقمية حديثة",
      address: "المنصور — تقاطع الرواد",
      phones: [],
    });

    const fillTextCalls: string[] = [];
    const context = {
      save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(),
      fillText: vi.fn((text: string) => fillTextCalls.push(String(text))),
      setLineDash: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      arcTo: vi.fn(), closePath: vi.fn(),
      measureText: (s: string) => ({ width: s.length * 10 }),
      fillStyle: "", strokeStyle: "", lineWidth: 1, textAlign: "start", font: "",
      textBaseline: "alphabetic", direction: "rtl",
    };
    const canvas = { width: 0, height: 0, getContext: () => context };
    vi.stubGlobal("document", {
      fonts: { load: () => Promise.resolve([]) },
      createElement: () => canvas,
    });
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    });

    await receiptToCanvas({
      receiptNumber: "INV-SOMER-1", date: "2026-10-08", time: "10:00",
      cashierName: "كاشير سومر", customerName: "زبون نقدي", shiftId: 2,
      items: [{ name: "مطبوعات ملونة", quantity: 5, price: "1000", total: "5000" }],
      subtotal: "5000", total: "5000", paymentMethod: "نقدي", paid: "5000", change: "0",
    });

    // يجب أن تظهر أسماء المنشأة الديناميكية في استدعاءات fillText
    expect(fillTextCalls).toContain("سومر برنت");
    expect(fillTextCalls).toContain("مطبعة رقمية حديثة");
    expect(fillTextCalls).toContain("شركة سومر للحلول الطباعية");
    expect(fillTextCalls).toContain("المنصور — تقاطع الرواد");

    // لا تتسرّب بيانات الهواتف الافتراضية بعد تفريغها من هوية المنشأة.
    for (const contact of defaultContacts) {
      expect(fillTextCalls).not.toContain(contact.n);
      expect(fillTextCalls).not.toContain(contact.l);
    }

    setDynamicCompanyProfile(null);
  });

  it("يرسم شعاري Visa و Mastercard بجانب طريقة الدفع عند الدفع بالبطاقة", async () => {
    const loadedSrcs: string[] = [];
    const fillTextCalls: string[] = [];
    const context = {
      save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(),
      fillText: vi.fn((text: string) => fillTextCalls.push(String(text))),
      setLineDash: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      arcTo: vi.fn(), closePath: vi.fn(),
      measureText: (s: string) => ({ width: s.length * 10 }),
      fillStyle: "", strokeStyle: "", lineWidth: 1, textAlign: "start", font: "",
      textBaseline: "alphabetic", direction: "rtl",
    };
    const canvas = { width: 0, height: 0, getContext: () => context };
    vi.stubGlobal("document", {
      fonts: { load: () => Promise.resolve([]) },
      createElement: () => canvas,
    });
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null;
      set src(value: string) {
        loadedSrcs.push(value);
        queueMicrotask(() => this.onload?.());
      }
    });

    await receiptToCanvas({
      receiptNumber: "INV-CARD-RASTER-1", date: "2026-10-22", time: "12:00",
      cashierName: "كاشير", customerName: "عميل بطاقة", shiftId: 1,
      items: [{ name: "منتج", quantity: 1, price: "25000", total: "25000" }],
      subtotal: "25000", total: "25000", paymentMethod: "بطاقة", paid: "25000", change: "0",
    });

    expect(loadedSrcs).toContain("/visa-mastercard.png");
    expect(fillTextCalls).toContain("طريقة الدفع:");
    expect(fillTextCalls).toContain("بطاقة");
  });
});

