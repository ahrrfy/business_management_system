import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { derivePaymentTerms } from "@/components/invoice/paymentTerms";
import { isPendingCodCorrection, correctionOutstandingBlockReason } from "@/components/invoice/SalesCorrectionPanel";
import {
  INVOICE_STATUS_AR,
  INVOICE_STATUSES,
  invoiceStatusLabel,
  isDeadInvoiceStatus,
} from "@shared/invoiceStatus";

const readPage = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const readInvoiceModule = (name: string) =>
  readFileSync(new URL(`../../components/invoice/${name}`, import.meta.url), "utf8");

describe("تصحيح COD ومسار المراجعة المستقلة", () => {
  it("يبقي المبلغ للتحصيل بالتوصيل بلا فرض حساب عميل عند وجود مرجع إرسالية COD", () => {
    const pendingCod = isPendingCodCorrection({ paymentMode: "COD", consignmentId: 44 });
    expect(pendingCod).toBe(true);
    expect(correctionOutstandingBlockReason("2000", false, pendingCod)).toBeNull();
    expect(correctionOutstandingBlockReason("2000", false, false)).toContain("اختر عميلاً");
    expect(correctionOutstandingBlockReason("0", false, false)).toBeNull();
    expect(correctionOutstandingBlockReason("2000", true, false)).toBeNull();
  });

  it("لا يعفي COD بلا مرجع إرسالية ولا الفاتورة الآجلة من حساب العميل", () => {
    expect(isPendingCodCorrection({ paymentMode: "COD", consignmentId: null })).toBe(false);
    expect(isPendingCodCorrection({ paymentMode: "CREDIT", consignmentId: 44 })).toBe(false);
  });

  it("يرسل استثناء التصحيح للمراجعة دون جمع بيانات مدير أو تمرير علم مالي داخل الحمولة", () => {
    const page = readPage("SalesInvoiceNew.tsx");
    const approve = page.slice(page.indexOf("function handleApprove"), page.indexOf("function closeApprovalPrompt"));
    expect(approve).toContain("if (isCorrection)");
    expect(approve).toContain("handleSubmit(undefined, true)");
    expect(approve.indexOf("handleSubmit(undefined, true)")).toBeLessThan(approve.indexOf("mgrEmail.trim()"));
    expect(page).toContain("!isCorrection && <div");
    expect(page).toContain("إرسال إلى مراجع مستقل");
    expect(page).toContain("reissue.mutate({ ...correction, requestReview })");
    const exchange = page.slice(page.indexOf("exchange.mutate({"), page.indexOf("} else {", page.indexOf("exchange.mutate({")));
    expect(exchange).toContain("requestReview,");
    expect(exchange).toMatch(/requestReview,[\s\S]*payload,/);
    expect(page).toContain("correctionOutstandingBlockReason(diff.minus(collect).toFixed(2), state.entityId != null, pendingCodCorrection)");
    const panel = readInvoiceModule("SalesCorrectionPanel.tsx");
    expect(panel).toContain("يبقى المبلغ مطلوباً عند التسليم عبر التوصيل؛ لا يُسجّل ذمّة على زبون عابر.");
  });
});

/**
 * العقد الحاكم لمحرّر الفواتير حين يُحمَّل من فاتورةٍ قائمة (نسخٌ أو تصحيح):
 *
 *   **شروط الدفع تُشتقّ من الأصل، ولا تُترَك على الافتراضيّ أبداً.**
 *
 * السبب ماليّ لا تجميليّ: `createInitialState` يبدأ بـ`paymentTerms:"CASH"`، و«نقدي» مع حقل
 * «المدفوع» الفارغ تعني في `computePaidStr()` سداداً كاملاً ⇒ الحمولة تحمل
 * `payment.amount = الإجمالي` فيفتح الخادم إيصالاً بـ`cashBucket:"DRAWER"` لمالٍ لم يُقبض:
 * ذمّةُ العميل تتبخّر و`expectedCash` ينتفخ فيظهر الدرج عاجزاً عند Z-report.
 *
 * وهذه الاختبارات نصّية عمداً (مرآة `posPaymentFailClosed.test.ts`): تحرس **الوصلة** التي
 * انكسرت فعلاً — بذرة النسخ كانت تحمل العميل والفئة والأسطر وتُسقط شروط الدفع وحدها.
 */
