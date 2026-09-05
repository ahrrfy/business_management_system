/**
 * م٨ — إثباتُ **تكافؤ الرؤية** بين نموذج القدرات (shared/capabilities.ts) وبوّابات الوحدة القائمة
 * (server/trpc.ts). اختبارٌ **نقيّ بلا قاعدة بيانات**: يشتقّ القرارين من دوالٍّ نقيّة ويقارنهما لكلّ
 * (دور × نقطة نهايةٍ محكومةٍ بوحدة). معيار الخروج: القدراتُ تُعيد إنتاجَ قرار اليوم بالضبط على مستوى
 * الوحدة، ولا تُوسّع الوصول أبداً — والوصلُ (moduleGateShadowDecision) لا يغيّر القرار في أيّ حالة.
 *
 * لماذا جدولٌ يدويّ للبوّابات: `server/trpc.ts` يجرّ سياقَ الخادم (initTRPC/logger/crypto) فلا يُستورَد
 * في وحدةٍ نقيّة. الجدول أدناه مرآةٌ حرفيّةٌ لتعريفات `moduleProcedure`/`requireModuleGate`/`requireModule`
 * هناك (allowedRoles=null ⇒ بوّابة خريطةٍ محضة عبر requireModule؛ غير ذلك ⇒ moduleProcedure/requireModuleGate).
 */
import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  capabilitiesEnabled,
  capabilityModuleDecision,
  capabilityShadowEnabled,
  classifyCapabilityShadow,
  deriveCapabilityGrants,
  deriveGrantsForRole,
  hasCapability,
  moduleGateShadowDecision,
} from "@shared/capabilities";
import {
  ALL_ROLES,
  hasModuleAccess,
  moduleAccessAllowed,
  resolvePermissions,
  type AccessLevel,
  type RoleKey,
} from "@shared/permissions";

/** بوّابةٌ محكومةٌ بوحدة كما تُعرَّف في server/trpc.ts. */
interface Gate {
  name: string;
  moduleKey: string;
  minLevel: AccessLevel;
  /** null ⇒ requireModule (خريطة محضة، بلا قائمة أدوار)؛ غير ذلك ⇒ moduleProcedure/requireModuleGate. */
  allowedRoles: readonly string[] | null;
}

// ── بوّابات الخريطة المحضة (requireModule/…​.use(requireModule)) — القرار = hasModuleAccess ────────
const MODULE_MAP_GATES: Gate[] = [
  { name: "salesReadProcedure", moduleKey: "sales", minLevel: "READ", allowedRoles: null },
  { name: "purchasesReadProcedure", moduleKey: "purchases", minLevel: "READ", allowedRoles: null },
  { name: "inventoryReadProcedure", moduleKey: "inventory", minLevel: "READ", allowedRoles: null },
  { name: "customersReadProcedure", moduleKey: "crm", minLevel: "READ", allowedRoles: null },
  { name: "crmReadProcedure", moduleKey: "crm", minLevel: "READ", allowedRoles: null },
  { name: "campaignsReadProcedure", moduleKey: "campaigns", minLevel: "READ", allowedRoles: null },
  { name: "collectionsReadProcedure", moduleKey: "collections", minLevel: "READ", allowedRoles: null },
  { name: "tasksReadProcedure", moduleKey: "tasks", minLevel: "READ", allowedRoles: null },
  { name: "storeReadProcedure", moduleKey: "store", minLevel: "READ", allowedRoles: null },
  { name: "deliveryReadProcedure", moduleKey: "store", minLevel: "READ", allowedRoles: null },
  { name: "suppliersReadProcedure", moduleKey: "suppliers", minLevel: "READ", allowedRoles: null },
  { name: "consignmentReadProcedure", moduleKey: "consignments", minLevel: "READ", allowedRoles: null },
  { name: "productsReadProcedure", moduleKey: "products", minLevel: "READ", allowedRoles: null },
  { name: "productStudioReadProcedure", moduleKey: "productStudio", minLevel: "READ", allowedRoles: null },
  { name: "productStudioWriteProcedure", moduleKey: "productStudio", minLevel: "FULL", allowedRoles: null },
  { name: "expensesReadProcedure", moduleKey: "expenses", minLevel: "READ", allowedRoles: null },
  { name: "expensesGlobalReadProcedure", moduleKey: "expenses", minLevel: "READ", allowedRoles: null },
  { name: "workordersReadProcedure", moduleKey: "workorders", minLevel: "READ", allowedRoles: null },
  { name: "treasuryReadProcedure", moduleKey: "treasury", minLevel: "READ", allowedRoles: null },
  { name: "commissionsReadProcedure", moduleKey: "commissions", minLevel: "READ", allowedRoles: null },
  { name: "announcementsReadProcedure", moduleKey: "announcements", minLevel: "READ", allowedRoles: null },
  { name: "digitalCardsPosProcedure", moduleKey: "digital_cards", minLevel: "READ", allowedRoles: null },
  // مركّبة: managerProcedure.use(requireModule) — طبقةُ requireModule نفسها بوّابةُ خريطةٍ محضة.
  { name: "productStudioManagerProcedure", moduleKey: "productStudio", minLevel: "FULL", allowedRoles: null },
];

