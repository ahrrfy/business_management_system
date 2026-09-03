/**
 * اختبارُ عقد «الخطوة التالية».
 *
 * **جوهرُه اختبارُ عدٍّ لا اختبارُ فروع**: يستورد قيمَ كلِّ enum من قواميسها المشتركة
 * (`invoiceStatus.ts` · `workOrderStatus.ts` · مصفوفةُ حالات أمر الشراء) ويمرّ على كل حالةٍ
 * في مصفوفةٍ من تركيبات الحقائق، مؤكّداً أنّ كلَّ واحدةٍ إمّا تُنتج `NextAction` صالحاً للعرض
 * وإمّا `null` **بسببٍ نهائيٍّ معلن**. فحين تُضاف حالةٌ إلى أيّ enum غداً تُحمِّر هذه الحزمة
 * فوراً بدل أن تمرّ صامتةً فيقف الموظّف أمام مستندٍ بلا خطوة — وهي العلّةُ التي بُنيت لها
 * الوحدة أصلاً.
 *
 * ويحرس معها أربعةَ عقودٍ أخرى تُفسِد قيمةَ الوحدة إن انكسرت بصمت:
 *  ١) لا نهايةَ **كاذبة**: `null` والسجلُّ متلازمان في الاتّجاهين — لا حالةٌ ترجع `null` بلا
 *     إعلان، ولا مدخلةٌ معلنةٌ لا تقع أبداً (وعدٌ بانسدادٍ غيرِ قائم).
 *  ٢) لا نصَّ ميّت: `what` وكلُّ سطرِ منعٍ غيرُ فارغ، بلا تشكيل (يشوّهه الخطّ في الأحجام
 *     الصغيرة) وبلا إيموجي (حارس `check:emoji`) وبأرقامٍ لاتينية (قرار المالك).
 *  ٣) لا مسارَ كاذب: كلُّ `href` من مجموعةٍ مطابقةٍ لمسارات `client/src/App.tsx`.
 *  ٤) لا سقفَ زمنيٍّ معطوب: `slaHours` عددٌ منتهٍ غيرُ سالب، والمتأخّرُ يُقصّ إلى `0`
 *     لا إلى سالبٍ يُعرَض «‎-5 ساعة».
 */
import { describe, expect, it } from "vitest";
import { INVOICE_STATUSES, type InvoiceStatus } from "./invoiceStatus";
import {
  NEXT_ACTION_KINDS,
  NEXT_ACTION_STATUS_UNIVERSE,
  NEXT_ACTION_TERMINAL_REASON,
  PURCHASE_ORDER_STATUSES,
  deriveNextAction,
  isNextActionBlocked,
  nextActionOwnerLabel,
  nextActionTerminalReason,
  type NextAction,
  type NextActionInput,
  type NextActionKind,
  type PurchaseOrderNextActionFacts,
  type PurchaseOrderStatus,
  type SaleInvoiceNextActionFacts,
  type WorkOrderNextActionFacts,
} from "./nextAction";
import { WORK_ORDER_STATUSES, type WorkOrderStatus } from "./workOrderStatus";

// ───────────────────────── أدواتُ الفحص النصّيّ ─────────────────────────

/**
 * حركاتُ التشكيل العربية — ممنوعةٌ في النصّ القصير المعروض.
 * بأكواد Unicode صريحةً لا بمحارفَ حرفيّة: الحركةُ في مصدرٍ RTL غيرُ مرئيّةٍ للمراجع،
 * فمقارنةُ نطاقٍ مكتوبٍ بالحروف تُصبح غيرَ قابلةٍ للتدقيق بالعين.
 */
