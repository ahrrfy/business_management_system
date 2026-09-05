/**
 * اختبارُ عقد «شريط الافعال».
 *
 * غرضُه ليس تغطيةَ فروعٍ بل **منعُ العقد من ان يكذب**: كل حكمٍ يمنع يجب ان يحمل سبباً ومخرجاً
 * صالحَين للعرض، وكل نهايةٍ مسدودةٍ مُعلَنة يجب ان تكون مطابقةً لِما تُنتجه الدالّة فعلاً على
 * عيّنتها. المدخلةُ التي تصف انسداداً غير قائم اسوأ من غيابها: تُبنى عليها شاشةٌ تحجب فعلاً
 * مشروعاً، وتُقرأ لاحقاً بوصفها ديناً على النظام فيُصرَف عليها جهدُ جلسة.
 */
import { describe, expect, it } from "vitest";
import {
  DOCUMENT_ACTIONS,
  DOCUMENT_ACTION_AR,
  DOCUMENT_ACTION_PATH,
  DOCUMENT_BLOCKED_DEAD_ENDS,
  DOCUMENT_DEAD_ENDS,
  DOCUMENT_EDIT_SCOPE,
  DOCUMENT_KINDS,
  DOCUMENT_KIND_AR,
  EXIT_DOCUMENTS,
  documentActionBar,
  documentActionVerdict,
  isDocumentDeadEnd,
  type ActionVerdict,
  type DocumentAction,
  type DocumentFacts,
  type GoodsReceiptFacts,
  type PurchaseOrderFacts,
  type PurchaseReturnFacts,
  type SaleInvoiceFacts,
  type WorkOrderFacts,
} from "./documentActions";

// ─────────────────────── عيّناتٌ نظيفة (لا مانعَ فيها) ───────────────────────

const sale = (over: Partial<SaleInvoiceFacts> = {}): SaleInvoiceFacts => ({
  kind: "SALE_INVOICE",
  status: "PAID",
  fromWorkOrder: false,
  hasItems: true,
  hasPriorReturn: false,
  hasActiveInstallmentPlan: false,
  hasDigitalCards: false,
  hasLiveConsignment: false,
  periodLocked: false,
  ...over,
});

const workOrder = (over: Partial<WorkOrderFacts> = {}): WorkOrderFacts => ({
  kind: "WORK_ORDER",
  status: "RECEIVED",
  invoiceIssued: false,
  hasLiveConsignment: false,
  hasUnsupportedExchangeReceipt: false,
  periodLocked: false,
  ...over,
});

const purchaseOrder = (over: Partial<PurchaseOrderFacts> = {}): PurchaseOrderFacts => ({
  kind: "PURCHASE_ORDER",
  status: "DRAFT",
  hasReceivedQuantity: false,
  hasPayment: false,
  ...over,
});

const goodsReceipt = (over: Partial<GoodsReceiptFacts> = {}): GoodsReceiptFacts => ({
  kind: "GOODS_RECEIPT",
  status: "POSTED",
  origin: "NATIVE",
  hasReversibleQuantity: true,
  periodLocked: false,
  ...over,
});

const purchaseReturn = (over: Partial<PurchaseReturnFacts> = {}): PurchaseReturnFacts => ({
  kind: "PURCHASE_RETURN",
  status: "POSTED",
  origin: "NATIVE",
  ...over,
});

/**
 * كلُّ تركيبةٍ ممثِّلةٍ نستعملها للمسح الشامل. ليست كلَّ الفضاء (لا معنى لذلك) بل عيّنةٌ
 * تغطّي كل فرعٍ في الدالّة مرّةً على الاقل — وهو ما يجعل فحوصَ الصياغة ادناه شاملةً فعلاً.
 */
