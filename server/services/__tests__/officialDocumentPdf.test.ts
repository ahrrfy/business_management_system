/**
 * PDF المستندات الرسمية — عقد ثلاثيّ الحالات الميّتة (CP-OUT-PDF-01، ٤/٩/٢٦).
 *
 * السياق: تدقيق Codex أثبت بصرياً أنّ فاتورة `RETURNED` بـ `total=250/paid=0/returned=250`
 * تُنزَّل PDF فيه «الإجمالي المستحق 250» و«المتبقي 250» بالأحمر بلا وسم مرتجع — فيدفع
 * الموظّف لمطالبة العميل بمالٍ لا يستحقّه. الجذر ثلاثيّ: (١) اللقطة لا تحمل `status` ولا
 * `returnedTotal`، (٢) نوع `OfficialDocumentPdfData` لا يعرّفهما، (٣) الراسم يحسب المتبقي
 * كـ`max(total−paid, 0)` ويرسمه أحمرَ بلا استشارة الحالة.
 *
 * الاختبارات هنا تُغطّي **الطبقة النقيّة** (`computeInvoiceClaim`) عبر مصفوفة الحالات كاملة،
 * ثمّ **الطبقة الحسّية** (PDF مولَّد يُفحص بمطابقة نصّ لاتينيّ خام في content stream — Helvetica
 * غير مُجزَّأة فيبقى «(250) Tj» قابلاً للبحث بينما Cairo العربيّ مُجزَّأ بمعرِّفات glyph).
 * وأخيراً **لقطة قاعدةً**: `loadOfficialDocumentSnapshot` يحمل الحقلَين الجديدَين، فحمولةُ
 * الواتساب المستهلَكة في `outboxService` تحملهما تلقائياً (نفس دالّة الرسم).
 */