const TASHKEEL = /[\u064B-\u0655\u0670]/;
/** الأرقامُ الهندية والفارسية — الأرقامُ لاتينيةٌ دائماً (قرار المالك). */
const ARABIC_INDIC_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/;
/**
 * الكتلُ الشائعة للإيموجي — يمنعها حارس `check:emoji` في الواجهة.
 * بلا علَم `u` عمداً (مشروع بلا `target` في tsconfig — العلَم يُحمِّر tsc)،
 * فالمدى الفوقيّ يُلتقط بـ**البدائل العليا**
 */
const EMOJI = /[\u2600-\u27BF\u2B00-\u2BFF\uD83C-\uD83E\uFE0F]/;

/** المساراتُ المسموحة — مطابقةٌ لِـ`client/src/App.tsx` (كلُّها معرَّفةٌ هناك فعلاً). */
const KNOWN_ROUTE_PREFIXES = [
  "/invoices",
  "/work-orders",
  "/purchases",
  "/delivery",
];

function expectDisplayText(text: string, where: string): void {
  expect(text.trim().length, `${where}: نص فارغ`).toBeGreaterThan(0);
  expect(TASHKEEL.test(text), `${where}: تشكيل في نص قصير — «${text}»`).toBe(false);
  expect(EMOJI.test(text), `${where}: ايموجي — «${text}»`).toBe(false);
  expect(
    ARABIC_INDIC_DIGITS.test(text),
    `${where}: ارقام هندية بدل اللاتينية — «${text}»`,
  ).toBe(false);
}

function expectValidAction(next: NextAction, where: string): void {
  expectDisplayText(next.what, `${where}.what`);

  switch (next.owner.kind) {
    case "ROLE":
      expect(next.owner.role.length, `${where}.owner.role فارغ`).toBeGreaterThan(0);
      break;
    case "USER":
      expect(
        Number.isInteger(next.owner.userId),
        `${where}.owner.userId ليس عددا صحيحا`,
      ).toBe(true);
      expect(next.owner.userId, `${where}.owner.userId غير موجب`).toBeGreaterThan(0);
      break;
    case "COUNTERPARTY":
      expectDisplayText(next.owner.label, `${where}.owner.label`);
      break;
    case "SYSTEM":
      break;
  }

  const href = next.href;
  if (href != null) {
    expect(href.startsWith("/"), `${where}.href ليس مسارا داخليا — «${href}»`).toBe(true);
    expect(href.includes("//"), `${where}.href فيه شرطتان — «${href}»`).toBe(false);
    expect(
      KNOWN_ROUTE_PREFIXES.some((p) => href === p || href.startsWith(`${p}/`)),
      `${where}.href خارج مسارات App.tsx — «${href}»`,
    ).toBe(true);
    expect(ARABIC_INDIC_DIGITS.test(href), `${where}.href بارقام هندية`).toBe(false);
  }

  if (next.slaHours != null) {
    expect(Number.isFinite(next.slaHours), `${where}.slaHours ليس عددا منتهيا`).toBe(true);
    expect(next.slaHours, `${where}.slaHours سالب`).toBeGreaterThanOrEqual(0);
  }

  if (next.blockedBy != null) {
    expect(
      next.blockedBy.length,
      `${where}.blockedBy مصفوفة فارغة بدل الحذف`,
    ).toBeGreaterThan(0);
    next.blockedBy.forEach((entry, i) =>
      expectDisplayText(entry, `${where}.blockedBy[${i}]`),
    );
  }
}

// ───────────── مصفوفاتُ الحقائق: كلُّ حالةٍ × تركيباتٍ حقيقية ─────────────

function saleSamples(status: InvoiceStatus): SaleInvoiceNextActionFacts[] {
  const out: SaleInvoiceNextActionFacts[] = [];
  for (const hasLiveConsignment of [false, true]) {
    for (const replacementInvoiceId of [null, 4102]) {
      for (const hoursUntilDue of [null, -5, 24]) {
        out.push({
          kind: "SALE_INVOICE",
          invoiceId: 771,
          status,
          hasLiveConsignment,
          deliveryPartyLabel: hasLiveConsignment ? "مندوب الكرادة" : null,
          replacementInvoiceId,
          hoursUntilDue,
        });
      }
    }
  }
  return out;
}