// ── بوّابات الوحدة + قائمة الأدوار (moduleProcedure / requireModuleGate) — القرار = moduleAccessAllowed ──
const MODULE_GATE_GATES: Gate[] = [
  { name: "posCashierProcedure", moduleKey: "pos", minLevel: "FULL", allowedRoles: ["cashier", "manager"] },
  { name: "salesCashierProcedure", moduleKey: "sales", minLevel: "FULL", allowedRoles: ["cashier", "manager"] },
  { name: "salesManagerProcedure", moduleKey: "sales", minLevel: "FULL", allowedRoles: ["manager"] },
  { name: "purchasesManagerProcedure", moduleKey: "purchases", minLevel: "FULL", allowedRoles: ["manager", "purchasing"] },
  { name: "inventoryWarehouseProcedure", moduleKey: "inventory", minLevel: "FULL", allowedRoles: ["warehouse", "manager"] },
  { name: "inventoryManagerProcedure", moduleKey: "inventory", minLevel: "FULL", allowedRoles: ["manager"] },
  { name: "customersCashierProcedure", moduleKey: "crm", minLevel: "FULL", allowedRoles: ["cashier", "manager", "sales_rep", "print_operator"] },
  { name: "customersManagerProcedure", moduleKey: "crm", minLevel: "FULL", allowedRoles: ["manager"] },
  { name: "crmWriteProcedure", moduleKey: "crm", minLevel: "FULL", allowedRoles: ["cashier", "manager", "sales_rep"] },
  { name: "campaignsManagerProcedure", moduleKey: "campaigns", minLevel: "FULL", allowedRoles: ["manager"] },
  { name: "collectionsManagerProcedure", moduleKey: "collections", minLevel: "FULL", allowedRoles: ["manager", "accountant"] },
  { name: "tasksWriteProcedure", moduleKey: "tasks", minLevel: "FULL", allowedRoles: ["cashier", "manager", "sales_rep", "print_operator"] },
  { name: "tasksManagerProcedure", moduleKey: "tasks", minLevel: "FULL", allowedRoles: ["manager"] },
  { name: "storeFulfillProcedure", moduleKey: "store", minLevel: "FULL", allowedRoles: ["manager", "cashier", "sales_rep"] },
  { name: "storeManagerProcedure", moduleKey: "store", minLevel: "FULL", allowedRoles: ["manager"] },
  { name: "deliveryManagerProcedure", moduleKey: "store", minLevel: "FULL", allowedRoles: ["manager"] },
  { name: "deliveryCashierProcedure", moduleKey: "store", minLevel: "FULL", allowedRoles: ["cashier", "manager"] },
  { name: "suppliersManagerProcedure", moduleKey: "suppliers", minLevel: "FULL", allowedRoles: ["manager", "warehouse", "purchasing"] },
  { name: "consignmentWriteProcedure", moduleKey: "consignments", minLevel: "FULL", allowedRoles: ["warehouse", "manager", "accountant"] },
  { name: "productsManagerProcedure", moduleKey: "products", minLevel: "FULL", allowedRoles: ["manager"] },
  { name: "productsPurchaseProcedure", moduleKey: "products", minLevel: "READ", allowedRoles: ["manager", "warehouse", "purchasing"] },
  { name: "expensesCashierProcedure", moduleKey: "expenses", minLevel: "FULL", allowedRoles: ["cashier", "manager", "accountant"] },
  { name: "expensesManagerProcedure", moduleKey: "expenses", minLevel: "FULL", allowedRoles: ["manager"] },
  { name: "expensesGlobalProcedure", moduleKey: "expenses", minLevel: "FULL", allowedRoles: ["manager", "accountant"] },
  { name: "workordersCashierProcedure", moduleKey: "workorders", minLevel: "FULL", allowedRoles: ["cashier", "manager"] },
  { name: "workordersExecProcedure", moduleKey: "workorders", minLevel: "FULL", allowedRoles: ["cashier", "manager", "print_operator"] },
  { name: "workordersManagerProcedure", moduleKey: "workorders", minLevel: "FULL", allowedRoles: ["manager"] },
  { name: "workordersDirectCancelProcedure", moduleKey: "workorders", minLevel: "FULL", allowedRoles: ["manager", "print_operator"] },
  { name: "treasuryManagerProcedure", moduleKey: "treasury", minLevel: "FULL", allowedRoles: ["manager", "accountant"] },
  { name: "treasuryGlobalProcedure", moduleKey: "treasury", minLevel: "FULL", allowedRoles: ["manager", "accountant"] },
  { name: "treasuryManagerReadProcedure", moduleKey: "treasury", minLevel: "READ", allowedRoles: ["manager", "accountant"] },
  { name: "treasuryGlobalReadProcedure", moduleKey: "treasury", minLevel: "READ", allowedRoles: ["manager", "accountant"] },
  { name: "treasuryCashierProcedure", moduleKey: "treasury", minLevel: "READ", allowedRoles: ["cashier", "manager"] },
  { name: "treasuryHandoverRecipientsProcedure", moduleKey: "treasury", minLevel: "READ", allowedRoles: ["cashier", "manager", "accountant"] },
  { name: "commissionsManagerProcedure", moduleKey: "commissions", minLevel: "FULL", allowedRoles: ["manager"] },
  { name: "reportViewerProcedure", moduleKey: "reports", minLevel: "READ", allowedRoles: ["manager", "accountant", "auditor"] },
  { name: "reportsManagerProcedure", moduleKey: "reports", minLevel: "FULL", allowedRoles: ["manager"] },
  { name: "usersAdminProcedure", moduleKey: "users", minLevel: "FULL", allowedRoles: ["admin"] },
  { name: "settingsAdminProcedure", moduleKey: "settings", minLevel: "FULL", allowedRoles: ["admin"] },
  { name: "courierProcedure", moduleKey: "courier", minLevel: "FULL", allowedRoles: ["courier"] },
  { name: "digitalCardsManagerProcedure", moduleKey: "digital_cards", minLevel: "FULL", allowedRoles: ["manager"] },
  { name: "digitalCardsAdminReadProcedure", moduleKey: "digital_cards", minLevel: "READ", allowedRoles: ["manager", "accountant", "auditor"] },
  { name: "catalogAnomaliesReadProcedure", moduleKey: "catalogAnomalies", minLevel: "READ", allowedRoles: ["manager", "accountant", "auditor"] },
  { name: "catalogAnomaliesManagerProcedure", moduleKey: "catalogAnomalies", minLevel: "FULL", allowedRoles: ["manager"] },
  { name: "announcementsManagerProcedure", moduleKey: "announcements", minLevel: "FULL", allowedRoles: ["manager"] },
  { name: "productStudioAdminProcedure", moduleKey: "productStudio", minLevel: "FULL", allowedRoles: ["manager"] },
];

