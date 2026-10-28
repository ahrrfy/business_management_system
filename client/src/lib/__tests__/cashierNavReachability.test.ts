/**
 * تطابقُ **قائمة الكاشير البيضاء** مع ما يقبله الخادم فعلاً (٢٠/٨ — بلاغ إنتاج).
 *
 * البلاغ: موظّفٌ دورُه قاعدتُه `cashier` مُنح `productStudio` صراحةً، وأُسندت إليه مهمّةُ
 * استوديو فعلاً (`assignStudioTask` يفرض `productStudio:FULL` على المُسنَد إليه فقبِلَته)،
 * ووصله إشعارُ «أُسندت إليك مهمة رقم ٤٢٨٦» — **ولم يظهر له تبويب الاستوديو إطلاقاً**،
 * فبقي عملٌ مُسنَدٌ بلا بابٍ إليه.
 *
 * الجذر: شريط الكاشير يُصفّى مرّتين — بالبوّابة (`canSeeGate`، وقد مرّت بالمنح الصريح)
 * ثمّ بقائمةٍ بيضاء من المسارات. المسار الغائب عن القائمة يختفي **ولو قبِله الخادم**،
 * والبوّابة الصحيحة لا تُنقذه. هذا نصفُ العطب الذي يحرس `invoiceNavGate.test.ts` نصفَه
 * الآخر (مدخلٌ ظاهر يُرفَض بـ403).
 *
 * الحارس: لكل مسارٍ في شريط الكاشير — إن كان الخادم يمنحه لدورٍ قاعدتُه `cashier` (بقالبه
 * أو بمنحٍ صريح)، وجب أن يكون في القائمة.
 */
import { describe, expect, it } from "vitest";
import { CASHIER_NAV_PATHS, canSeeGate } from "../navVisibility";
import { visibleApplicationModules } from "../moduleRegistry";
import { ROLE_TEMPLATES, SECTION_CASHIER_ROLES, type PermissionMap } from "@shared/permissions";
import { buildDefaultRoleOperationPolicy } from "@shared/roleOperationPresets";
import {
  CASHIER_BRANCH_LIFECYCLE_SCOPE_PATHS,
  getOperationPermission,
  operationDecision,
} from "@shared/operationPermissions";

const STUDIO_PATH = "/catalog/image-studio";
/** نفس بوّابة عنصر الاستوديو في `AppLayout.NAV_LINKS` — تُبقى متطابقةً نصّاً. */
const STUDIO_GATE = { roles: ["admin", "manager", "print_operator", "auditor"], module: "productStudio" } as const;

/** كاشيرٌ مُنح الاستوديو صراحةً — بالضبط ما يفعله زرّ «امنح الصلاحية» في شاشة الاستوديو. */
const grantedCashier: PermissionMap = { ...ROLE_TEMPLATES.cashier, productStudio: "FULL" } as PermissionMap;

describe("وصول الكاشير الممنوح إلى استوديو المنتجات", () => {
  it("البوّابة تقبله — المنح الصريح يتجاوز قائمة الأدوار", () => {
    // هذه كانت تمرّ **قبل الإصلاح أيضاً**: البوّابة لم تكن يوماً هي الحاجب.
    expect(canSeeGate(STUDIO_GATE, "cashier", grantedCashier)).toBe(true);
  });

  it("والقائمة البيضاء تُتيح المسار — وإلّا اختفى المدخل رغم قبول البوّابة والخادم", () => {
    // ⛔ هذه هي التي كانت تسقط: المسار لم يكن في القائمة، فيُصفّى بعد نجاح البوّابة.
    expect(CASHIER_NAV_PATHS).toContain(STUDIO_PATH);
  });

  it("كاشيرٌ بلا منحٍ صريح لا يراه — الإتاحة ليست منحاً", () => {
    expect(canSeeGate(STUDIO_GATE, "cashier", ROLE_TEMPLATES.cashier as PermissionMap)).toBe(false);
  });

  it("القائمة بلا تكرار ومساراتها مطلقة", () => {
    expect(new Set(CASHIER_NAV_PATHS).size).toBe(CASHIER_NAV_PATHS.length);
    for (const path of CASHIER_NAV_PATHS) expect(path.startsWith("/")).toBe(true);
  });
});