function workOrderSamples(status: WorkOrderStatus): WorkOrderNextActionFacts[] {
  const out: WorkOrderNextActionFacts[] = [];
  for (const assignedToUserId of [null, 9]) {
    for (const hasDelivery of [false, true]) {
      for (const consignmentId of [null, 33]) {
        for (const courierDeliveredAt of [null, "2026-09-01T10:00:00Z"]) {
          for (const kanbanState of ["NORMAL", "BLOCKED"] as const) {
            for (const blockingTaskLabel of [null, "مراجعة تصميم مع الزبون"]) {
              out.push({
                kind: "WORK_ORDER",
                workOrderId: 512,
                status,
                assignedToUserId,
                hasDelivery,
                consignmentId,
                courierDeliveredAt,
                kanbanState,
                blockedReason: kanbanState === "BLOCKED" ? "بانتظار ورق مقوى" : null,
                blockingTaskLabel,
              });
            }
          }
        }
      }
    }
  }
  return out;
}

function purchaseSamples(status: PurchaseOrderStatus): PurchaseOrderNextActionFacts[] {
  const out: PurchaseOrderNextActionFacts[] = [];
  for (const approvalRequest of ["PENDING", "STALE", "NONE"] as const) {
    for (const requisitionCoverage of ["NOT_REQUIRED", "COVERED", "MISSING"] as const) {
      for (const hasCurrentRevision of [false, true]) {
        for (const hasUnpaidBalance of [false, true]) {
          for (const hoursUntilExpectedDelivery of [null, -3, 48]) {
            out.push({
              kind: "PURCHASE_ORDER",
              purchaseOrderId: 88,
              status,
              approvalRequest,
              requisitionCoverage,
              hasCurrentRevision,
              hasUnpaidBalance,
              hoursUntilExpectedDelivery,
            });
          }
        }
      }
    }
  }
  return out;
}

/** كلُّ العيّنات مجموعةً بالنوع والحالة — مصدرُ كلِّ اختبارات العدّ أدناه. */
function samplesFor(kind: NextActionKind, status: string): NextActionInput[] {
  if (kind === "SALE_INVOICE") return saleSamples(status as InvoiceStatus);
  if (kind === "WORK_ORDER") return workOrderSamples(status as WorkOrderStatus);
  return purchaseSamples(status as PurchaseOrderStatus);
}

/** هل تُنتج أيُّ تركيبةٍ لهذه الحالة نهايةً (`null`)؟ */
function yieldsTerminal(kind: NextActionKind, status: string): boolean {
  return samplesFor(kind, status).some((doc) => deriveNextAction(doc) == null);
}

// ═══════════════════════ ١) اختبارُ العدّ — جوهرُ الوحدة ═══════════════════════