const ALL_GATES = [...MODULE_MAP_GATES, ...MODULE_GATE_GATES];

/** القرار القائم الذي تُنفّذه البوّابة اليوم (بلا أوفررايد — قوالب الأدوار). */
function currentGateDecision(role: RoleKey, gate: Gate): boolean {
  return gate.allowedRoles === null
    ? hasModuleAccess(role, null, gate.moduleKey, gate.minLevel)
    : moduleAccessAllowed(role, null, gate.moduleKey, gate.minLevel, gate.allowedRoles);
}

/** قرار نموذج القدرات على مستوى الوحدة (null ⇒ الوحدة/المستوى غير مُغطّى بالكتالوج). */
function capDecision(role: RoleKey, gate: Gate): boolean | null {
  const map = resolvePermissions(role, null);
  return capabilityModuleDecision(map, deriveCapabilityGrants(map), gate.moduleKey, gate.minLevel);
}

describe("م٨ · hasCapability يُعيد إنتاج قرار البوّابة القائم لكلّ (دور × قدرة)", () => {
  it("لكلّ دورٍ وكلّ مفتاح قدرة: hasCapability ≡ قرار اليوم — غير الحسّاس بمستواه، والحسّاس يفتحه FULL على الوحدة", () => {
    let pairs = 0;
    for (const role of ALL_ROLES) {
      const map = resolvePermissions(role, null);
      const grants = deriveGrantsForRole(role, null);
      for (const cap of CAPABILITIES) {
        const derived = hasCapability(map, grants, cap.key);
        // اليوم (requireModuleGate): الوحدةُ عند FULL تفتح **كلّ** أفعالها بما فيها الحسّاسة (إلغاء/اعتماد/
        // رؤية التكلفة)، بينما غيرُ الحسّاسة يُشتقّ من مستواه. فالحسّاسُ يُقاس على FULL دائماً مهما كان minLevel
        // (reports:cost.view سرّيّة READ ⇒ قرارها = canSeeCost = reports==FULL، لا مجرّد reports≥READ).
        const current = cap.sensitive
          ? hasModuleAccess(role, null, cap.module, "FULL")
          : hasModuleAccess(role, null, cap.module, cap.minLevel);
        expect(derived, `${role} · ${cap.key}`).toBe(current);
        pairs++;
      }
    }
    // 11 دوراً × 31 قدرة = 341 زوجاً — سجلّ العدد لمعيار «تكافؤ رؤية».
    expect(pairs).toBe(ALL_ROLES.length * CAPABILITIES.length);
    expect(pairs).toBe(341);
  });
});