describe("وصول الكاشير الكامل لدورة حياة الطلب والطباعة الحرارية والملصقات", () => {
  const defaultCashierPolicy = buildDefaultRoleOperationPolicy(
    "cashier",
    "cashier",
    ROLE_TEMPLATES.cashier as PermissionMap,
  );

  const cashierActor = {
    id: 42,
    role: "cashier" as const,
    isOwner: false,
    branchId: 1,
    operationPolicyEnabled: true,
    operationPolicy: defaultCashierPolicy,
  };

  it("يظهر للكاشير جميع مداخل دورة حياة الطلب في القائمة الموحّدة", () => {
    const visibleHrefs = visibleApplicationModules(
      "cashier",
      ROLE_TEMPLATES.cashier as PermissionMap,
      defaultCashierPolicy,
      true,
    ).map((m) => m.href);

    expect(visibleHrefs).toEqual(
      expect.arrayContaining([
        "/pos",
        "/invoices",
        "/returns",
        "/work-orders",
        "/delivery",
        "/store-admin",
      ]),
    );
  });

  it("يمنح الكاشير القالبي صلاحيات دورة الحياة والطباعة ونطاق BRANCH مع صون حواجز فصل المهام", () => {
    const requiredOperations = [
      "sales.create",
      "sales.cancel",
      "sales.reissue",
      "salesControl.requestExchange",
      "invoicePrinting.requestPrint",
      "invoicePrinting.requestReprint",
      "invoicePrinting.authorizeBridge",
      "delivery.dispatch",
      "delivery.dispatchInvoice",
      "delivery.reassignConsignment",
      "delivery.cancelAssignment",
      "delivery.recordRemittance",
      "delivery.recordCompanyStatement",
      "delivery.payPartyFees",
      "delivery.settle",
      "delivery.settleDaily",
      "delivery.recoverWriteOff",
      "delivery.documents.prepareShipmentPrintBundle",
      "delivery.documents.requestPrint",
      "delivery.documents.completePrint",
      "delivery.paymentRefunds.request",
      "delivery.paymentRefunds.requestExcess",
      "delivery.fulfillment.aftercare.prepare",
      "delivery.fulfillment.aftercare.dispatch",
      "delivery.fulfillment.aftercare.settlementPost",
      "delivery.fulfillment.aftercare.rightsPost",
      "delivery.fulfillment.charges.refundExcess",
      "storeAdmin.orders.dispatch",
      "workOrders.assign",
      "workOrders.update",
      "returns.create",
      "returns.request",
      "returns.executeSalesReturnCart",
      "expenses.create",
      "expenses.executeFromOwnDrawer",
      "shifts.cashDrop",
      "printPos.cancelHeldSale",
      "sales.lookupForCorrection",
      "sales.salespeople",
      "documentDelivery.readiness",
      "documentDelivery.downloadPdf",
      "documentDelivery.sendWhatsAppPdf",
    ];

    for (const op of requiredOperations) {
      expect(operationDecision(cashierActor, op).allowed, `expected ${op} to be allowed`).toBe(true);
    }

    for (const branchScopedPath of Array.from(CASHIER_BRANCH_LIFECYCLE_SCOPE_PATHS)) {
      const def = getOperationPermission(branchScopedPath);
      if (def?.supportsRecordScope) {
        expect(defaultCashierPolicy.recordScopes?.[def.key]).toBe("BRANCH");
      }
    }

    // فصل المهام (SoD) والمشتريات والحسابات الختامية والتكلفة تظل محجوبة عن الكاشير القالبي
    expect(operationDecision(cashierActor, "salesControl.approve").allowed).toBe(false);
    expect(operationDecision(cashierActor, "purchases.createOrder").allowed).toBe(false);
    expect(operationDecision(cashierActor, "accounts.tree").allowed).toBe(false);
    expect(defaultCashierPolicy.dataVisibility).toEqual({
      purchaseCost: false,
      profitMargin: false,
    });
  });

  it("تمنح قوالب محطات الكاشير المتخصصة (تجزئة / طباعة / استقبال) طباعة الفواتير والملصقات", () => {
    for (const station of SECTION_CASHIER_ROLES) {
      const stationPolicy = buildDefaultRoleOperationPolicy(
        station.key,
        "cashier",
        station.permissions,
      );
      const actor = {
        ...cashierActor,
        operationPolicy: stationPolicy,
      };
      expect(operationDecision(actor, "invoicePrinting.requestPrint").allowed).toBe(true);
      expect(operationDecision(actor, "invoicePrinting.requestReprint").allowed).toBe(true);
      expect(operationDecision(actor, "invoicePrinting.authorizeBridge").allowed).toBe(true);
      for (const scopedPath of [
        "sales.lookupForCorrection",
        "sales.salespeople",
        "salesControl.requestExchange",
        "documentDelivery.readiness",
        "documentDelivery.downloadPdf",
        "documentDelivery.sendWhatsAppPdf",
      ]) {
        const def = getOperationPermission(scopedPath);
        expect(def?.supportsRecordScope, `${scopedPath} should support record scope`).toBe(true);
        expect(stationPolicy.recordScopes?.[def!.key]).toBe("BRANCH");
      }
      if (station.key === "print_cashier") {
        expect(operationDecision(actor, "printPos.cancelHeldSale").allowed).toBe(true);
      }
    }
  });
});