describe("عد الحالات: لا حالة صماء في اي نوع", () => {
  it("مجموعة الحالات مقروءة من القواميس المشتركة نفسها لا منسوخة", () => {
    expect(NEXT_ACTION_STATUS_UNIVERSE.SALE_INVOICE).toBe(INVOICE_STATUSES);
    expect(NEXT_ACTION_STATUS_UNIVERSE.WORK_ORDER).toBe(WORK_ORDER_STATUSES);
    expect(NEXT_ACTION_STATUS_UNIVERSE.PURCHASE_ORDER).toBe(PURCHASE_ORDER_STATUSES);
  });

  /**
   * عدٌّ صريح. تغييرُه ليس عيباً — لكنّه **قرار**: حالةٌ تُضاف تعني خطوةً تُكتب لها هنا
   * قبل تعديل الرقم، لا رقماً يُحدَّث ثمّ تُترك الحالةُ بلا جواب.
   */
  it("العدد المغطى اليوم: 7 لفاتورة البيع و5 لامر الشغل و5 لامر الشراء", () => {
    expect(NEXT_ACTION_STATUS_UNIVERSE.SALE_INVOICE.length).toBe(7);
    expect(NEXT_ACTION_STATUS_UNIVERSE.WORK_ORDER.length).toBe(5);
    expect(NEXT_ACTION_STATUS_UNIVERSE.PURCHASE_ORDER.length).toBe(5);
    expect(NEXT_ACTION_KINDS.length).toBe(3);
  });

  for (const kind of NEXT_ACTION_KINDS) {
    for (const status of NEXT_ACTION_STATUS_UNIVERSE[kind] as readonly string[]) {
      it(`${kind}/${status}: كل تركيبة تنتج خطوة صالحة او نهاية معلنة`, () => {
        const samples = samplesFor(kind, status);
        expect(samples.length, "لا عينات لهذه الحالة").toBeGreaterThan(0);

        let sawAction = false;
        let sawNull = false;

        samples.forEach((doc, i) => {
          const next = deriveNextAction(doc);
          if (next == null) {
            sawNull = true;
            const reason = nextActionTerminalReason(kind, status);
            expect(
              reason,
              `${kind}/${status}[${i}]: ارجعت null بلا سبب نهائي معلن — هذه هي «الحالة الصماء» بعينها`,
            ).not.toBeNull();
            expectDisplayText(reason as string, `${kind}/${status}.terminalReason`);
            return;
          }
          sawAction = true;
          expectValidAction(next, `${kind}/${status}[${i}]`);
        });

        // كل حالة تُنتج شيئاً: خطوةً في تركيبةٍ ما، أو نهايةً معلنة — ولا ثالثَ لهما.
        expect(sawAction || sawNull).toBe(true);
      });
    }
  }
});

// ═════════════ ٢) سجلُّ النهايات: معلنٌ ⇔ واقعٌ (الاتجاهان معاً) ═════════════

describe("سجل النهايات", () => {
  for (const kind of NEXT_ACTION_KINDS) {
    const declared = Object.keys(NEXT_ACTION_TERMINAL_REASON[kind]);
    const universe = NEXT_ACTION_STATUS_UNIVERSE[kind] as readonly string[];

    it(`${kind}: كل نهاية معلنة تقع فعلا على تركيبة حقائق`, () => {
      for (const status of declared) {
        expect(
          yieldsTerminal(kind, status),
          `${kind}/${status}: نهاية معلنة لا تقع ابدا — وعد بانسداد غير قائم`,
        ).toBe(true);
      }
    });

    it(`${kind}: كل حالة ترجع null معلنة في السجل`, () => {
      for (const status of universe) {
        if (!yieldsTerminal(kind, status)) continue;
        expect(
          declared.includes(status),
          `${kind}/${status}: ترجع null بلا مدخلة في NEXT_ACTION_TERMINAL_REASON`,
        ).toBe(true);
      }
    });

    it(`${kind}: كل مفتاح في السجل قيمة من الـenum نفسه`, () => {
      for (const status of declared) {
        expect(universe.includes(status), `${kind}: مفتاح غريب «${status}»`).toBe(true);
      }
    });
  }
});

// ═══════════════ ٣) الفروع التي تحمل قيمةَ الوحدة — بأمثلةٍ صريحة ═══════════════

const sale = (over: Partial<SaleInvoiceNextActionFacts> = {}): SaleInvoiceNextActionFacts => ({
  kind: "SALE_INVOICE",
  invoiceId: 771,
  status: "PENDING",
  hasLiveConsignment: false,
  deliveryPartyLabel: null,
  replacementInvoiceId: null,
  hoursUntilDue: null,
  ...over,
});