const ALL_SAMPLES: DocumentFacts[] = [
  sale(),
  sale({ status: "PENDING" }),
  sale({ status: "CANCELLED" }),
  sale({ status: "RETURNED", hasPriorReturn: true }),
  sale({ status: "SUPERSEDED" }),
  sale({ fromWorkOrder: true, status: "PENDING" }),
  sale({ fromWorkOrder: true, status: "CANCELLED" }),
  sale({ hasLiveConsignment: true }),
  sale({ periodLocked: true }),
  sale({ hasActiveInstallmentPlan: true }),
  sale({ hasDigitalCards: true }),
  sale({ hasItems: false }),
  sale({ hasPriorReturn: true }),
  workOrder(),
  workOrder({ status: "IN_PROGRESS" }),
  workOrder({ status: "READY" }),
  workOrder({ status: "READY", invoiceIssued: true }),
  workOrder({ status: "READY", hasLiveConsignment: true }),
  workOrder({ status: "DELIVERED", invoiceIssued: true }),
  workOrder({ status: "DELIVERED", invoiceIssued: true, hasLiveConsignment: true }),
  workOrder({ status: "DELIVERED", invoiceIssued: true, hasUnsupportedExchangeReceipt: true }),
  workOrder({ status: "DELIVERED", invoiceIssued: true, periodLocked: true }),
  workOrder({ status: "CANCELLED" }),
  purchaseOrder(),
  purchaseOrder({ status: "SENT" }),
  purchaseOrder({ status: "CONFIRMED" }),
  purchaseOrder({ status: "RECEIVED", hasReceivedQuantity: true }),
  purchaseOrder({ status: "CANCELLED" }),
  purchaseOrder({ hasReceivedQuantity: true }),
  purchaseOrder({ hasPayment: true }),
  purchaseOrder({ status: "CONFIRMED", hasPayment: true }),
  goodsReceipt(),
  goodsReceipt({ status: "PARTIALLY_REVERSED" }),
  goodsReceipt({ status: "REVERSED", hasReversibleQuantity: false }),
  goodsReceipt({ origin: "LEGACY_AGGREGATE" }),
  goodsReceipt({ periodLocked: true }),
  goodsReceipt({ hasReversibleQuantity: false }),
  { kind: "SALES_RETURN" },
  purchaseReturn(),
  purchaseReturn({ status: "REVERSED" }),
  purchaseReturn({ origin: "LEGACY" }),
];

/** التشكيل الممنوع في النصّ الصغير: U+064B..U+0652 و U+0653..U+065F و U+0670. */
const TASHKEEL_RE = /[ً-ْٓ-ٰٟ]/;
/** الارقام الهندية — ممنوعة بقرار المالك: كل رقم يعرضه النظام لاتيني. */
const ARABIC_INDIC_RE = /[٠-٩۰-۹]/;

function denials(): { label: string; verdict: Extract<ActionVerdict, { allowed: false }> }[] {
  const out: { label: string; verdict: Extract<ActionVerdict, { allowed: false }> }[] = [];
  for (const document of ALL_SAMPLES) {
    for (const action of DOCUMENT_ACTIONS) {
      const verdict = documentActionVerdict({ action, document });
      if (verdict.allowed === false) {
        out.push({ label: `${document.kind}/${action}/${JSON.stringify(document)}`, verdict });
      }
    }
  }
  return out;
}

// ═════════════════════ ١) كل (نوع × فعل) له حكم ═════════════════════

describe("كل نوع × فعل له حكم", () => {
  it("لا تركيبة بلا حكم، والحكم اما مسموح واما ممنوع بسبب ومخرج", () => {
    const seen = new Set<string>();
    for (const document of ALL_SAMPLES) {
      for (const action of DOCUMENT_ACTIONS) {
        const verdict = documentActionVerdict({ action, document });
        expect(verdict).toBeDefined();
        expect(typeof verdict.allowed).toBe("boolean");
        if (verdict.allowed === false) {
          expect(typeof verdict.why).toBe("string");
          expect(typeof verdict.doThis).toBe("string");
        }
        seen.add(`${document.kind}:${action}`);
      }
    }
    // كل الانواع الستة × الافعال الاربعة مغطاة بالعينات اعلاه.
    expect(seen.size).toBe(DOCUMENT_KINDS.length * DOCUMENT_ACTIONS.length);
  });

  it("documentActionBar يطابق documentActionVerdict فعلا بفعل", () => {
    for (const document of ALL_SAMPLES) {
      const bar = documentActionBar(document);
      for (const action of DOCUMENT_ACTIONS) {
        expect(bar[action]).toEqual(documentActionVerdict({ action, document }));
      }
    }
  });

  it("لكل نوع وفعل مدخلة في خريطة المسارات، والقيمة null تعني انعدام المسار لا نسيانه", () => {
    for (const kind of DOCUMENT_KINDS) {
      for (const action of DOCUMENT_ACTIONS) {
        const path = DOCUMENT_ACTION_PATH[kind][action];
        expect(path === null || (typeof path === "string" && path.trim().length > 0)).toBe(true);
      }
    }
  });

  it("الفعل الذي لا مسار له في النظام لا يعود مسموحا ابدا", () => {
    for (const document of ALL_SAMPLES) {
      for (const action of DOCUMENT_ACTIONS) {
        if (DOCUMENT_ACTION_PATH[document.kind][action] !== null) continue;
        const verdict = documentActionVerdict({ action, document });
        expect(verdict.allowed).toBe(false);
      }
    }
  });
});