describe("م٨ · capabilityModuleDecision ≡ hasModuleAccess لكلّ (دور × وحدةٍ مُغطّاة)", () => {
  it("على الوحدات المُغطّاة بالكتالوج، قرارُ القدرات على مستوى الوحدة = قرار الخريطة بالضبط", () => {
    let covered = 0;
    for (const gate of ALL_GATES) {
      for (const role of ALL_ROLES) {
        const cap = capDecision(role, gate);
        if (cap === null) continue; // غير مُغطّى ⇒ لا مقارنة
        covered++;
        expect(cap, `${role} · ${gate.moduleKey}/${gate.minLevel}`).toBe(
          hasModuleAccess(role, null, gate.moduleKey, gate.minLevel),
        );
      }
    }
    expect(covered).toBeGreaterThan(0);
  });
});

describe("م٨ · الوصلُ ظِلٌّ: صفر تغييرٍ في القرار (OFF/ON) + صفر توسيعِ وصول", () => {
  it("moduleGateShadowDecision.allow = قرارُ البوّابة **دائماً** لكلّ (دور × بوّابة × حالتَي العلَم)", () => {
    let pairs = 0;
    for (const gate of ALL_GATES) {
      for (const role of ALL_ROLES) {
        const gateAllowed = currentGateDecision(role, gate);
        const cap = capDecision(role, gate);
        for (const flag of [false, true]) {
          const shadow = moduleGateShadowDecision(gateAllowed, cap, flag);
          // القرار المُنفَّذ لا يتغيّر أبداً بتفعيل العلَم — لا توسيعٌ ولا تضييق (صفر انحدار).
          expect(shadow.allow, `${role} · ${gate.name} · flag=${flag}`).toBe(gateAllowed);
          pairs++;
        }
      }
    }
    expect(pairs).toBe(ALL_GATES.length * ALL_ROLES.length * 2);
  });

  it("القدرات لا تحجب أبداً ما تسمح به البوّابة (لا cap=false مع gate=true) على الوحدات المُغطّاة", () => {
    for (const gate of ALL_GATES) {
      for (const role of ALL_ROLES) {
        const cap = capDecision(role, gate);
        if (cap === null) continue;
        const gateAllowed = currentGateDecision(role, gate);
        // الاتّجاه الخطر عند الإنفاذ المستقبليّ (AND) هو أن تُغلق القدراتُ وصولاً مسموحاً ⇒ نمنعه هنا.
        expect(cap === false && gateAllowed === true, `${role} · ${gate.name}`).toBe(false);
      }
    }
  });

  it("بوّابات الخريطة المحضة (requireModule): قرارُ القدرات = قرار البوّابة **بالضبط** (تكافؤ رؤية تامّ)", () => {
    for (const gate of MODULE_MAP_GATES) {
      for (const role of ALL_ROLES) {
        const cap = capDecision(role, gate);
        if (cap === null) continue;
        expect(cap, `${role} · ${gate.name}`).toBe(currentGateDecision(role, gate));
      }
    }
  });

  it("كلُّ تباينٍ هو خشونةُ «الوحدة أوسع من قائمة أدوار النقطة» (cap=true, gate=false) — لا تباين خطر", () => {
    const divergences: string[] = [];
    for (const gate of ALL_GATES) {
      for (const role of ALL_ROLES) {
        const cap = capDecision(role, gate);
        if (cap === null) continue;
        const gateAllowed = currentGateDecision(role, gate);
        if (cap === gateAllowed) continue;
        // التباين الوحيد المسموح: قدرةٌ تسمح (الوحدة FULL/READ في القالب) وبوّابةٌ تمنع (الدور خارج القائمة).
        expect(cap === true && gateAllowed === false, `${role} · ${gate.name}`).toBe(true);
        // ولا يقع إلّا على بوّابات قائمة الأدوار (moduleProcedure)، لا على الخريطة المحضة.
        expect(gate.allowedRoles, `${role} · ${gate.name}`).not.toBeNull();
        divergences.push(`${role} · ${gate.name}`);
      }
    }
    // التباينات موجودةٌ ومقصودة (خشونةُ نموذجٍ على مستوى الوحدة)؛ الوصلُ الظِلّيّ يسجّلها ولا يُنفِذها.
    expect(divergences.length).toBeGreaterThan(0);
  });
});