const workOrder = (over: Partial<WorkOrderNextActionFacts> = {}): WorkOrderNextActionFacts => ({
  kind: "WORK_ORDER",
  workOrderId: 512,
  status: "RECEIVED",
  assignedToUserId: null,
  hasDelivery: false,
  consignmentId: null,
  courierDeliveredAt: null,
  kanbanState: "NORMAL",
  blockedReason: null,
  blockingTaskLabel: null,
  ...over,
});

const purchase = (
  over: Partial<PurchaseOrderNextActionFacts> = {},
): PurchaseOrderNextActionFacts => ({
  kind: "PURCHASE_ORDER",
  purchaseOrderId: 88,
  status: "DRAFT",
  approvalRequest: "NONE",
  requisitionCoverage: "NOT_REQUIRED",
  hasCurrentRevision: true,
  hasUnpaidBalance: false,
  hoursUntilExpectedDelivery: null,
  ...over,
});

describe("فاتورة البيع", () => {
  it("غير مدفوعة بلا طرد: التحصيل على الكاشير في شاشة الفاتورة", () => {
    const next = deriveNextAction(sale({ status: "PENDING", hoursUntilDue: 24 }));
    expect(next?.owner).toEqual({ kind: "ROLE", role: "cashier" });
    expect(next?.href).toBe("/invoices/771");
    expect(next?.slaHours).toBe(24);
    expect(isNextActionBlocked(next ?? null)).toBe(false);
  });

  it("مدفوعة جزئيا: النص يطلب المتبقي لا القيمة كلها", () => {
    expect(deriveNextAction(sale({ status: "PARTIALLY_PAID" }))?.what).toContain("المتبقي");
  });

  it("طرد حي: الملكية تنتقل الى جهة التوصيل ولا يعرض قبض على شاشة الفاتورة", () => {
    const next = deriveNextAction(
      sale({ status: "PENDING", hasLiveConsignment: true, deliveryPartyLabel: "مندوب الكرادة" }),
    );
    expect(next?.owner).toEqual({ kind: "COUNTERPARTY", label: "مندوب الكرادة" });
    expect(next?.href).toBe("/delivery");
  });

  it("جهة توصيل بلا اسم: تسمية عامة لا نص فارغ", () => {
    const next = deriveNextAction(sale({ status: "PENDING", hasLiveConsignment: true }));
    expect(next?.owner).toEqual({ kind: "COUNTERPARTY", label: "جهة التوصيل" });
  });

  it("الاستحقاق الفائت يقص الى صفر لا الى سالب", () => {
    expect(deriveNextAction(sale({ hoursUntilDue: -30 }))?.slaHours).toBe(0);
  });

  it("بلا استحقاق مسجل: لا سقف زمني بدل صفر كاذب", () => {
    expect(deriveNextAction(sale({ hoursUntilDue: null }))?.slaHours).toBeUndefined();
  });

  it("مسددة بلا طرد: نهاية معلنة", () => {
    expect(deriveNextAction(sale({ status: "PAID" }))).toBeNull();
    expect(nextActionTerminalReason("SALE_INVOICE", "PAID")).toContain("محصلة بالكامل");
  });

  it("مسددة وطردها بالطريق: الخطوة اثبات الوصول لا الاقفال", () => {
    const next = deriveNextAction(sale({ status: "PAID", hasLiveConsignment: true }));
    expect(next?.what).toContain("اثبت وصول الطرد");
    expect(next?.owner.kind).toBe("COUNTERPARTY");
  });

  /**
   * ⭐ الفرقُ الجوهريّ عن [`shared/documentActions.ts`]: المستبدَلةُ **ميتةٌ** هناك (لا فعل
   * يقع عليها) ولها **خطوةٌ تالية** هنا. الخلطُ بين «لا فعلَ عليه» و«لا خطوةَ بعده» هو
   * بالضبط ما يترك الموظّف واقفاً أمام فاتورةٍ صامتة.
   */
  it("المستبدلة ليست نهاية: تقود الى الفاتورة البديلة", () => {
    const next = deriveNextAction(sale({ status: "SUPERSEDED", replacementInvoiceId: 4102 }));
    expect(next).not.toBeNull();
    expect(next?.href).toBe("/invoices/4102");
    expect(nextActionTerminalReason("SALE_INVOICE", "SUPERSEDED")).toBeNull();
  });

  it("المستبدلة بلا رابط للبديلة: خطوة قائمة مع مانع معلن", () => {
    const next = deriveNextAction(sale({ status: "SUPERSEDED", replacementInvoiceId: null }));
    expect(next?.href).toBe("/invoices");
    expect(isNextActionBlocked(next ?? null)).toBe(true);
    expect(next?.blockedBy?.[0]).toContain("الفاتورة البديلة");
  });

  it("CONFIRMED تعامل معاملة المستحق لا تترك بلا خطوة", () => {
    expect(deriveNextAction(sale({ status: "CONFIRMED" }))?.owner).toEqual({
      kind: "ROLE",
      role: "cashier",
    });
  });

  it("الملغاة والمرتجعة نهايتان معلنتان", () => {
    for (const status of ["CANCELLED", "RETURNED"] as const) {
      expect(deriveNextAction(sale({ status }))).toBeNull();
      expect(nextActionTerminalReason("SALE_INVOICE", status)?.length).toBeGreaterThan(0);
    }
  });
});