describe("عقد شروط الدفع في محرّر الفواتير", () => {
  it("الاشتقاق لا يفترض سداداً إلا على أصلٍ مسدَّدٍ بالكامل", () => {
    expect(derivePaymentTerms({ total: "250", paidAmount: "0" })).toBe("CREDIT");
    expect(derivePaymentTerms({ total: "250", paidAmount: "100" })).toBe("CREDIT");
    expect(derivePaymentTerms({ total: "250", paidAmount: "250" })).toBe("CASH");
  });

  it("الافتراضيّ في المُصغِّر يبقى «نقدي» — ولذلك يجب اشتقاقه صراحةً عند التحميل", () => {
    // إن تغيّر هذا الافتراضيّ يوماً فالاختبارات أدناه تبقى صحيحة، لكن هذا هو سبب وجودها.
    expect(readInvoiceModule("reducer.ts")).toMatch(/paymentTerms:\s*"CASH"/);
  });

  it("«نسخ لفاتورة جديدة» يزرع شروط الدفع المشتقّة من الأصل", () => {
    const page = readPage("Invoices.tsx");
    expect(page).toMatch(/paymentTerms:\s*derivePaymentTerms\(d\)/);
    expect(page).toMatch(/import\s*\{[^}]*derivePaymentTerms[^}]*\}\s*from\s*"@\/components\/invoice"/);
  });

  it("محرّر البيع يقرأ شروط الدفع من البذرة ويطبّقها", () => {
    const page = readPage("SalesInvoiceNew.tsx");
    expect(page).toMatch(/seed\.paymentTerms/);
    expect(page).toMatch(/field:\s*"paymentTerms",\s*value:\s*seed\.paymentTerms/);
  });

  it("هيدرة التصحيح تشتقّ شروط الدفع من الفاتورة الأصلية", () => {
    const page = readPage("SalesInvoiceNew.tsx");
    expect(page).toMatch(/field:\s*"paymentTerms",\s*value:\s*derivePaymentTerms\(d\)/);
  });

  it("شاشة التصحيح تُخفي لوحة الدفع — «المُحصَّل الآن» هو المسار الوحيد للمال", () => {
    // `buildCorrectionPayload` يتجاهل `base.payment`؛ إبقاء الحقل ظاهراً يجعل الموظّف
    // يكتب المقبوض في خانةٍ مُهمَلة فلا يُسجَّل إيصالٌ ولا يُخصَم من الذمّة.
    const page = readPage("SalesInvoiceNew.tsx");
    expect(page).toMatch(/showPayment=\{!isCorrection\}/);
  });

  it("منتقي طريقة القبض في التصحيح يشتقّ من السياسة المركزية لا من نصّ ثابت", () => {
    // لوحة التصحيح استُخرجت إلى SalesCorrectionPanel لحفظ سقف أسطر الصفحة
    const page = readPage("SalesInvoiceNew.tsx");
    expect(page).toMatch(/<SalesCorrectionPanel/);
    const panel = readInvoiceModule("SalesCorrectionPanel.tsx");
    expect(panel).toMatch(/PAYMENT_METHODS\.filter\(\s*\(m\) => isPosPaymentMethodEnabled\(m\.value\),?\s*\)/);
  });

  it("يرفض قيمة التحصيل الجزئية العابرة (مثل '.') في تصحيح الفاتورة وتحويل عرض السعر قبل تحويلها لصفر", () => {
    const page = readPage("SalesInvoiceNew.tsx");
    const validateCorr = page.slice(
      page.indexOf("function validateCorrection()"),
      page.indexOf("function validate()"),
    );
    expect(validateCorr).toContain(
      "isCompleteNonNegativeMoneyInput(collectNow, { allowEmpty: true })",
    );
    expect(
      validateCorr.indexOf("isCompleteNonNegativeMoneyInput(collectNow, { allowEmpty: true })"),
    ).toBeLessThan(validateCorr.indexOf("moneyInput(collectNow)"));

    const buildCorr = page.slice(
      page.indexOf("function buildCorrectionPayload"),
      page.indexOf("function validateCorrection()"),
    );
    expect(buildCorr).toContain(
      "isCompleteNonNegativeMoneyInput(collectNow, { allowEmpty: true })",
    );

    const quotationDetail = readPage("QuotationDetail.tsx");
    const convertIdx = quotationDetail.indexOf("convert.mutate({");
    const beforeConvert = quotationDetail.slice(Math.max(0, convertIdx - 1600), convertIdx);
    expect(beforeConvert).toContain(
      "isCompleteNonNegativeMoneyInput(payAmount, { allowEmpty: true })",
    );
  });
});