describe("م٨ · دلالةُ العلَم", () => {
  it("capabilitiesEnabled معطَّلٌ افتراضياً وبـ0؛ مفعَّلٌ بـ1/true", () => {
    expect(capabilitiesEnabled({})).toBe(false);
    expect(capabilitiesEnabled({ RBAC_CAPABILITIES: "0" })).toBe(false);
    expect(capabilitiesEnabled({ RBAC_CAPABILITIES: "1" })).toBe(true);
    expect(capabilitiesEnabled({ RBAC_CAPABILITIES: "true" })).toBe(true);
  });

  it("العلَم معطَّل ⇒ لا تباين يُسجَّل قطّ (moduleGateShadowDecision.divergence=false)", () => {
    for (const gate of ALL_GATES) {
      for (const role of ALL_ROLES) {
        const gateAllowed = currentGateDecision(role, gate);
        const cap = capDecision(role, gate);
        expect(moduleGateShadowDecision(gateAllowed, cap, false).divergence).toBe(false);
      }
    }
  });
});

// ── تصحيحُ مراجعة Codex على PR #1026 (تتبّع الظلّ لا مسار القرار) ────────────────────────────────
describe("م٨ · وضعُ الظلّ الموثَّق يُشغَّل بـAUTHZ_ENGINE=shadow (تصحيح Codex P1 · #1026)", () => {
  it("capabilityShadowEnabled: مفعَّلٌ بـshadow (حتى بحالةٍ/فراغٍ)، معطَّلٌ في غيره", () => {
    expect(capabilityShadowEnabled({})).toBe(false);
    expect(capabilityShadowEnabled({ AUTHZ_ENGINE: "shadow" })).toBe(true);
    expect(capabilityShadowEnabled({ AUTHZ_ENGINE: "SHADOW" })).toBe(true);
    expect(capabilityShadowEnabled({ AUTHZ_ENGINE: " shadow " })).toBe(true);
    expect(capabilityShadowEnabled({ AUTHZ_ENGINE: "off" })).toBe(false);
    expect(capabilityShadowEnabled({ AUTHZ_ENGINE: "dual" })).toBe(false);
    expect(capabilityShadowEnabled({ AUTHZ_ENGINE: "on" })).toBe(false);
  });

  it("الظلّ منفصلٌ عن الإنفاذ: RBAC_CAPABILITIES لا يُشغّل الظلّ، وshadow لا يُشغّل الإنفاذ", () => {
    // جوهرُ التصحيح: كان الظلّ مربوطاً بـRBAC_CAPABILITIES (الممنوع رفعُه) ⇒ لا مسارَ تتبّعٍ قابلاً للتنفيذ.
    expect(capabilityShadowEnabled({ RBAC_CAPABILITIES: "1" })).toBe(false);
    expect(capabilityShadowEnabled({ RBAC_CAPABILITIES: "true" })).toBe(false);
    // والعكس: وضعُ الظلّ لا يفعّل علَمَ الإنفاذ المستقبليّ — مساران منفصلان.
    expect(capabilitiesEnabled({ AUTHZ_ENGINE: "shadow" })).toBe(false);
    expect(capabilitiesEnabled({ RBAC_CAPABILITIES: "1" })).toBe(true);
  });
});