describe("امر الشغل", () => {
  it("مستلم بلا اسناد: الدور يملكه فيسحبه اول فارغ", () => {
    const next = deriveNextAction(workOrder({ status: "RECEIVED" }));
    expect(next?.owner).toEqual({ kind: "ROLE", role: "print_operator" });
    expect(next?.href).toBe("/work-orders/512");
  });

  it("مستلم ومسند: يملكه الفني بعينه (assertOperatorOwns يمنع غيره)", () => {
    expect(deriveNextAction(workOrder({ status: "RECEIVED", assignedToUserId: 9 }))?.owner).toEqual(
      { kind: "USER", userId: 9 },
    );
  });

  it("السقوف الزمنية مشتقة من WORK_ORDER_SLA_MINUTES لا مكتوبة هنا", () => {
    expect(deriveNextAction(workOrder({ status: "RECEIVED" }))?.slaHours).toBe(3);
    expect(deriveNextAction(workOrder({ status: "IN_PROGRESS" }))?.slaHours).toBe(8);
    expect(deriveNextAction(workOrder({ status: "READY" }))?.slaHours).toBe(2);
  });

  it("مهمة حاجزة مفتوحة: تمنع البدء ووسم الجاهزية معا", () => {
    for (const status of ["RECEIVED", "IN_PROGRESS"] as const) {
      const next = deriveNextAction(workOrder({ status, blockingTaskLabel: "مراجعة تصميم" }));
      expect(isNextActionBlocked(next ?? null)).toBe(true);
      expect(next?.blockedBy?.some((b) => b.includes("مراجعة تصميم"))).toBe(true);
    }
  });

  it("اشارة الفني BLOCKED: سببها هو المانع المعروض", () => {
    const next = deriveNextAction(
      workOrder({
        status: "IN_PROGRESS",
        kanbanState: "BLOCKED",
        blockedReason: "بانتظار ورق مقوى",
      }),
    );
    expect(next?.blockedBy?.[0]).toBe("بانتظار ورق مقوى");
  });

  it("BLOCKED بلا سبب مكتوب: نص بديل لا سطر فارغ", () => {
    const next = deriveNextAction(
      workOrder({ status: "IN_PROGRESS", kanbanState: "BLOCKED", blockedReason: "   " }),
    );
    expect(next?.blockedBy?.[0]).toContain("التنفيذ متوقف");
  });

  it("مانعان معا يظهران معا — لا يبتلع احدهما الاخر", () => {
    const next = deriveNextAction(
      workOrder({
        status: "IN_PROGRESS",
        kanbanState: "BLOCKED",
        blockedReason: "بانتظار ورق مقوى",
        blockingTaskLabel: "مراجعة تصميم",
      }),
    );
    expect(next?.blockedBy?.length).toBe(2);
  });

  it("جاهز بلا توصيل: التسليم والفوترة على الكاشير", () => {
    const next = deriveNextAction(workOrder({ status: "READY", hasDelivery: false }));
    expect(next?.what).toContain("سلم الامر للعميل");
    expect(next?.owner).toEqual({ kind: "ROLE", role: "cashier" });
  });

  it("جاهز بتوصيل ولم يسند: الاسناد على الكاشير", () => {
    expect(deriveNextAction(workOrder({ status: "READY", hasDelivery: true }))?.what).toContain(
      "اسند الامر لمندوب",
    );
  });

  it("جاهز واسند فعلا: لا يعرض اسنادا ثانيا — المتابعة على جهة التوصيل", () => {
    const next = deriveNextAction(
      workOrder({ status: "READY", hasDelivery: true, consignmentId: 33 }),
    );
    expect(next?.owner.kind).toBe("COUNTERPARTY");
    expect(next?.href).toBe("/delivery");
  });

  it("مسلم وطرده بالطريق: الخطوة عند جهة التوصيل لا نهاية", () => {
    const next = deriveNextAction(
      workOrder({
        status: "DELIVERED",
        hasDelivery: true,
        consignmentId: 33,
        courierDeliveredAt: null,
      }),
    );
    expect(next?.what).toContain("اثبت وصول الطرد");
  });

  it("مسلم ووصل طرده: نهاية معلنة", () => {
    const next = deriveNextAction(
      workOrder({
        status: "DELIVERED",
        hasDelivery: true,
        consignmentId: 33,
        courierDeliveredAt: "2026-09-01T10:00:00Z",
      }),
    );
    expect(next).toBeNull();
    expect(nextActionTerminalReason("WORK_ORDER", "DELIVERED")?.length).toBeGreaterThan(0);
  });

  it("الملغى نهاية معلنة", () => {
    expect(deriveNextAction(workOrder({ status: "CANCELLED" }))).toBeNull();
    expect(nextActionTerminalReason("WORK_ORDER", "CANCELLED")).toContain("خرج من دورة العمل");
  });
});