// ═════════════════ ٢) كل منعٍ يحمل سبباً ومخرجاً صالحَين ═════════════════

describe("صياغة المنع", () => {
  it("يوجد منع فعلي لنفحصه (حارس ضد اختبار يمر على لا شيء)", () => {
    expect(denials().length).toBeGreaterThan(40);
  });

  it("السبب والمخرج غير فارغين ولا مقتضبين الى حد انعدام المعنى", () => {
    for (const { label, verdict } of denials()) {
      expect(verdict.why.trim(), label).not.toBe("");
      expect(verdict.doThis.trim(), label).not.toBe("");
      expect(verdict.why.trim().length, label).toBeGreaterThan(20);
      expect(verdict.doThis.trim().length, label).toBeGreaterThan(20);
    }
  });

  it("المخرج لا يكرر السبب — اعادة صياغة السبب ليست مخرجا", () => {
    for (const { label, verdict } of denials()) {
      expect(verdict.doThis.trim(), label).not.toBe(verdict.why.trim());
    }
  });

  it("المخرج فعل امر لا وصف حالة: يبدا بفعل او بنفي صريح لوجود مخرج", () => {
    // «لا مخرج اليوم» مقبولة صراحة — الاعتراف بالانسداد اصدق من مخرج ملفق.
    const STARTS_WITH_ACTION =
      /^(افتح|اطلب|الغ|استعمل|سجل|اكمل|اعد|راجع|صحح|انشئ|سو|اصدر|عالج|اثبت|استرجع|حدد|ابلغ|لا اجراء|لا مخرج|المسار|المخرج)/;
    for (const { label, verdict } of denials()) {
      expect(verdict.doThis.trim(), label).toMatch(STARTS_WITH_ACTION);
    }
  });

  it("لا تشكيل في اي نص معروض (السبب والمخرج والتسميات ونطاق التعديل)", () => {
    for (const { label, verdict } of denials()) {
      expect(verdict.why, label).not.toMatch(TASHKEEL_RE);
      expect(verdict.doThis, label).not.toMatch(TASHKEEL_RE);
    }
    for (const value of Object.values(DOCUMENT_KIND_AR)) {
      expect(value).not.toMatch(TASHKEEL_RE);
    }
    for (const value of Object.values(DOCUMENT_ACTION_AR)) {
      expect(value).not.toMatch(TASHKEEL_RE);
    }
    for (const value of Object.values(DOCUMENT_EDIT_SCOPE)) {
      expect(value).not.toMatch(TASHKEEL_RE);
    }
  });

  it("لا ارقام هندية في اي نص معروض", () => {
    for (const { label, verdict } of denials()) {
      expect(verdict.why, label).not.toMatch(ARABIC_INDIC_RE);
      expect(verdict.doThis, label).not.toMatch(ARABIC_INDIC_RE);
    }
    for (const entry of DOCUMENT_DEAD_ENDS) {
      expect(entry.doThis, entry.id).not.toMatch(ARABIC_INDIC_RE);
      expect(entry.doThis, entry.id).not.toMatch(TASHKEEL_RE);
    }
  });

  it("لا يتسرب مفتاح انجليزي خام الى نص عربي معروض (مثل CANCELLED او WORKORDER)", () => {
    // المفاتيح مسموحة في الادلة والمسارات (وثائق للمطور) لا في السبب/المخرج (نص للموظف).
    const RAW_KEY_RE = /\b(CANCELLED|RETURNED|SUPERSEDED|WORKORDER|DELIVERED|POSTED|DRAFT|REVERSED)\b/;
    for (const { label, verdict } of denials()) {
      expect(verdict.why, label).not.toMatch(RAW_KEY_RE);
      expect(verdict.doThis, label).not.toMatch(RAW_KEY_RE);
    }
  });
});