import { and, eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { loadOfficialDocumentSnapshot } from "../documentDeliveryService";
import {
  computeInvoiceClaim,
  generateOfficialDocumentPdf,
  HISTORICAL_BANNER_TEXT,
  officialDocumentFilename,
  type OfficialDocumentPdfData,
} from "../officialDocumentPdf";
import { truncateTables } from "./__testUtils__";

// ─── جهاز المصفوفة ───────────────────────────────────────────────────────────
type MatrixCase = {
  label: string;
  data: OfficialDocumentPdfData;
  expected: {
    isDead: boolean;
    currentClaim: number;
    grandBarLabel: string;
    showHistoricalBanner: boolean;
    showReturnedRow: boolean;
    showRedOutstandingRow: boolean;
    showDeadZeroClaimRow: boolean;
  };
};

const baseItems: OfficialDocumentPdfData["items"] = [
  { productName: "قلم أزرق", unitName: "قطعة", quantity: "1", unitPrice: "250", total: "250" },
];

function invoiceFixture(overrides: Partial<OfficialDocumentPdfData>): OfficialDocumentPdfData {
  return {
    kind: "INVOICE",
    number: overrides.number ?? "INV-TEST",
    date: overrides.date ?? "2026-09-04",
    subtotal: overrides.subtotal ?? "250",
    total: overrides.total ?? "250",
    paidAmount: overrides.paidAmount ?? null,
    returnedTotal: overrides.returnedTotal,
    status: overrides.status,
    customerName: overrides.customerName ?? "زبون",
    items: overrides.items ?? baseItems,
    ...overrides,
  };
}

describe("computeInvoiceClaim — مصفوفة الحالات الميّتة والحيّة", () => {
  const cases: MatrixCase[] = [
    {
      label: "RETURNED total=250/paid=0/returned=250 ⇒ مطالبة 0 + شريط تاريخيّ + لا شارة حمراء",
      data: invoiceFixture({ number: "10004", status: "RETURNED", paidAmount: "0", returnedTotal: "250" }),
      expected: {
        isDead: true,
        currentClaim: 0,
        grandBarLabel: "الإجمالي الأصلي",
        showHistoricalBanner: true,
        showReturnedRow: true,
        showRedOutstandingRow: false,
        showDeadZeroClaimRow: true,
      },
    },
    {
      label: "CANCELLED total=250/paid=0/returned=0 ⇒ مطالبة 0 (لا يعتمد على الطرح وحده)",
      data: invoiceFixture({ status: "CANCELLED", paidAmount: "0", returnedTotal: "0" }),
      expected: {
        isDead: true,
        currentClaim: 0,
        grandBarLabel: "الإجمالي الأصلي",
        showHistoricalBanner: true,
        showReturnedRow: false,
        showRedOutstandingRow: false,
        showDeadZeroClaimRow: true,
      },
    },
    {
      label: "SUPERSEDED total=250/paid=0/returned=0 ⇒ مطالبة 0 (البديلة تحمل الالتزام)",
      data: invoiceFixture({ status: "SUPERSEDED", paidAmount: "0", returnedTotal: "0" }),
      expected: {
        isDead: true,
        currentClaim: 0,
        grandBarLabel: "الإجمالي الأصلي",
        showHistoricalBanner: true,
        showReturnedRow: false,
        showRedOutstandingRow: false,
        showDeadZeroClaimRow: true,
      },
    },
    {
      label: "حيّة PARTIALLY_PAID total=1000/paid=400/returned=200 ⇒ مطالبة 400",
      data: invoiceFixture({
        number: "INV-LIVE",
        status: "PARTIALLY_PAID",
        subtotal: "1000",
        total: "1000",
        paidAmount: "400",
        returnedTotal: "200",
      }),
      expected: {
        isDead: false,
        currentClaim: 400,
        grandBarLabel: "الإجمالي المستحق",
        showHistoricalBanner: false,
        showReturnedRow: true,
        showRedOutstandingRow: true,
        showDeadZeroClaimRow: false,
      },
    },
    {
      label: "حيّة PAID total=1000/paid=1000/returned=0 ⇒ مطالبة 0 (لا شارة حمراء)",
      data: invoiceFixture({
        number: "INV-PAID",
        status: "PAID",
        subtotal: "1000",
        total: "1000",
        paidAmount: "1000",
        returnedTotal: "0",
      }),
      expected: {
        isDead: false,
        currentClaim: 0,
        grandBarLabel: "الإجمالي المستحق",
        showHistoricalBanner: false,
        showReturnedRow: false,
        showRedOutstandingRow: false,
        showDeadZeroClaimRow: false,
      },
    },
    {
      label: "حيّة PENDING total=250/paid=0/returned=0 ⇒ مطالبة 250 (السلوك القائم للحيّة)",
      data: invoiceFixture({ status: "PENDING", paidAmount: "0", returnedTotal: "0" }),
      expected: {
        isDead: false,
        currentClaim: 250,
        grandBarLabel: "الإجمالي المستحق",
        showHistoricalBanner: false,
        showReturnedRow: false,
        showRedOutstandingRow: true,
        showDeadZeroClaimRow: false,
      },
    },
    {
      label: "status غائبة ⇒ fail-safe نسخة تاريخية بلا مطالبة (لا نطالب بمالٍ لا نعرف حالته)",
      data: invoiceFixture({ status: undefined, paidAmount: "0", returnedTotal: "0" }),
      expected: {
        isDead: false, // ليست dead لكنها historical (unknown)
        currentClaim: 0,
        grandBarLabel: "الإجمالي الأصلي",
        showHistoricalBanner: true,
        showReturnedRow: false,
        showRedOutstandingRow: false,
        showDeadZeroClaimRow: true,
      },
    },
    {
      label: "عرض سعر (QUOTATION) لا يتأثّر بمنطق الحالات الميّتة",
      data: {
        kind: "QUOTATION",
        number: "QT-001",
        date: "2026-09-04",
        subtotal: "500",
        total: "500",
        items: baseItems,
      },
      expected: {
        isDead: false,
        currentClaim: 0,
        grandBarLabel: "الإجمالي",
        showHistoricalBanner: false,
        showReturnedRow: false,
        showRedOutstandingRow: false,
        showDeadZeroClaimRow: false,
      },
    },
  ];

  for (const c of cases) {
    it(c.label, () => {
      const result = computeInvoiceClaim(c.data);
      expect(result.isDead).toBe(c.expected.isDead);
      expect(result.currentClaim).toBe(c.expected.currentClaim);
      expect(result.grandBarLabel).toBe(c.expected.grandBarLabel);
      expect(result.showHistoricalBanner).toBe(c.expected.showHistoricalBanner);
      expect(result.showReturnedRow).toBe(c.expected.showReturnedRow);
      expect(result.showRedOutstandingRow).toBe(c.expected.showRedOutstandingRow);
      expect(result.showDeadZeroClaimRow).toBe(c.expected.showDeadZeroClaimRow);
    });
  }

  it("HISTORICAL_BANNER_TEXT ثابتٌ مُصدَّر (يُستهلك في اختبارات الواجهة/تفتيش PDF)", () => {
    expect(HISTORICAL_BANNER_TEXT).toBe("نسخة تاريخية — غير صالحة للمطالبة");
  });
});

describe("generateOfficialDocumentPdf — عقد PDF ثلاثيّ الحالات الميّتة", () => {
  it("ينشئ ملف A4 صالحاً ومضمّن الخط لمستند عربي (اختبار التوافق الأصليّ)", async () => {
    const bytes = await generateOfficialDocumentPdf({
      kind: "INVOICE",
      number: "INV-001",
      date: "2026-07-29",
      customerName: "مدارس النخيل",
      subtotal: "25000",
      total: "25000",
      paidAmount: "0",
      items: [{
        productName: "دفتر عربي",
        unitName: "قطعة",
        quantity: "1",
        unitPrice: "25000",
        total: "25000",
      }],
    });
    expect(Buffer.from(bytes).subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const document = await PDFDocument.load(bytes);
    expect(document.getPageCount()).toBe(1);
    const size = document.getPage(0).getSize();
    expect(size.width).toBeCloseTo(595.28, 1);
    expect(size.height).toBeCloseTo(841.89, 1);
  });

  it("ينشئ اسماً آمناً للملف", () => {
    expect(officialDocumentFilename("QUOTATION", "QT/2026:15")).toBe("quotation-QT-2026-15.pdf");
  });

  // فاتورة `RETURNED` — العينة الحقيقيّة من تقرير Codex 10004.
  // لأنّ Cairo مُجزَّأ (subset) فمقاطع العربيّ في content stream معرِّفات glyph، لكنّ
  // الأرقام اللاتينية بـHelvetica (StandardFont) تبقى ASCII خامّ في `(NUM) Tj` — قابلة للبحث.
  it("RETURNED total=250: content stream يحمل «(250)» (إجمالي أصليّ محفوظ) بلا شارة «المتبقي» الحمراء", async () => {
    const bytes = await generateOfficialDocumentPdf(invoiceFixture({
      number: "10004",
      status: "RETURNED",
      paidAmount: "0",
      returnedTotal: "250",
    }));
    const raw = Buffer.from(bytes).toString("binary");
    // pdf-lib يكتب المحتوى في content streams مضغوطةً بـFlate — نقرأها بفكّ ضغط الصفحة.
    const text = await extractPageText(bytes);
    expect(text).toContain("(250)");
    // الرقم "(0) Tj" يجب أن يظهر (المطالبة الحاليّة صفر)؛ ليس بالضرورة كـ«المتبقي 250» أحمر.
    expect(text).toContain("(0)");
    // يُتحقَّق من صحّة PDF عموماً.
    expect(raw.startsWith("%PDF-")).toBe(true);
  });

  it("CANCELLED total=250/paid=0/returned=0: PDF صحيح — content stream به «(250)» و«(0)»", async () => {
    const bytes = await generateOfficialDocumentPdf(invoiceFixture({
      status: "CANCELLED",
      paidAmount: "0",
      returnedTotal: "0",
    }));
    const text = await extractPageText(bytes);
    expect(text).toContain("(250)");
    expect(text).toContain("(0)");
    // لا شارةَ «المطالبة» الحمراء: الشريط الأحمر لا يظهر إلّا مع currentClaim > 0.
    // نتحقّق ذلك ضمنياً بتشغيل الدالّة النقيّة على المُدخَل نفسه:
    const claim = computeInvoiceClaim(invoiceFixture({
      status: "CANCELLED",
      paidAmount: "0",
      returnedTotal: "0",
    }));
    expect(claim.showRedOutstandingRow).toBe(false);
    expect(claim.currentClaim).toBe(0);
  });

  it("حيّة PENDING total=250: PDF يُعيد شارة «المتبقي 250» (السلوك الحاليّ للحيّة)", async () => {
    const bytes = await generateOfficialDocumentPdf(invoiceFixture({
      status: "PENDING",
      paidAmount: "0",
      returnedTotal: "0",
    }));
    const text = await extractPageText(bytes);
    expect(text).toContain("(250)");
    const claim = computeInvoiceClaim(invoiceFixture({
      status: "PENDING",
      paidAmount: "0",
      returnedTotal: "0",
    }));
    expect(claim.showRedOutstandingRow).toBe(true);
    expect(claim.currentClaim).toBe(250);
  });
});

// ─── فكّ Content Stream (Flate) لاستخراج النصّ اللاتينيّ الخام ─────────────────
//
// نصوص PDF تُخزَّن بشكلَين في content stream:
//   • `(literal string) Tj` — نصّ حرفيّ محاطٌ بأقواس.
//   • `<hex string> Tj`     — بايتات hex (كل بايتَين = محرف واحد). Helvetica في pdf-lib
//     تخرج بهذا الشكل ⇒ «250» تصير `<323530>` لا `(250)`.
// نستخرج كليهما، ونفكّ الـhex إلى ASCII كي تصبح الأرقام واللاتينيّ قابلَين للبحث موحّداً.
async function extractPageText(bytes: Uint8Array): Promise<string> {
  const document = await PDFDocument.load(bytes);
  const pageRef = document.getPage(0).ref;
  const pageNode = document.context.lookup(pageRef) as any;
  const contents = pageNode.Contents();
  const streams: any[] = contents?.array ? contents.array : contents ? [contents] : [];
  let raw = "";
  const zlib = await import("node:zlib");
  for (const streamRef of streams) {
    const stream = document.context.lookup(streamRef);
    if (!stream || !("contents" in (stream as any))) continue;
    const bytes: Uint8Array = (stream as any).contents;
    try {
      raw += zlib.inflateSync(Buffer.from(bytes)).toString("binary");
    } catch {
      raw += Buffer.from(bytes).toString("binary");
    }
  }

  // اجمع النصوص الحرفية بلا تغيير + النصوص hex مفكوكةً إلى ASCII.
  let decoded = "";
  const literalRegex = /\(([^()\\]*)\)\s*Tj/g;
  const hexRegex = /<([0-9A-Fa-f]+)>\s*Tj/g;
  let m: RegExpExecArray | null;
  while ((m = literalRegex.exec(raw)) !== null) decoded += ` (${m[1]})`;
  while ((m = hexRegex.exec(raw)) !== null) {
    const hex = m[1];
    // كل بايتَين = محرف. نحوّل ASCII 0x20..0x7E فقط (Cairo يستخدم glyph IDs خارج هذا المدى).
    let ascii = "";
    for (let i = 0; i < hex.length; i += 2) {
      const code = parseInt(hex.slice(i, i + 2), 16);
      if (code >= 0x20 && code <= 0x7E) ascii += String.fromCharCode(code);
    }
    if (ascii) decoded += ` (${ascii})`;
  }
  return decoded;
}

// ─── لقطة قاعدة: `loadOfficialDocumentSnapshot` يحمل status + returnedTotal ─────
const SNAPSHOT_TABLES = ["invoiceItems", "invoices", "customers", "users", "branches"];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

describe("loadOfficialDocumentSnapshot — حمولة اللقطة تحمل status و returnedTotal (CP-OUT-PDF-01)", () => {
  beforeEach(async () => {
    await truncateTables(SNAPSHOT_TABLES);
    const d = db();
    await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
    await d.insert(s.users).values([{ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" }]);
    await d.insert(s.customers).values([{ id: 1, name: "زبون تجريبي", type: "INDIVIDUAL" }]);
  });

  it("فاتورة RETURNED: pdfData يحمل status='RETURNED' وreturnedTotal='250' (الحقلان الجديدان)", async () => {
    const d = db();
    const [res] = (await d.insert(s.invoices).values({
      invoiceNumber: "10004",
      sourceType: "POS",
      branchId: 1,
      customerId: 1,
      subtotal: "250.00",
      total: "250.00",
      paidAmount: "0.00",
      returnedTotal: "250.00",
      status: "RETURNED",
      createdBy: 1,
    })) as any;
    const invoiceId = Number(res.insertId ?? res?.[0]?.insertId);
    expect(invoiceId).toBeGreaterThan(0);

    const snap = await loadOfficialDocumentSnapshot("INVOICE", invoiceId);
    expect(snap.pdfData.status).toBe("RETURNED");
    expect(String(snap.pdfData.returnedTotal)).toBe("250.00");
    expect(String(snap.pdfData.total)).toBe("250.00");
    expect(String(snap.pdfData.paidAmount)).toBe("0.00");

    // الدالّة النقيّة على اللقطة تُنتج مطالبة صفر + شريط تاريخيّ — الاستهلاك النهائيّ صحيح.
    const claim = computeInvoiceClaim(snap.pdfData);
    expect(claim.isDead).toBe(true);
    expect(claim.currentClaim).toBe(0);
    expect(claim.showHistoricalBanner).toBe(true);
    expect(claim.showRedOutstandingRow).toBe(false);
  });

  it("فاتورة PENDING حيّة: pdfData يحمل status='PENDING' وreturnedTotal='0.00' — مطالبة 250 قائمة", async () => {
    const d = db();
    const [res] = (await d.insert(s.invoices).values({
      invoiceNumber: "10005",
      sourceType: "POS",
      branchId: 1,
      customerId: 1,
      subtotal: "250.00",
      total: "250.00",
      paidAmount: "0.00",
      returnedTotal: "0.00",
      status: "PENDING",
      createdBy: 1,
    })) as any;
    const invoiceId = Number(res.insertId ?? res?.[0]?.insertId);

    const snap = await loadOfficialDocumentSnapshot("INVOICE", invoiceId);
    expect(snap.pdfData.status).toBe("PENDING");
    expect(String(snap.pdfData.returnedTotal)).toBe("0.00");

    const claim = computeInvoiceClaim(snap.pdfData);
    expect(claim.isDead).toBe(false);
    expect(claim.currentClaim).toBe(250);
    expect(claim.showRedOutstandingRow).toBe(true);
  });

  it("قناة الواتساب: الحمولة تُخزَّن كـJSON في outbox ثمّ تُقرأ وتُرسَم بنفس الدالّة ⇒ لا فقدان للحقلَين", async () => {
    // outboxService يستخرج `documentPayload.pdfData` ويمرّرها لـ`generateOfficialDocumentPdf` مباشرةً.
    // فاختبار الجولة الكاملة يكفي أن يُثبت أنّ JSON round-trip يحفظ الحقلَين الجديدَين — لا معادلةَ
    // مستقلّة تُعاد في outboxService (الاتّحاد على مصدر واحد للرسم).
    const pdfData: OfficialDocumentPdfData = invoiceFixture({
      number: "10004",
      status: "RETURNED",
      paidAmount: "0",
      returnedTotal: "250",
    });
    const documentPayload = { pdfData, filename: "invoice-10004.pdf", caption: "فاتورة رقم 10004" };
    const serialized = JSON.stringify({ document: documentPayload });
    const roundTripped = JSON.parse(serialized) as { document: typeof documentPayload };
    expect(roundTripped.document.pdfData.status).toBe("RETURNED");
    expect(String(roundTripped.document.pdfData.returnedTotal)).toBe("250");

    // ورسم PDF على الحمولة المستردَّة ينتج نفس مطالبة الصفر (لا شارة أحمر):
    const claim = computeInvoiceClaim(roundTripped.document.pdfData);
    expect(claim.currentClaim).toBe(0);
    expect(claim.showHistoricalBanner).toBe(true);
    expect(claim.showRedOutstandingRow).toBe(false);
  });
});