describe("امر الشراء", () => {
  it("مسودة سليمة: الارسال للاعتماد على المشتريات بلا مانع", () => {
    const next = deriveNextAction(purchase({ status: "DRAFT" }));
    expect(next?.owner).toEqual({ kind: "ROLE", role: "purchasing" });
    expect(next?.href).toBe("/purchases/88");
    expect(isNextActionBlocked(next ?? null)).toBe(false);
  });

  it("مسودة بلا مراجعة ثابتة: مانع معلن بنصه", () => {
    const next = deriveNextAction(purchase({ status: "DRAFT", hasCurrentRevision: false }));
    expect(next?.blockedBy?.some((b) => b.includes("مراجعة ثابتة"))).toBe(true);
  });

  it("تغطية طلب الشراء ناقصة: نفس المانع على الارسال والاعتماد معا", () => {
    const draft = deriveNextAction(purchase({ status: "DRAFT", requisitionCoverage: "MISSING" }));
    const sent = deriveNextAction(
      purchase({ status: "SENT", approvalRequest: "PENDING", requisitionCoverage: "MISSING" }),
    );
    expect(draft?.blockedBy?.some((b) => b.includes("استثناء طارئ"))).toBe(true);
    expect(sent?.blockedBy?.some((b) => b.includes("استثناء طارئ"))).toBe(true);
  });

  it("مرسل وطلبه معلق: الاعتماد على المدير", () => {
    const next = deriveNextAction(purchase({ status: "SENT", approvalRequest: "PENDING" }));
    expect(next?.owner).toEqual({ kind: "ROLE", role: "manager" });
    expect(next?.what).toContain("وصول الكميات");
  });

  it("طلب الاعتماد لاغ: الكرة ترجع للمشتريات مع سبب البطلان", () => {
    const next = deriveNextAction(purchase({ status: "SENT", approvalRequest: "STALE" }));
    expect(next?.owner).toEqual({ kind: "ROLE", role: "purchasing" });
    expect(next?.blockedBy?.some((b) => b.includes("لاغ"))).toBe(true);
  });

  it("مرسل بلا طلب: الخطوة طلب الاعتماد", () => {
    expect(deriveNextAction(purchase({ status: "SENT", approvalRequest: "NONE" }))?.what).toContain(
      "اطلب اعتماد",
    );
  });

  it("معتمد وبقيت كميات: امر شراء مستقل — لا شاشة استلام مستقلة اليوم", () => {
    const next = deriveNextAction(purchase({ status: "CONFIRMED", hoursUntilExpectedDelivery: 48 }));
    expect(next?.href).toBe("/purchases/new");
    expect(next?.slaHours).toBe(48);
  });

  it("مستلم وعليه مستحق: السداد يقود الى الشاشة المحكومة لا الى purchases.pay المغلق", () => {
    const next = deriveNextAction(purchase({ status: "RECEIVED", hasUnpaidBalance: true }));
    expect(next?.href).toBe("/purchases/supplier-payments");
    expect(next?.owner).toEqual({ kind: "ROLE", role: "accountant" });
  });

  it("مستلم ومسدد: نهاية معلنة", () => {
    expect(deriveNextAction(purchase({ status: "RECEIVED", hasUnpaidBalance: false }))).toBeNull();
    expect(nextActionTerminalReason("PURCHASE_ORDER", "RECEIVED")).toContain("مقفلة");
  });

  it("الملغى نهاية معلنة", () => {
    expect(deriveNextAction(purchase({ status: "CANCELLED" }))).toBeNull();
    expect(nextActionTerminalReason("PURCHASE_ORDER", "CANCELLED")?.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════ ٤) تسميةُ صاحب الخطوة ═══════════════════════

describe("تسمية صاحب الخطوة", () => {
  it("الدور يقرا تسميته من shared/permissions لا من قاموس محلي", () => {
    expect(nextActionOwnerLabel({ kind: "ROLE", role: "cashier" })).toBe("كاشير");
    expect(
      nextActionOwnerLabel({ kind: "ROLE", role: "purchasing" }).length,
    ).toBeGreaterThan(0);
  });

  it("الشخص: اسمه ان توفر، وبديل مفهوم ان لم يتوفر", () => {
    expect(nextActionOwnerLabel({ kind: "USER", userId: 9 }, "علي حسن")).toBe("علي حسن");
    expect(nextActionOwnerLabel({ kind: "USER", userId: 9 })).toBe("الموظف المسند");
    expect(nextActionOwnerLabel({ kind: "USER", userId: 9 }, "   ")).toBe("الموظف المسند");
  });

  it("النظام والطرف الخارجي", () => {
    expect(nextActionOwnerLabel({ kind: "SYSTEM" })).toBe("النظام");
    expect(nextActionOwnerLabel({ kind: "COUNTERPARTY", label: "مندوب الكرادة" })).toBe(
      "مندوب الكرادة",
    );
  });

  it("لا تسمية فارغة لاي صاحب خطوة تنتجها الوحدة", () => {
    for (const kind of NEXT_ACTION_KINDS) {
      for (const status of NEXT_ACTION_STATUS_UNIVERSE[kind] as readonly string[]) {
        for (const doc of samplesFor(kind, status)) {
          const next = deriveNextAction(doc);
          if (next == null) continue;
          expect(nextActionOwnerLabel(next.owner).trim().length).toBeGreaterThan(0);
        }
      }
    }
  });
});