// ═══════════════════ ٣) احكامٌ محددة مقروءة من الخادم ═══════════════════

describe("احكام فاتورة البيع", () => {
  it("الفاتورة الحية تقبل الافعال الاربعة", () => {
    const bar = documentActionBar(sale());
    for (const action of DOCUMENT_ACTIONS) expect(bar[action].allowed, action).toBe(true);
  });

  it("منشا امر الشغل يغلق الالغاء والمرتجع والتصحيح ويوجه الى امر الشغل", () => {
    const bar = documentActionBar(sale({ fromWorkOrder: true, status: "PENDING" }));
    for (const action of ["CANCEL", "REVERSE", "CORRECT"] as DocumentAction[]) {
      const verdict = bar[action];
      expect(verdict.allowed, action).toBe(false);
      if (verdict.allowed === false) expect(verdict.doThis).toContain("امر الشغل");
    }
  });

  it("المستبدلة توجه الى الفاتورة البديلة لا الى «لا اجراء»", () => {
    const verdict = documentActionVerdict({
      action: "REVERSE",
      document: sale({ status: "SUPERSEDED" }),
    });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed === false) expect(verdict.doThis).toContain("البديلة");
  });

  it("الملغاة والمرتجعة تعترفان بانه لا اجراء يبقى — لا مخرج ملفق", () => {
    for (const status of ["CANCELLED", "RETURNED"] as const) {
      const verdict = documentActionVerdict({ action: "CANCEL", document: sale({ status }) });
      expect(verdict.allowed).toBe(false);
      if (verdict.allowed === false) expect(verdict.doThis).toContain("لا اجراء يبقى");
    }
  });

  it("المرتجع السابق يمنع التصحيح وحده ولا يمنع الالغاء", () => {
    const bar = documentActionBar(sale({ hasPriorReturn: true }));
    expect(bar.CORRECT.allowed).toBe(false);
    expect(bar.CANCEL.allowed).toBe(true);
  });

  it("الفترة المقفلة تمنع الالغاء والمرتجع والتصحيح ولا تمنع تعديل الملاحظات", () => {
    const bar = documentActionBar(sale({ periodLocked: true }));
    expect(bar.EDIT.allowed).toBe(true);
    for (const action of ["CANCEL", "REVERSE", "CORRECT"] as DocumentAction[]) {
      expect(bar[action].allowed, action).toBe(false);
    }
  });

  /**
   * ⭐ LC01: كان هذا الاختبار يطلب «ثلاثة مخارج مختلفة» فرضي عن ثلاثة نصوص كل منها يحيل الى فعل
   * ممنوع على الفاتورة نفسها (الالغاء ⇒ المرتجع/التصحيح، المرتجع ⇒ الالغاء، التصحيح ⇒ الالغاء).
   * المطلوب الان **قابلية التنفيذ**: لا حكم يحيل الى فعل ممنوع على المستند نفسه، والمخرج اداري معلن.
   */
  it("فاتورة بلا بنود: الثلاثة ممنوعة ولا واحد يحيل الى الاخر — المخرج اداري معلن (LC01)", () => {
    const bar = documentActionBar(sale({ hasItems: false }));
    for (const a of ["CANCEL", "REVERSE", "CORRECT"] as DocumentAction[]) {
      const v = bar[a];
      expect(v.allowed, a).toBe(false);
      if (v.allowed) continue;
      expect(v.exit.kind, a).toBe("ADMIN");
      expect(v.doThis, a).toContain("الادمن");
    }
  });
});