describe("م٨ · تصنيفُ الظلّ يُميّز «فوات التغطية» عن «التطابق» (تصحيح Codex P1 · #1026)", () => {
  it("classifyCapabilityShadow: null⇒uncovered · متساوٍ⇒match · مختلف⇒divergence", () => {
    expect(classifyCapabilityShadow(true, null)).toBe("uncovered");
    expect(classifyCapabilityShadow(false, null)).toBe("uncovered");
    expect(classifyCapabilityShadow(true, true)).toBe("match");
    expect(classifyCapabilityShadow(false, false)).toBe("match");
    expect(classifyCapabilityShadow(true, false)).toBe("divergence");
    expect(classifyCapabilityShadow(false, true)).toBe("divergence");
  });

  it("البوّاباتُ غيرُ المُغطّاة (purchases كلّها · expenses/READ · reports/FULL) ⇒ uncovered لا match", () => {
    // هذه بالضبط الحالات التي كانت تُحسَب «تطابقاً مُتحقَّقاً» زوراً قبل التصحيح (divergence=false بلا حدث).
    const uncoveredGates: Gate[] = [
      { name: "purchasesReadProcedure", moduleKey: "purchases", minLevel: "READ", allowedRoles: null },
      { name: "purchasesManagerProcedure", moduleKey: "purchases", minLevel: "FULL", allowedRoles: ["manager", "purchasing"] },
      { name: "expensesReadProcedure", moduleKey: "expenses", minLevel: "READ", allowedRoles: null },
      { name: "reportsManagerProcedure", moduleKey: "reports", minLevel: "FULL", allowedRoles: ["manager"] },
    ];
    for (const gate of uncoveredGates) {
      for (const role of ALL_ROLES) {
        const cap = capDecision(role, gate);
        expect(cap, `${role} · ${gate.name} — مُتوقَّعٌ غير مُغطّى`).toBeNull();
        expect(classifyCapabilityShadow(currentGateDecision(role, gate), cap)).toBe("uncovered");
      }
    }
  });

  it("كلُّ بوّابةٍ مُغطّاة (cap!==null) ⇒ match أو divergence، ولا uncovered", () => {
    for (const gate of ALL_GATES) {
      for (const role of ALL_ROLES) {
        const cap = capDecision(role, gate);
        if (cap === null) continue;
        const outcome = classifyCapabilityShadow(currentGateDecision(role, gate), cap);
        expect(outcome === "uncovered", `${role} · ${gate.name}`).toBe(false);
        // التصنيف يتّسق مع moduleGateShadowDecision (المصدر المُثبَّت للـallow-invariant): divergence⇔divergence.
        const shadow = moduleGateShadowDecision(currentGateDecision(role, gate), cap, true);
        expect(outcome === "divergence").toBe(shadow.divergence);
      }
    }
  });
});