/**
 * «معلّقة» كانت تُقرأ «موقوفة/بانتظار إجراء» على بيعٍ آجلٍ نافذ، وتُعرَض بشارة المستند الميت
 * نفسها (`badge-status-cancelled` = رمادي «ملغاة/مستبدلة»). الحالة مشتقّة من المال وحده.
 */
describe("عقد عرض حالة الفاتورة غير المدفوعة", () => {
  it("PENDING تُسمّى «غير مدفوعة» في المصدر المشترك", () => {
    expect(INVOICE_STATUS_AR.PENDING).toBe("غير مدفوعة");
    expect(invoiceStatusLabel("PENDING")).toBe("غير مدفوعة");
  });

  it("PENDING لا تتشارك شارة المستند الميت مع الملغاة/المستبدلة", () => {
    const page = readPage("Invoices.tsx");
    expect(page).toMatch(/PENDING:\s*"badge-status-pending"/);
    expect(page).not.toMatch(/PENDING:\s*"badge-status-cancelled"/);
    // الشارة عرضٌ لا تعريب — ولذلك تبقى محلّيةً؛ لكن الحالة الميتة يجب أن تظلّ مصنَّفةً كذلك.
    expect(isDeadInvoiceStatus("PENDING")).toBe(false);
    expect(isDeadInvoiceStatus("SUPERSEDED")).toBe(true);
  });

  it("المصدر المشترك يغطّي كل حالة يمكن أن تصل الشاشة — لا رمز إنجليزيّ خام", () => {
    for (const code of INVOICE_STATUSES) {
      expect(INVOICE_STATUS_AR[code]).toBeTruthy();
      expect(invoiceStatusLabel(code)).not.toBe(code);
    }
  });

  /**
   * الحارس الحقيقيّ: تعريب الحالة **مصدرُه واحد**. كانت ٦ نسخٍ محلّية تُسقط `SUPERSEDED`
   * (أُضيفت للـenum في هجرة 0168) فتتسرّب رمزاً إنجليزياً خاماً إلى الشاشات والتصدير والطباعة.
   * إعادةُ تعريف القاموس داخل شاشةٍ تُعيد الانجراف حتماً ⇒ تُمنَع نصّياً هنا.
   */
  it("لا شاشة تُعيد تعريف قاموس حالة الفاتورة محلّياً", () => {
    for (const page of ["Invoices.tsx", "InvoiceDetail.tsx", "SalesReport.tsx", "Returns.tsx", "CustomerStatement.tsx"]) {
      const src = readPage(page);
      // «PAID: "…"» داخل الشاشة = قاموس تعريبٍ محلّيّ. خرائط الأصناف اللونية تُستثنى
      // (قيمتها صنف tailwind/توكن: badge-… أو bg-…) لأن نطاقها العرض لا التعريب.
      const localised = src.match(/\bPAID:\s*"(?!badge-|bg-)[^"]+"/g) ?? [];
      expect(localised, `${page} يحمل قاموس تعريبٍ محلّياً`).toEqual([]);
    }
  });
});