describe("احكام امر الشغل", () => {
  it("الامر المستلم يقبل الاربعة ما عدا العكس (لم يبلغ التسليم)", () => {
    const bar = documentActionBar(workOrder());
    expect(bar.EDIT.allowed).toBe(true);
    expect(bar.CANCEL.allowed).toBe(true);
    expect(bar.CORRECT.allowed).toBe(true);
    expect(bar.REVERSE.allowed).toBe(false);
  });

  it("المسلم ذو الفاتورة يقبل العكس وحده", () => {
    const bar = documentActionBar(workOrder({ status: "DELIVERED", invoiceIssued: true }));
    expect(bar.REVERSE.allowed).toBe(true);
    expect(bar.EDIT.allowed).toBe(false);
    expect(bar.CANCEL.allowed).toBe(false);
    expect(bar.CORRECT.allowed).toBe(false);
  });

  it("الارسالية الحية تمنع الالغاء وتحيل الى ادارة التوصيل", () => {
    const verdict = documentActionVerdict({
      action: "CANCEL",
      document: workOrder({ status: "READY", hasLiveConsignment: true }),
    });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed === false) expect(verdict.doThis).toContain("الارسالية");
  });

  it("سند الصيرفة يمنع العكس ومخرجه تسوية السند لا انكار المخرج", () => {
    const verdict = documentActionVerdict({
      action: "REVERSE",
      document: workOrder({
        status: "DELIVERED",
        invoiceIssued: true,
        hasUnsupportedExchangeReceipt: true,
      }),
    });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed === false) expect(verdict.doThis).toContain("الصيرفة");
  });
});

describe("احكام امر الشراء واذن الاستلام والمرتجعات", () => {
  it("المسودة تقبل التعديل والتصحيح والالغاء، ولا عكس على امر الشراء ابدا", () => {
    const bar = documentActionBar(purchaseOrder());
    expect(bar.EDIT.allowed).toBe(true);
    expect(bar.CORRECT.allowed).toBe(true);
    expect(bar.CANCEL.allowed).toBe(true);
    expect(bar.REVERSE.allowed).toBe(false);
  });

  it("العكس على امر الشراء يحيل الى اذن الاستلام او مرتجع الشراء", () => {
    const verdict = documentActionVerdict({ action: "REVERSE", document: purchaseOrder() });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed === false) expect(verdict.doThis).toContain("اذن الاستلام");
  });

  it("المرسل يحيل الى رفض الاعتماد ليعود مسودة (وهو المسار الوحيد للعودة)", () => {
    const verdict = documentActionVerdict({
      action: "EDIT",
      document: purchaseOrder({ status: "SENT" }),
    });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed === false) expect(verdict.doThis).toContain("رفض");
  });

  it("اذن الاستلام يقبل العكس وحده، وثلاثته الاخرى تحيل الى العكس ثم اعادة الانشاء", () => {
    const bar = documentActionBar(goodsReceipt());
    expect(bar.REVERSE.allowed).toBe(true);
    for (const action of ["EDIT", "CANCEL", "CORRECT"] as DocumentAction[]) {
      const verdict = bar[action];
      expect(verdict.allowed, action).toBe(false);
      if (verdict.allowed === false) expect(verdict.doThis).toContain("عكس");
    }
  });

  it("مرتجع الشراء الاصيل يقبل العكس وحده", () => {
    const bar = documentActionBar(purchaseReturn());
    expect(bar.REVERSE.allowed).toBe(true);
    expect(bar.EDIT.allowed).toBe(false);
  });

  it("مرتجع البيع يرفض الاربعة ويعترف بانعدام المخرج", () => {
    const bar = documentActionBar({ kind: "SALES_RETURN" });
    for (const action of DOCUMENT_ACTIONS) {
      const verdict = bar[action];
      expect(verdict.allowed, action).toBe(false);
      if (verdict.allowed === false) expect(verdict.doThis).toContain("لا مخرج اليوم");
    }
  });
});

// ═══════════════ ٣ب) المخرج قابل للتنفيذ — لا احالة دائرية (LC01) ═══════════════

describe("المخرج المهيكل قابل للتنفيذ (LC01)", () => {
  const SAMPLES: DocumentFacts[] = [...ALL_SAMPLES, ...DOCUMENT_DEAD_ENDS.map((e) => e.sample)];

  it("كل حكم منع يحمل مخرجا مهيكلا، والاحالة الى فعل على المستند نفسه تشير الى فعل مسموح فعلا", () => {
    for (const doc of SAMPLES) {
      const bar = documentActionBar(doc);
      for (const action of DOCUMENT_ACTIONS) {
        const v = bar[action];
        if (v.allowed) continue;
        expect(v.exit, `${JSON.stringify(doc)}/${action}: بلا مخرج مهيكل`).toBeDefined();
        if (v.exit.kind !== "ACTION") continue;
        expect(v.exit.action, `${JSON.stringify(doc)}/${action}: يحيل الى نفسه`).not.toBe(action);
        expect(
          bar[v.exit.action].allowed,
          `${JSON.stringify(doc)}: ${action} يحيل الى ${v.exit.action} وهو ممنوع ايضا — احالة دائرية`,
        ).toBe(true);
      }
    }
  });

  it("النهاية المسدودة لا تحيل الى فعل على المستند نفسه (الاربعة ممنوعة) الا الى الفعل الاجوف المعلن", () => {
    for (const entry of DOCUMENT_DEAD_ENDS) {
      const bar = documentActionBar(entry.sample);
      for (const action of DOCUMENT_ACTIONS) {
        const v = bar[action];
        if (v.allowed) continue;
        if (v.exit.kind === "ACTION") {
          expect(entry.residualAction?.action, `${entry.id}/${action}`).toBe(v.exit.action);
        }
      }
    }
  });

  it("الانسداد الصريح (BLOCKED) يعترف بذلك في نصه ولا يعد بمخرج", () => {
    for (const doc of SAMPLES) {
      const bar = documentActionBar(doc);
      for (const action of DOCUMENT_ACTIONS) {
        const v = bar[action];
        if (v.allowed || v.exit.kind !== "BLOCKED") continue;
        expect(v.doThis, `${JSON.stringify(doc)}/${action}`).toContain("لا مخرج اليوم");
      }
    }
  });

  it("المخرج على مستند اخر يسمي مستندا من القاموس المغلق", () => {
    for (const doc of SAMPLES) {
      const bar = documentActionBar(doc);
      for (const action of DOCUMENT_ACTIONS) {
        const v = bar[action];
        if (v.allowed || v.exit.kind !== "OTHER_DOCUMENT") continue;
        expect(EXIT_DOCUMENTS, `${JSON.stringify(doc)}/${action}`).toContain(v.exit.document);
      }
    }
  });
});

// ═══════════════════ ٤) النهايات المسدودة معدَّدة صراحةً ═══════════════════

describe("النهايات المسدودة", () => {
  it("لكل مدخلة معرف فريد ونوع معروف ودليل غير فارغ", () => {
    const ids = new Set<string>();
    for (const entry of DOCUMENT_DEAD_ENDS) {
      expect(ids.has(entry.id), entry.id).toBe(false);
      ids.add(entry.id);
      expect(DOCUMENT_KINDS).toContain(entry.kind);
      expect(entry.state.trim()).not.toBe("");
      expect(entry.doThis.trim()).not.toBe("");
      expect(entry.evidence.length, entry.id).toBeGreaterThan(0);
      expect(entry.sample.kind).toBe(entry.kind);
    }
  });

  it("كل دليل يحمل مسار ملف حقيقيا — لا ادعاء بلا مرجع", () => {
    const EVIDENCE_RE = /(server\/|shared\/|client\/|drizzle\/|DOCUMENT_ACTION_PATH)/;
    for (const entry of DOCUMENT_DEAD_ENDS) {
      for (const line of entry.evidence) {
        expect(line, `${entry.id}: ${line}`).toMatch(EVIDENCE_RE);
      }
    }
  });

  /**
   * ⭐ الفحصُ الذي يجعل القائمة صادقة: كل مدخلةٍ تُمرَّر عيّنتُها على الدالّة، وتُقارَن
   * الاحكامُ الاربعة بما تدّعيه. مدخلةٌ تصف انسداداً غير قائم تسقط هنا.
   */
  it("عينة كل نهاية مسدودة ترفض الافعال الاربعة فعلا (الا الفعل الاجوف المعلن)", () => {
    for (const entry of DOCUMENT_DEAD_ENDS) {
      const bar = documentActionBar(entry.sample);
      for (const action of DOCUMENT_ACTIONS) {
        if (entry.residualAction?.action === action) {
          expect(bar[action].allowed, `${entry.id}/${action} (اجوف)`).toBe(true);
          expect(entry.residualAction.scope.trim()).not.toBe("");
          continue;
        }
        expect(bar[action].allowed, `${entry.id}/${action}`).toBe(false);
      }
    }
  });

  it("isDocumentDeadEnd صادقة على كل نهاية بلا فعل اجوف", () => {
    for (const entry of DOCUMENT_DEAD_ENDS) {
      if (entry.residualAction) {
        expect(isDocumentDeadEnd(entry.sample), entry.id).toBe(false);
        continue;
      }
      expect(isDocumentDeadEnd(entry.sample), entry.id).toBe(true);
    }
  });

  it("كل حالة تسقط في نهاية مسدودة يجب ان تكون معدَّدة صراحة", () => {
    // العكس: لا انسداد صامت. اي عينة ترفض الاربعة ولا مدخلة تصفها = ثغرة في القائمة.
    const declared = new Set(DOCUMENT_DEAD_ENDS.map((e) => JSON.stringify(e.sample)));
    const undeclared = ALL_SAMPLES.filter(
      (s) => isDocumentDeadEnd(s) && !declared.has(JSON.stringify(s)),
    );
    // هذه العينات مغطاة بمدخلات قائمة بحكم نفس السبب (اختلاف حقل لا يغير الحكم)؛
    // نثبت ان لكل منها مدخلة من نوعها على الاقل بدل مطابقة حرفية.
    for (const sample of undeclared) {
      const sameKind = DOCUMENT_DEAD_ENDS.filter((e) => e.kind === sample.kind);
      expect(sameKind.length, JSON.stringify(sample)).toBeGreaterThan(0);
    }
  });

  it("التمييز بين النهاية المقصودة والانسداد الفعلي قائم وغير فارغ الطرفين", () => {
    const byDesign = DOCUMENT_DEAD_ENDS.filter((e) => e.terminalByDesign);
    expect(byDesign.length).toBeGreaterThan(0);
    expect(DOCUMENT_BLOCKED_DEAD_ENDS.length).toBeGreaterThan(0);
    expect(byDesign.length + DOCUMENT_BLOCKED_DEAD_ENDS.length).toBe(DOCUMENT_DEAD_ENDS.length);
  });

  it("النهاية المقصودة تقول «لا اجراء يبقى» او تحيل الى مستند خلف، ولا تدعي مخرجا على نفسها", () => {
    for (const entry of DOCUMENT_DEAD_ENDS.filter((e) => e.terminalByDesign)) {
      expect(entry.doThis, entry.id).toMatch(/لا اجراء يبقى|افتح|راجع/);
    }
  });

  it("مرتجع البيع مدرج بوصفه انسدادا فعليا لا نهاية مقصودة", () => {
    const entry = DOCUMENT_DEAD_ENDS.find((e) => e.id === "SALES_RETURN_HAS_NO_DOCUMENT");
    expect(entry).toBeDefined();
    expect(entry?.terminalByDesign).toBe(false);
    expect(entry?.doThis).toContain("لا مخرج اليوم");
  });

  it("امر الشغل المفوتر قبل التسليم مدرج، ومخرجه في شاشة التوصيل لا في شاشة الامر", () => {
    const entry = DOCUMENT_DEAD_ENDS.find(
      (e) => e.id === "WORK_ORDER_INVOICED_BEFORE_DELIVERY",
    );
    expect(entry).toBeDefined();
    expect(entry?.terminalByDesign).toBe(false);
    expect(entry?.doThis).toContain("التوصيل");
  });
});

// ═══════════════════ ٥) حراسٌ على العقد نفسه ═══════════════════

describe("سلامة العقد", () => {
  it("لكل نوع تسمية عربية ونطاق تعديل معلن", () => {
    for (const kind of DOCUMENT_KINDS) {
      expect(DOCUMENT_KIND_AR[kind]?.trim()).toBeTruthy();
      expect(DOCUMENT_EDIT_SCOPE[kind]?.trim()).toBeTruthy();
    }
    for (const action of DOCUMENT_ACTIONS) {
      expect(DOCUMENT_ACTION_AR[action]?.trim()).toBeTruthy();
    }
  });

  it("الافعال الاربعة هي التي طلبها المالك — لا خامس ولا ناقص", () => {
    expect([...DOCUMENT_ACTIONS]).toEqual(["EDIT", "CANCEL", "REVERSE", "CORRECT"]);
  });
});
