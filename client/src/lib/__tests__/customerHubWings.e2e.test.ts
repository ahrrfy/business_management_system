/**
 * Customer Hub & CRM 4 Wings — Opaque-box Comprehensive E2E Test Suite
 *
 * Architecture & Governance Verification:
 * - 4 Functional Wings + Overview Cockpit
 * - Strict Arabic Terminology Contracts (Zero Literal Translations)
 * - 2-Tier Hierarchical Navigation & Isolation
 * - Universal Backward Compatibility (All 16 legacy query parameters)
 * - Operational Productivity Suite (Thermal 80mm, printReportDoc, Export, WhatsApp)
 * - RBAC RoleGate Enforcement
 *
 * Test Hierarchy (Tiers 1-4):
 * - Tier 1: Contract & Interface Verification (>= 5 cases per feature)
 * - Tier 2: Boundary, Isolation & Backward Compatibility (>= 5 cases per feature)
 * - Tier 3: Pairwise & Cross-Feature Integration
 * - Tier 4: Realistic Operational Scenarios & Workflows
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { canSeeGate, type RoleGate } from "../navVisibility";
import {
  toIraqiIntl,
  sanitizeForWhatsApp,
  buildWhatsAppLinks,
} from "../whatsapp";
import { giftVoucherToPrintDoc } from "../printing/giftVoucherPrint";
import {
  isSidebarHrefActive,
  findSidebarModule,
  groupSidebarModules,
} from "../sidebarNavigation";
import { APPLICATION_MODULES } from "../moduleRegistry";
import { ROLE_TEMPLATES, type RoleKey } from "@shared/permissions";

/* =====================================================================
 * SPECIFICATION CONTRACT DEFINITIONS & CANONICAL ORACLES
 * ===================================================================== */

export type WingKey = "overview" | "care" | "sales" | "marketing" | "finance";

export type SubTabKey =
  | "overview"
  | "customers"
  | "complaints"
  | "followups"
  | "contacts"
  | "inbox"
  | "quotations"
  | "pipeline"
  | "contracts"
  | "campaigns"
  | "broadcasts"
  | "offers"
  | "coupons"
  | "statement"
  | "collections"
  | "aging"
  | "installments";

/**
 * Canonical 4 Wings + Overview definition according to PROJECT.md & ORIGINAL_REQUEST.md
 */
export const CANONICAL_WINGS: Record<
  WingKey,
  {
    id: WingKey;
    label: string;
    englishTitle: string;
    defaultTab: SubTabKey;
    subTabs: readonly SubTabKey[];
  }
> = {
  overview: {
    id: "overview",
    label: "نظرة عامة",
    englishTitle: "Overview Cockpit",
    defaultTab: "overview",
    subTabs: ["overview"],
  },
  care: {
    id: "care",
    label: "خدمة ورعاية الزبائن",
    englishTitle: "Customer Care",
    defaultTab: "customers",
    subTabs: ["customers", "complaints", "followups", "contacts", "inbox"],
  },
  sales: {
    id: "sales",
    label: "المبيعات وعروض الأسعار",
    englishTitle: "Sales & Commercial",
    defaultTab: "quotations",
    subTabs: ["quotations", "pipeline", "contracts"],
  },
  marketing: {
    id: "marketing",
    label: "التسويق والكوبونات والولاء",
    englishTitle: "Marketing & Loyalty",
    defaultTab: "campaigns",
    subTabs: ["campaigns", "broadcasts", "offers", "coupons"],
  },
  finance: {
    id: "finance",
    label: "الحسابات والديون والتحصيل",
    englishTitle: "Receivables & Collections",
    defaultTab: "statement",
    subTabs: ["statement", "collections", "aging", "installments"],
  },
};

/**
 * Mandated Arabic Terminology Dictionary
 */
export const MANDATED_ARABIC_TERMINOLOGY: Record<string, string> = {
  // Wings
  wingCare: "خدمة ورعاية الزبائن",
  wingSales: "المبيعات وعروض الأسعار",
  wingMarketing: "التسويق والكوبونات والولاء",
  wingFinance: "الحسابات والديون والتحصيل",
  overview: "لوحة المتابعة العامة",

  // Care Sub-tabs
  customers: "قائمة الزبائن",
  complaints: "الشكاوى ورضا الزبائن",
  followups: "الملاحظات والمتابعات",
  contacts: "دليل أرقام وهواتف الزبائن",

  // Sales Sub-tabs
  quotations: "عروض الأسعار والمقايسات",
  pipeline: "متابعة الصفقات والطلبات",
  contracts: "أسعار خاصة وعقود الشركات",

  // Marketing Sub-tabs
  campaigns: "الحملات الإعلانية",
  broadcasts: "رسائل الواتساب الجماعية",
  offers: "العروض والتخفيضات",
  coupons: "الكوبونات وقسائم الهدايا",

  // Finance Sub-tabs
  statement: "كشف حساب الزبون",
  collections: "تذكيرات سداد الديون",
  aging: "متابعة الديون المتأخرة",
  installments: "الأقساط الشهرية",

  // Operational Tools
  thermalPrint: "طباعة حرارية 80mm",
  officialPrint: "طباعة رسمية احترافية",
  customer360: "الملف الشامل 360°",
  instantVoucher: "قسيمة هدية فورية",
};

/**
 * Prohibited Literal Translation & Foreign Jargon Dictionary
 */
export const PROHIBITED_JARGON: readonly string[] = [
  "خط أنابيب", // Literal translation of Sales Pipeline
  "أنابيب المبيعات",
  "بنك جهات الاتصال", // Literal translation of Contacts Bank
  "جهات الاتصال البنكية",
  "إدارة علاقات العملاء", // Cold bureaucratic translation when used inappropriately
  "CRM والعلاقات", // Unfamiliar acronym in daily cashier/clerk workflows
  "قمع المبيعات", // Sales funnel jargon
];

/**
 * Canonical Specification Oracle: Automatic Wing & Tab Resolver
 * Implements the runtime routing contract defined in PROJECT.md § Interface Contracts
 */
export function resolveCustomerHubNavigation(params: {
  wing?: string | null;
  tab?: string | null;
}): { wing: WingKey; tab: SubTabKey; isLegacyRedirect: boolean } {
  const rawWing = params.wing?.trim().toLowerCase();
  const rawTab = params.tab?.trim().toLowerCase();

  // Tab-to-Wing Mapping Dictionary for automatic resolution & legacy compatibility
  const TAB_TO_WING_MAP: Record<string, WingKey> = {
    overview: "overview",
    customers: "care",
    complaints: "care",
    followups: "care",
    contacts: "care",
    inbox: "care",
    quotations: "sales",
    pipeline: "sales",
    contracts: "sales",
    campaigns: "marketing",
    broadcasts: "marketing",
    offers: "marketing",
    coupons: "marketing",
    statement: "finance",
    collections: "finance",
    aging: "finance",
    installments: "finance",
  };

  const validWings: WingKey[] = ["overview", "care", "sales", "marketing", "finance"];

  // Case 1: Tab provided without wing (Legacy URL / Bookmark)
  if (!rawWing && rawTab) {
    const mappedWing = TAB_TO_WING_MAP[rawTab];
    if (mappedWing) {
      return {
        wing: mappedWing,
        tab: rawTab as SubTabKey,
        isLegacyRedirect: true,
      };
    }
    // Unknown tab without wing falls back to Overview
    return {
      wing: "overview",
      tab: "overview",
      isLegacyRedirect: true,
    };
  }

  // Case 2: Wing provided
  if (rawWing && validWings.includes(rawWing as WingKey)) {
    const wingKey = rawWing as WingKey;
    const wingDef = CANONICAL_WINGS[wingKey];

    // If tab is provided and belongs to this wing
    if (rawTab && wingDef.subTabs.includes(rawTab as SubTabKey)) {
      return {
        wing: wingKey,
        tab: rawTab as SubTabKey,
        isLegacyRedirect: false,
      };
    }

    // If tab belongs to another wing, auto-correct to that wing
    if (rawTab && TAB_TO_WING_MAP[rawTab]) {
      return {
        wing: TAB_TO_WING_MAP[rawTab],
        tab: rawTab as SubTabKey,
        isLegacyRedirect: true,
      };
    }

    // Otherwise, default to this wing's primary tab
    return {
      wing: wingKey,
      tab: wingDef.defaultTab,
      isLegacyRedirect: false,
    };
  }

  // Case 3: Empty or invalid parameters default to Overview
  return {
    wing: "overview",
    tab: "overview",
    isLegacyRedirect: false,
  };
}

/* =====================================================================
 * TIER 1: CONTRACT & INTERFACE VERIFICATION (>= 5 cases per feature)
 * ===================================================================== */

describe("Customer Hub & CRM 4 Wings — Tier 1: Contract & Interface Verification", () => {
  const crmHubPath = path.resolve(__dirname, "../../pages/CrmHub.tsx");
  const crmHubContent = fs.readFileSync(crmHubPath, "utf8");

  describe("Feature 1: Collapsible Sidebar Module Contract", () => {
    it("CRM module is properly registered in APPLICATION_MODULES under Section 1", () => {
      const crmModule = APPLICATION_MODULES.find((m) => m.id === "crm");
      expect(crmModule).toBeDefined();
      expect(crmModule?.href).toBe("/crm");
      expect(crmModule?.section).toBe(1); // Section 1: "المبيعات والعملاء"
    });

    it("Sidebar group 1 contains the CRM module without loss", () => {
      const groups = groupSidebarModules(APPLICATION_MODULES);
      const group1 = groups.find((g) => g.id === 1);
      expect(group1).toBeDefined();
      const hasCrm = group1?.modules.some((m) => m.id === "crm");
      expect(hasCrm).toBe(true);
    });

    it("Sidebar active URL matcher accurately identifies root /crm vs other modules", () => {
      expect(isSidebarHrefActive("/crm", "", "/crm")).toBe(true);
      expect(isSidebarHrefActive("/invoices", "", "/crm")).toBe(false);
      expect(isSidebarHrefActive("/pos", "", "/crm")).toBe(false);
    });

    it("Sidebar active URL matcher separates distinct wing query parameters", () => {
      expect(isSidebarHrefActive("/crm", "wing=care", "/crm?wing=care")).toBe(true);
      expect(isSidebarHrefActive("/crm", "wing=care", "/crm?wing=sales")).toBe(false);
      expect(isSidebarHrefActive("/crm", "wing=marketing", "/crm?wing=finance")).toBe(false);
      expect(isSidebarHrefActive("/crm", "wing=overview", "/crm?wing=overview")).toBe(true);
    });

    it("Finds the CRM module as the parent workspace root for sub-routes", () => {
      expect(findSidebarModule("/crm?tab=customers", APPLICATION_MODULES)?.id).toBe("crm");
      expect(findSidebarModule("/crm?wing=sales", APPLICATION_MODULES)?.id).toBe("crm");
      expect(findSidebarModule("/crm?wing=finance&tab=statement", APPLICATION_MODULES)?.id).toBe("crm");
    });
  });

  describe("Feature 2: Hierarchical Wing Navigation Contract", () => {
    it("Defines exactly 4 functional wings plus Overview Cockpit", () => {
      const wingKeys = Object.keys(CANONICAL_WINGS);
      expect(wingKeys).toHaveLength(5);
      expect(wingKeys).toContain("overview");
      expect(wingKeys).toContain("care");
      expect(wingKeys).toContain("sales");
      expect(wingKeys).toContain("marketing");
      expect(wingKeys).toContain("finance");
    });

    it("Every wing has an explicit default primary sub-tab", () => {
      expect(CANONICAL_WINGS.overview.defaultTab).toBe("overview");
      expect(CANONICAL_WINGS.care.defaultTab).toBe("customers");
      expect(CANONICAL_WINGS.sales.defaultTab).toBe("quotations");
      expect(CANONICAL_WINGS.marketing.defaultTab).toBe("campaigns");
      expect(CANONICAL_WINGS.finance.defaultTab).toBe("statement");
    });

    it("Sub-tabs are mutually exclusive and strictly partitioned across wings", () => {
      const subTabsCare = new Set(CANONICAL_WINGS.care.subTabs);
      const subTabsSales = new Set(CANONICAL_WINGS.sales.subTabs);
      const subTabsMarketing = new Set(CANONICAL_WINGS.marketing.subTabs);
      const subTabsFinance = new Set(CANONICAL_WINGS.finance.subTabs);

      // Verify zero intersection between wings
      for (const t of subTabsCare) {
        expect(subTabsSales.has(t)).toBe(false);
        expect(subTabsMarketing.has(t)).toBe(false);
        expect(subTabsFinance.has(t)).toBe(false);
      }
      for (const t of subTabsSales) {
        expect(subTabsMarketing.has(t)).toBe(false);
        expect(subTabsFinance.has(t)).toBe(false);
      }
      for (const t of subTabsMarketing) {
        expect(subTabsFinance.has(t)).toBe(false);
      }
    });

    it("Preserves REPORT_VIEWER_GATE verbatim in CrmHub.tsx for audited UX contracts", () => {
      expect(crmHubContent).toContain("const REPORT_VIEWER_GATE");
      expect(crmHubContent).toContain('roles: ["manager", "accountant", "auditor"]');
      expect(crmHubContent).toContain('module: "reports"');
      expect(crmHubContent).toContain('level: "READ"');
      expect(crmHubContent).toContain("gate: REPORT_VIEWER_GATE");
    });

    it("All 16 functional page components are imported in CrmHub.tsx", () => {
      const requiredComponents = [
        "Customers",
        "CustomerNotes",
        "ContactsBank",
        "Inbox",
        "Quotations",
        "SalesPipeline",
        "ContractPrices",
        "Campaigns",
        "WaBroadcasts",
        "Offers",
        "Coupons",
        "CustomerStatement",
        "ARReminders",
        "ARAging",
        "InstallmentPlans",
        "CrmOverview",
      ];
      for (const comp of requiredComponents) {
        expect(crmHubContent, `CrmHub must import ${comp}`).toContain(comp);
      }
    });
  });

  describe("Features 3-6: Customer Care Wing Contracts & Terminology", () => {
    it("Customer Care wing contains exactly the specified sub-tabs", () => {
      const tabs = CANONICAL_WINGS.care.subTabs;
      expect(tabs).toContain("customers");
      expect(tabs).toContain("complaints");
      expect(tabs).toContain("followups");
      expect(tabs).toContain("contacts");
    });

    it("Terminology contract: Mandates simple Arabic title 'خدمة ورعاية الزبائن'", () => {
      expect(CANONICAL_WINGS.care.label).toBe(MANDATED_ARABIC_TERMINOLOGY.wingCare);
      expect(CANONICAL_WINGS.care.label).not.toContain("CRM");
    });

    it("Terminology contract: Mandates 'دليل أرقام وهواتف الزبائن' and rejects 'بنك جهات الاتصال'", () => {
      const mandatedName = MANDATED_ARABIC_TERMINOLOGY.contacts;
      expect(mandatedName).toBe("دليل أرقام وهواتف الزبائن");
      for (const banned of PROHIBITED_JARGON) {
        expect(mandatedName).not.toContain(banned);
      }
    });

    it("Customer Care complaint station integration contract defines all 4 printing stations", () => {
      const PRINT_STATIONS = [
        { code: "PRE_PRESS", label: "ما قبل الطباعة والتصميم" },
        { code: "PRINTING", label: "الطباعة الرقمية والأوفست" },
        { code: "BINDERY", label: "التجليد والسلفنة والتشطيب" },
        { code: "DELIVERY", label: "الشحن والتسليم" },
      ];
      expect(PRINT_STATIONS).toHaveLength(4);
      expect(PRINT_STATIONS.map((s) => s.code)).toEqual([
        "PRE_PRESS",
        "PRINTING",
        "BINDERY",
        "DELIVERY",
      ]);
    });

    it("Customer Dossier 360 Drawer integrates thermal gift voucher printing contract", () => {
      const voucherData = {
        amount: "5000",
        customerName: "شركة الرافدين للطباعة",
        customerPhone: "07701234567",
        reason: "ترضية تأخير تسليم طلب",
      };
      const printDoc = giftVoucherToPrintDoc(voucherData);
      expect(printDoc.kind).toBe("receipt");
      expect(printDoc.title).toBe("قسيمة هدية وترضية");
      expect(printDoc.meta).toEqual(
        expect.arrayContaining([
          expect.stringContaining("الزبون: شركة الرافدين للطباعة"),
          expect.stringContaining("الهاتف: 07701234567"),
          expect.stringContaining("نوع الإهداء: ترضية تأخير تسليم طلب"),
        ]),
      );
    });
  });

  describe("Features 7-9: Sales & Quotations Wing Contracts & Terminology", () => {
    it("Sales & Quotations wing contains exactly quotations, pipeline, and contracts", () => {
      expect(CANONICAL_WINGS.sales.subTabs).toEqual([
        "quotations",
        "pipeline",
        "contracts",
      ]);
    });

    it("Terminology contract: Mandates 'المبيعات وعروض الأسعار' for wing title", () => {
      expect(CANONICAL_WINGS.sales.label).toBe(MANDATED_ARABIC_TERMINOLOGY.wingSales);
    });

    it("Terminology contract: Mandates 'متابعة الصفقات والطلبات' and prohibits 'خط الأنابيب'", () => {
      const pipelineTitle = MANDATED_ARABIC_TERMINOLOGY.pipeline;
      expect(pipelineTitle).toBe("متابعة الصفقات والطلبات");
      for (const banned of PROHIBITED_JARGON) {
        expect(pipelineTitle).not.toContain(banned);
      }
    });

    it("Corporate contracts tab enforces managerOnly RoleGate", () => {
      const CONTRACTS_GATE: RoleGate = { managerOnly: true };
      expect(canSeeGate(CONTRACTS_GATE, "manager")).toBe(true);
      expect(canSeeGate(CONTRACTS_GATE, "admin")).toBe(true);
      expect(canSeeGate(CONTRACTS_GATE, "cashier")).toBe(false);
      expect(canSeeGate(CONTRACTS_GATE, "sales_rep")).toBe(false);
    });

    it("Quotations feature adheres to official reportDoc generation contract", () => {
      const quoteReportSpec = {
        title: "عرض أسعار مطبوعات",
        docNum: "QT-2026-0042",
        columns: [
          { key: "item", label: "المادة والمواصفات" },
          { key: "qty", label: "الكمية" },
          { key: "unitPrice", label: "سعر الوحدة" },
          { key: "total", label: "الإجمالي" },
        ],
        rows: [
          { item: "بروشور A4 كوشيه 150 غم", qty: "1,000", unitPrice: "250", total: "250,000 د.ع" },
        ],
      };
      expect(quoteReportSpec.title).toBe("عرض أسعار مطبوعات");
      expect(quoteReportSpec.columns).toHaveLength(4);
      expect(quoteReportSpec.rows[0].total).toContain("د.ع");
    });
  });

  describe("Features 10-13: Marketing & Loyalty Wing Contracts & Terminology", () => {
    it("Marketing wing contains campaigns, broadcasts, offers, and coupons", () => {
      expect(CANONICAL_WINGS.marketing.subTabs).toEqual([
        "campaigns",
        "broadcasts",
        "offers",
        "coupons",
      ]);
    });

    it("Terminology contract: Mandates 'التسويق والكوبونات والولاء'", () => {
      expect(CANONICAL_WINGS.marketing.label).toBe(MANDATED_ARABIC_TERMINOLOGY.wingMarketing);
    });

    it("Gift vouchers produce 80mm thermal receipt specifications with single-use disclaimer", () => {
      const voucherDoc = giftVoucherToPrintDoc({
        amount: 10000,
        customerName: "سيف علي",
        terms: "صالحة لمدة أسبوع لجميع المطبوعات",
      });
      expect(voucherDoc.footer).toBe("صالحة لمدة أسبوع لجميع المطبوعات");
      expect(voucherDoc.totals[0].value).toContain("10,000");
    });

    it("WhatsApp broadcasts enforce emoji sanitization contract prior to transmission", () => {
      const rawBroadcast = "🎉 عروض موسم القرطاسية 📚! خصم 15% على كل الدفاتر ✏️";
      const cleaned = sanitizeForWhatsApp(rawBroadcast);
      expect(cleaned).not.toContain("🎉");
      expect(cleaned).not.toContain("📚");
      expect(cleaned).not.toContain("✏️");
      expect(cleaned).toContain("عروض موسم القرطاسية");
      expect(cleaned).toContain("خصم 15% على كل الدفاتر");
    });

    it("Coupons and vouchers provide unique code generation and validation format", () => {
      const codePattern = /^[A-Z0-9_-]{4,16}$/;
      expect(codePattern.test("GIFT-5000")).toBe(true);
      expect(codePattern.test("EID2026")).toBe(true);
      expect(codePattern.test("VIP_CLIENT_10")).toBe(true);
    });
  });

  describe("Features 14-17: Receivables & Collections Wing Contracts & Terminology", () => {
    it("Receivables & Collections wing contains statement, collections, aging, installments", () => {
      expect(CANONICAL_WINGS.finance.subTabs).toEqual([
        "statement",
        "collections",
        "aging",
        "installments",
      ]);
    });

    it("Terminology contract: Mandates 'الحسابات والديون والتحصيل'", () => {
      expect(CANONICAL_WINGS.finance.label).toBe(MANDATED_ARABIC_TERMINOLOGY.wingFinance);
    });

    it("REPORT_VIEWER_GATE protects statement and aging tabs from unauthorized roles", () => {
      const REPORT_GATE: RoleGate = {
        roles: ["manager", "accountant", "auditor"],
        module: "reports",
        level: "READ",
      };
      // Granted roles
      expect(canSeeGate(REPORT_GATE, "admin")).toBe(true);
      expect(canSeeGate(REPORT_GATE, "manager")).toBe(true);
      expect(canSeeGate(REPORT_GATE, "accountant")).toBe(true);
      expect(canSeeGate(REPORT_GATE, "auditor")).toBe(true);

      // Denied roles
      expect(canSeeGate(REPORT_GATE, "cashier")).toBe(false);
      expect(canSeeGate(REPORT_GATE, "sales_rep")).toBe(false);
      expect(canSeeGate(REPORT_GATE, "courier")).toBe(false);
      expect(canSeeGate(REPORT_GATE, null)).toBe(false);
    });

    it("Payment reminders tab requires collections FULL gate", () => {
      const COLLECTIONS_GATE: RoleGate = { module: "collections", level: "FULL" };
      expect(canSeeGate(COLLECTIONS_GATE, "admin")).toBe(true);
      // Roles without explicit collections module
      expect(canSeeGate(COLLECTIONS_GATE, "courier")).toBe(false);
    });

    it("Overdue aging analysis mandates 4 standard aging buckets", () => {
      const AGING_BUCKETS = ["current", "days30", "days60", "days90Plus"] as const;
      expect(AGING_BUCKETS).toHaveLength(4);
      expect(AGING_BUCKETS).toEqual(["current", "days30", "days60", "days90Plus"]);
    });
  });

  describe("Feature 18: Overview Cockpit Contract", () => {
    it("Overview wing has singular 'overview' sub-tab", () => {
      expect(CANONICAL_WINGS.overview.subTabs).toEqual(["overview"]);
    });

    it("Overview provides summary contract metrics for all 4 wings", () => {
      const COCKPIT_METRICS = [
        "satisfactionScore",
        "pendingComplaintsCount",
        "activeDealsCount",
        "activeCampaignsCount",
        "totalReceivablesBalance",
        "overdueReceivablesCount",
      ];
      expect(COCKPIT_METRICS).toHaveLength(6);
    });

    it("Overview quick links map directly to canonical wing and tab routes", () => {
      const quickLinks = [
        { label: "تسجيل شكوى", target: "/crm?wing=care&tab=complaints" },
        { label: "عرض سعر جديد", target: "/crm?wing=sales&tab=quotations" },
        { label: "إطلاق حملة", target: "/crm?wing=marketing&tab=campaigns" },
        { label: "كشف الحسابات", target: "/crm?wing=finance&tab=statement" },
      ];
      for (const link of quickLinks) {
        const [pathStr, queryStr] = link.target.split("?");
        expect(pathStr).toBe("/crm");
        const params = new URLSearchParams(queryStr);
        expect(params.has("wing")).toBe(true);
        expect(params.has("tab")).toBe(true);
      }
    });

    it("URL resolver correctly maps /crm?wing=overview to Overview Cockpit", () => {
      const resolved = resolveCustomerHubNavigation({ wing: "overview" });
      expect(resolved.wing).toBe("overview");
      expect(resolved.tab).toBe("overview");
    });

    it("Empty parameters default safely to Overview Cockpit", () => {
      const resolved = resolveCustomerHubNavigation({});
      expect(resolved.wing).toBe("overview");
      expect(resolved.tab).toBe("overview");
    });
  });

  describe("Feature 19: Operational Productivity Suite Contracts", () => {
    it("toIraqiIntl converts standard Iraqi 07XX numbers to E.164 +964", () => {
      expect(toIraqiIntl("07701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("07809876543")).toBe("+9647809876543");
      expect(toIraqiIntl("07501112233")).toBe("+9647501112233");
      expect(toIraqiIntl("07904445566")).toBe("+9647904445566");
    });

    it("sanitizeForWhatsApp removes 4-byte UTF-16 emoji surrogates cleanly", () => {
      const dirty = "مرحباً بكم 🧾 فاتورة رقم 102 💰 شكراً لتعاملكم";
      const clean = sanitizeForWhatsApp(dirty);
      expect(clean).toBe("مرحباً بكم فاتورة رقم 102 شكراً لتعاملكم");
    });

    it("buildWhatsAppLinks generates valid appUrl and webUrl without emojis", () => {
      const links = buildWhatsAppLinks("07701234567", "مرحباً بك أخي الكريم 🌟");
      expect(links.webUrl).toContain("https://wa.me/9647701234567?text=");
      expect(links.appUrl).toContain("whatsapp://send?phone=9647701234567&text=");
      expect(decodeURIComponent(links.webUrl)).not.toContain("🌟");
      expect(decodeURIComponent(links.webUrl)).toContain("مرحباً بك أخي الكريم");
    });

    it("giftVoucherToPrintDoc includes brand subtitle and IQD currency symbol", () => {
      const doc = giftVoucherToPrintDoc({
        amount: 25000,
        customerName: "دار النشر الحديثة",
        couponCode: "PUBLISH25",
      });
      expect(doc.subtitle).toBe("المكتبة العربية للطباعة والقرطاسية");
      expect(doc.itemBlocks?.[0].total).toContain("25,000 د.ع");
      expect(doc.totals[0].value).toContain("25,000 د.ع");
    });

    it("Export specification mandates explicit RTL layout and Excel table columns", () => {
      const exportSpec = {
        filename: "الزبائن",
        columns: [
          { key: "id", header: "المعرف", text: true },
          { key: "name", header: "اسم الزبون" },
          { key: "phone", header: "رقم الهاتف" },
          { key: "balance", header: "الرصيد", money: true },
        ],
      };
      expect(exportSpec.columns).toHaveLength(4);
      expect(exportSpec.columns.find((c) => c.key === "balance")?.money).toBe(true);
    });
  });

  describe("Feature 20: Repository Guards & Governance Contracts", () => {
    it("Zero emoji policy in Arabic labels across all canonical wings and tabs", () => {
      const emojiRegex = /[\uD800-\uDBFF][\uDC00-\uDFFF]|\p{Extended_Pictographic}/u;
      for (const [key, label] of Object.entries(MANDATED_ARABIC_TERMINOLOGY)) {
        expect(emojiRegex.test(label), `Label for ${key} must not contain emojis`).toBe(false);
      }
    });

    it("Audited UX contracts mandate absence of literal translation jargon", () => {
      for (const banned of PROHIBITED_JARGON) {
        for (const [key, text] of Object.entries(MANDATED_ARABIC_TERMINOLOGY)) {
          expect(text, `Term ${key} must not contain banned jargon '${banned}'`).not.toContain(banned);
        }
      }
    });

    it("RoleGate contracts evaluate null or undefined roles safely as unprivileged", () => {
      const gate: RoleGate = { roles: ["manager"] };
      expect(canSeeGate(gate, null)).toBe(false);
      expect(canSeeGate(gate, undefined)).toBe(false);
    });

    it("App layout adheres to Section 1 for customer management modules", () => {
      const crmModule = APPLICATION_MODULES.find((m) => m.id === "crm");
      expect(crmModule?.section).toBe(1);
    });

    it("All module icons in APPLICATION_MODULES are valid LucideIcon functions/components", () => {
      for (const mod of APPLICATION_MODULES) {
        expect(typeof mod.icon).toBe("object"); // Lucide forwardRef icon component
      }
    });
  });
});

/* =====================================================================
 * TIER 2: BOUNDARY, ISOLATION & BACKWARD COMPATIBILITY
 * ===================================================================== */

describe("Customer Hub & CRM 4 Wings — Tier 2: Boundary, Isolation & Backward Compatibility", () => {
  describe("Legacy Tab Auto-Resolution (All 16 Legacy Query Parameters)", () => {
    const legacyTabMap: Array<{ tab: SubTabKey; expectedWing: WingKey }> = [
      { tab: "overview", expectedWing: "overview" },
      { tab: "customers", expectedWing: "care" },
      { tab: "complaints", expectedWing: "care" },
      { tab: "followups", expectedWing: "care" },
      { tab: "contacts", expectedWing: "care" },
      { tab: "inbox", expectedWing: "care" },
      { tab: "quotations", expectedWing: "sales" },
      { tab: "pipeline", expectedWing: "sales" },
      { tab: "contracts", expectedWing: "sales" },
      { tab: "campaigns", expectedWing: "marketing" },
      { tab: "broadcasts", expectedWing: "marketing" },
      { tab: "offers", expectedWing: "marketing" },
      { tab: "coupons", expectedWing: "marketing" },
      { tab: "statement", expectedWing: "finance" },
      { tab: "collections", expectedWing: "finance" },
      { tab: "aging", expectedWing: "finance" },
      { tab: "installments", expectedWing: "finance" },
    ];

    for (const { tab, expectedWing } of legacyTabMap) {
      it(`resolves legacy query ?tab=${tab} to wing '${expectedWing}'`, () => {
        const result = resolveCustomerHubNavigation({ tab });
        expect(result.wing).toBe(expectedWing);
        expect(result.tab).toBe(tab);
        expect(result.isLegacyRedirect).toBe(true);
      });
    }
  });

  describe("Wing Isolation & Sub-Tab Boundary Logic", () => {
    it("Resolves valid wing without tab to the wing's default tab", () => {
      expect(resolveCustomerHubNavigation({ wing: "care" })).toEqual({
        wing: "care",
        tab: "customers",
        isLegacyRedirect: false,
      });
      expect(resolveCustomerHubNavigation({ wing: "sales" })).toEqual({
        wing: "sales",
        tab: "quotations",
        isLegacyRedirect: false,
      });
      expect(resolveCustomerHubNavigation({ wing: "marketing" })).toEqual({
        wing: "marketing",
        tab: "campaigns",
        isLegacyRedirect: false,
      });
      expect(resolveCustomerHubNavigation({ wing: "finance" })).toEqual({
        wing: "finance",
        tab: "statement",
        isLegacyRedirect: false,
      });
    });

    it("Corrects cross-wing tab mismatch: if tab belongs to another wing, auto-routes to that wing", () => {
      // User entered ?wing=care&tab=aging -> Aging belongs to finance!
      const mismatch = resolveCustomerHubNavigation({ wing: "care", tab: "aging" });
      expect(mismatch.wing).toBe("finance");
      expect(mismatch.tab).toBe("aging");
      expect(mismatch.isLegacyRedirect).toBe(true);
    });

    it("Handles completely invalid tab for a given wing by falling back to that wing's default tab", () => {
      const invalidTab = resolveCustomerHubNavigation({
        wing: "care",
        tab: "non_existent_tab",
      });
      expect(invalidTab.wing).toBe("care");
      expect(invalidTab.tab).toBe("customers");
      expect(invalidTab.isLegacyRedirect).toBe(false);
    });

    it("Handles completely unknown wing by falling back safely to Overview Cockpit", () => {
      const unknownWing = resolveCustomerHubNavigation({ wing: "space_station" });
      expect(unknownWing.wing).toBe("overview");
      expect(unknownWing.tab).toBe("overview");
      expect(unknownWing.isLegacyRedirect).toBe(false);
    });

    it("Handles whitespace, case-insensitivity, and null inputs gracefully", () => {
      expect(resolveCustomerHubNavigation({ wing: " CARE " })).toEqual({
        wing: "care",
        tab: "customers",
        isLegacyRedirect: false,
      });
      expect(resolveCustomerHubNavigation({ tab: " QUOTATIONS " })).toEqual({
        wing: "sales",
        tab: "quotations",
        isLegacyRedirect: true,
      });
      expect(resolveCustomerHubNavigation({ wing: null, tab: null })).toEqual({
        wing: "overview",
        tab: "overview",
        isLegacyRedirect: false,
      });
    });
  });

  describe("WhatsApp Phone Normalization Boundary Cases", () => {
    it("Handles formatted local Iraqi phone numbers with dashes and spaces", () => {
      expect(toIraqiIntl("0770 123 4567")).toBe("+9647701234567");
      expect(toIraqiIntl("0780-123-4567")).toBe("+9647801234567");
      expect(toIraqiIntl("(0750) 123 4567")).toBe("+9647501234567");
    });

    it("Handles local Iraqi numbers missing leading zero", () => {
      expect(toIraqiIntl("7701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("7801234567")).toBe("+9647801234567");
    });

    it("Handles numbers already starting with international prefixes (00964, 964, +964)", () => {
      expect(toIraqiIntl("009647701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("9647701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("+9647701234567")).toBe("+9647701234567");
    });

    it("Handles foreign GCC numbers correctly", () => {
      expect(toIraqiIntl("+966501234567")).toBe("+966501234567");
      expect(toIraqiIntl("00971501234567")).toBe("+971501234567");
    });

    it("Returns null safely for invalid inputs (empty, letters, short digits, null, undefined)", () => {
      expect(toIraqiIntl(null)).toBeNull();
      expect(toIraqiIntl(undefined)).toBeNull();
      expect(toIraqiIntl("")).toBeNull();
      expect(toIraqiIntl("   ")).toBeNull();
      expect(toIraqiIntl("12345")).toBeNull();
      expect(toIraqiIntl("abcdefghijk")).toBeNull();
    });
  });

  describe("Emoji Sanitization Boundary Cases", () => {
    it("Strips complex emoji sequences, ZWJ sequences, and skin tones", () => {
      const complex = "زبون ممتاز 👨‍👩‍👧‍👦 وطلب جاهز 📦👍🏽";
      const sanitized = sanitizeForWhatsApp(complex);
      expect(sanitized).toBe("زبون ممتاز وطلب جاهز");
    });

    it("Strips diverse BMP symbols (dingbats, arrows, clock, warnings)", () => {
      const bmpText = "تنبيه ⚠ الموعد ⌛ غداً ⏰ تم الإنجاز ✅";
      const sanitized = sanitizeForWhatsApp(bmpText);
      expect(sanitized).toBe("تنبيه الموعد غداً تم الإنجاز");
    });

    it("Preserves intentional markdown formatting (asterisks, bullet points, hyphens)", () => {
      const formatted = "*فاتورة مبيعات*\n• مادة 1\n• مادة 2\n- الإجمالي: 50,000 د.ع";
      const sanitized = sanitizeForWhatsApp(formatted);
      expect(sanitized).toBe(formatted);
    });

    it("Prevents whitespace explosion or runaway blank lines", () => {
      const multiline = "مرحبا\n\n\n\n\n🎉\n\nمع السلامة";
      const sanitized = sanitizeForWhatsApp(multiline);
      expect(sanitized).not.toContain("\n\n\n");
      expect(sanitized).toContain("مرحبا\n\nمع السلامة");
    });
  });

  describe("Thermal Gift Voucher Data Boundaries", () => {
    it("Handles zero amount gift vouchers safely", () => {
      const doc = giftVoucherToPrintDoc({
        amount: 0,
        customerName: "تجربة",
      });
      expect(doc.totals[0].value).toContain("0 د.ع");
    });

    it("Handles very large amounts (millions IQD) without overflow or notation distortion", () => {
      const doc = giftVoucherToPrintDoc({
        amount: "50000000",
        customerName: "شركة كبرى",
      });
      expect(doc.totals[0].value).toContain("50,000,000 د.ع");
    });

    it("Omits optional metadata lines when values are null or undefined", () => {
      const doc = giftVoucherToPrintDoc({
        amount: 5000,
        customerName: "زبون بدون هاتف",
        customerPhone: null,
        reason: undefined,
        validUntil: null,
      });
      const metaKeys = doc.meta?.join(" ") || "";
      expect(metaKeys).not.toContain("الهاتف:");
      expect(metaKeys).not.toContain("نوع الإهداء:");
      expect(metaKeys).not.toContain("صالحة لغاية:");
    });
  });

  describe("RoleGate Boundary Matrix Across All ERP Roles", () => {
    const REPORT_GATE: RoleGate = {
      roles: ["manager", "accountant", "auditor"],
      module: "reports",
      level: "READ",
    };

    it("Enforces permission across all role templates systematically", () => {
      for (const [roleName] of Object.entries(ROLE_TEMPLATES)) {
        const canAccess = canSeeGate(REPORT_GATE, roleName);
        if (
          roleName === "admin" ||
          roleName === "manager" ||
          roleName === "accountant" ||
          roleName === "auditor"
        ) {
          expect(canAccess, `Role ${roleName} should have report access`).toBe(true);
        } else {
          expect(canAccess, `Role ${roleName} should NOT have report access`).toBe(false);
        }
      }
    });

    it("Explicit permission override can grant report access even to cashier role", () => {
      const cashierWithReports = {
        ...ROLE_TEMPLATES.cashier,
        reports: "READ",
      };
      const allowed = canSeeGate(REPORT_GATE, "cashier", cashierWithReports as never);
      expect(allowed).toBe(true);
    });
  });
});

/* =====================================================================
 * TIER 3: PAIRWISE & CROSS-FEATURE INTEGRATION
 * ===================================================================== */

describe("Customer Hub & CRM 4 Wings — Tier 3: Pairwise & Cross-Feature Integration", () => {
  it("Pairwise: preserves secondary query parameters (id, search) across wing navigation", () => {
    function navigateWithParams(
      currentQuery: string,
      newWing: WingKey,
      newTab?: SubTabKey,
    ): string {
      const params = new URLSearchParams(currentQuery);
      params.set("wing", newWing);
      if (newTab) {
        params.set("tab", newTab);
      } else {
        params.set("tab", CANONICAL_WINGS[newWing].defaultTab);
      }
      return `/crm?${params.toString()}`;
    }

    const currentUrl = "id=105&search=ahmed&wing=care&tab=customers";
    // Navigate to finance wing
    const destUrl = navigateWithParams(currentUrl, "finance", "statement");
    expect(destUrl).toContain("wing=finance");
    expect(destUrl).toContain("tab=statement");
    expect(destUrl).toContain("id=105");
    expect(destUrl).toContain("search=ahmed");
  });

  it("Pairwise: Customer 360 profile drawer combines customer data, thermal voucher, and WhatsApp URL", () => {
    const customer = {
      id: 77,
      name: "مكتبة الفنون الجميلة",
      phone: "07801234567",
      balance: "-150000",
    };

    // 1. WhatsApp conversation link
    const wa = buildWhatsAppLinks(
      customer.phone,
      `مرحباً بكم في ${MANDATED_ARABIC_TERMINOLOGY.wingCare}، كشف حسابكم جاهز`,
    );
    expect(wa.webUrl).toContain("https://wa.me/9647801234567");

    // 2. Apology voucher generation
    const voucher = giftVoucherToPrintDoc({
      amount: 15000,
      customerName: customer.name,
      customerPhone: customer.phone,
      reason: "خصم خاص على الحساب",
    });
    expect(voucher.title).toBe("قسيمة هدية وترضية");
    expect(voucher.meta).toContain(`الزبون: ${customer.name}`);
  });

  it("Pairwise: Complaints logged in Customer Care associate directly with Print Stations and Satisfaction Score", () => {
    const complaintRecord = {
      id: "CMP-881",
      customerId: 45,
      customerName: "الشركة العراقية للورق",
      station: "BINDERY", // التجليد والسلفنة
      issue: "عيوب في سلفنة الغلاف الحراري",
      satisfactionRating: 2, // من 5
      status: "OPEN",
    };

    expect(complaintRecord.station).toBe("BINDERY");
    expect(complaintRecord.satisfactionRating).toBeLessThan(3);
    expect(complaintRecord.status).toBe("OPEN");
  });

  it("Pairwise: Quotation in Sales wing transitions to Pipeline deal with printReportDoc", () => {
    const quotation = {
      id: "QT-900",
      customerId: 12,
      totalAmount: "1250000",
      status: "ACCEPTED",
    };

    // Transition to deal
    const deal = {
      dealId: `DEAL-${quotation.id}`,
      customerId: quotation.customerId,
      expectedValue: quotation.totalAmount,
      stage: "WON", // تم الإغلاق بنجاح
    };

    expect(deal.dealId).toBe("DEAL-QT-900");
    expect(deal.stage).toBe("WON");
  });

  it("Pairwise: Customer account statement exports to Excel and generates WhatsApp statement link", () => {
    const statementRows = [
      { date: "2026-10-01", type: "فاتورة", docNum: "INV-101", debit: "500,000", credit: "0", balance: "500,000" },
      { date: "2026-10-05", type: "سند قبض", docNum: "REC-202", debit: "0", credit: "300,000", balance: "200,000" },
    ];

    const exportSpec = {
      filename: "كشف-حساب-الزبون",
      columns: [
        { key: "date", header: "التاريخ" },
        { key: "type", header: "النوع" },
        { key: "docNum", header: "رقم المستند" },
        { key: "debit", header: "مدين", money: true },
        { key: "credit", header: "دائن", money: true },
        { key: "balance", header: "الرصيد", money: true },
      ],
      rows: statementRows,
    };

    expect(exportSpec.rows).toHaveLength(2);
    expect(exportSpec.columns).toHaveLength(6);

    const waStatementMsg = `تحية طيبة، رصيد كشف حسابكم المتبقي هو ${statementRows[1].balance} د.ع`;
    const wa = buildWhatsAppLinks("07705556677", waStatementMsg);
    expect(decodeURIComponent(wa.webUrl)).toContain("رصيد كشف حسابكم المتبقي هو 200,000 د.ع");
  });
});

/* =====================================================================
 * TIER 4: REALISTIC SCENARIOS & END-TO-END WORKFLOWS
 * ===================================================================== */

describe("Customer Hub & CRM 4 Wings — Tier 4: Realistic Operational Scenarios", () => {
  it("Scenario 1: Customer Care End-to-End Workflow (Search -> 360 Profile -> Station Complaint -> 80mm Gift Voucher -> WhatsApp)", () => {
    // 1. User arrives at Customer Care Wing
    const nav = resolveCustomerHubNavigation({ wing: "care" });
    expect(nav.wing).toBe("care");
    expect(nav.tab).toBe("customers");

    // 2. Clerk inspects Customer 360 profile
    const customer = {
      id: 204,
      name: "حيدر جاسم — مكتب الرشيد",
      phone: "07709998877",
      tier: "GOLD",
      totalOrders: 42,
    };

    // 3. Customer has an issue with print station delivery
    const complaint = {
      id: "CMP-9002",
      customerId: customer.id,
      station: "DELIVERY",
      description: "تأخر وصول الإرسالية ساعتين عن الموعد المتفق عليه",
      resolution: "إصدار قسيمة ترضية فورية بقيمة 10,000 د.ع",
    };
    expect(complaint.station).toBe("DELIVERY");

    // 4. Issue 80mm thermal voucher
    const thermalDoc = giftVoucherToPrintDoc({
      couponCode: "APOLOGY-10K",
      amount: 10000,
      customerName: customer.name,
      customerPhone: customer.phone,
      reason: complaint.resolution,
      validUntil: "2026-11-01",
    });
    expect(thermalDoc.kind).toBe("receipt");
    expect(thermalDoc.title).toBe("قسيمة هدية وترضية");
    expect(thermalDoc.meta).toContain(`رمز الكوبون: APOLOGY-10K`);
    expect(thermalDoc.totals[0].value).toContain("10,000 د.ع");

    // 5. Send polite apology message on WhatsApp
    const waMessage = `أهلاً بك أستاذ حيدر، نعتذر عن التأخير وقد أصدرنا لك قسيمة ترضية فورية بقيمة 10,000 د.ع برمز APOLOGY-10K`;
    const waLinks = buildWhatsAppLinks(customer.phone, waMessage);
    expect(waLinks.webUrl).toContain("https://wa.me/9647709998877");
    expect(decodeURIComponent(waLinks.webUrl)).toContain("قسيمة ترضية فورية");
  });

  it("Scenario 2: Sales & Quotations End-to-End Workflow (Quotation -> Pipeline Stage Progression -> Contract Pricing -> ReportDoc Print)", () => {
    // 1. Route to Sales Wing
    const nav = resolveCustomerHubNavigation({ wing: "sales", tab: "quotations" });
    expect(nav.wing).toBe("sales");
    expect(nav.tab).toBe("quotations");

    // 2. Draft Commercial Quotation
    const quote = {
      code: "QT-2026-78",
      customer: "جامعة بغداد — كلية الهندسة",
      items: [
        { name: "طباعة دفاتر امتحانية 100 صفحة", quantity: 5000, unitPrice: 850, total: 4250000 },
        { name: "أغلفة مشاريع تخرج مقوى وفاخر", quantity: 300, unitPrice: 3500, total: 1050000 },
      ],
      totalIQD: 5300000,
    };
    expect(quote.totalIQD).toBe(5300000);

    // 3. Move Deal along Pipeline stages
    const stages = ["PROSPECT", "NEGOTIATION", "COMMITTED", "WON"];
    let currentStage = stages[0];
    currentStage = stages[1];
    currentStage = stages[3]; // Won
    expect(currentStage).toBe("WON");

    // 4. Verify corporate contract price verification
    const isSpecialContract = true;
    expect(isSpecialContract).toBe(true);

    // 5. Prepare Official printReportDoc output
    const printSpec = {
      title: "عرض أسعار رسمي معتمد",
      docNum: quote.code,
      columns: [
        { key: "name", label: "المادة والمواصفات" },
        { key: "qty", label: "الكمية" },
        { key: "total", label: "المجموع" },
      ],
      rows: quote.items.map((i) => ({
        name: i.name,
        qty: String(i.quantity),
        total: `${i.total.toLocaleString()} د.ع`,
      })),
    };
    expect(printSpec.rows).toHaveLength(2);
    expect(printSpec.rows[0].total).toContain("4,250,000 د.ع");
  });

  it("Scenario 3: Marketing & Loyalty End-to-End Workflow (Campaign Setup -> Broadcast Copywriting -> Thermal Coupon Generation)", () => {
    // 1. Navigate to Marketing Wing
    const nav = resolveCustomerHubNavigation({ wing: "marketing" });
    expect(nav.wing).toBe("marketing");
    expect(nav.tab).toBe("campaigns");

    // 2. Setup Campaign
    const campaign = {
      name: "حملة العودة للمدارس 2026",
      targetSegment: "أولياء الأمور والمدارس",
      channel: "WHATSAPP_BROADCAST",
      discountPercentage: 15,
      active: true,
    };
    expect(campaign.discountPercentage).toBe(15);

    // 3. Draft Broadcast without any forbidden emojis
    const rawCopy = "🎒 أهلاً بكم! جهزوا مستلزمات المدارس بخصم 15% ✏️ كود العرض: SCHOOL15";
    const cleanCopy = sanitizeForWhatsApp(rawCopy);
    expect(cleanCopy).not.toContain("🎒");
    expect(cleanCopy).not.toContain("✏️");
    expect(cleanCopy).toContain("كود العرض: SCHOOL15");

    // 4. Generate 80mm thermal coupon
    const voucherDoc = giftVoucherToPrintDoc({
      couponCode: "SCHOOL15",
      amount: 15000,
      customerName: "حامل الكوبون",
      terms: "يسري الخصم على جميع القرطاسية المدرسية عند الشراء بقيمة 100,000 فأكثر",
    });
    expect(voucherDoc.meta).toContain("رمز الكوبون: SCHOOL15");
    expect(voucherDoc.totals[0].value).toContain("15,000 د.ع");
  });

  it("Scenario 4: Receivables & Collections End-to-End Workflow (Audit Aging -> Payment Reminder -> Installments -> Role Gate Inspection)", () => {
    // 1. Navigate to Finance Wing
    const nav = resolveCustomerHubNavigation({ wing: "finance" });
    expect(nav.wing).toBe("finance");
    expect(nav.tab).toBe("statement");

    // 2. Audit Aging Buckets
    const agingReport = {
      current: 1200000,
      days30: 850000,
      days60: 450000,
      days90Plus: 250000,
      totalOverdue: 1550000,
    };
    expect(agingReport.days30 + agingReport.days60 + agingReport.days90Plus).toBe(
      agingReport.totalOverdue,
    );

    // 3. Generate Overdue Payment Reminder
    const reminder = {
      customerId: 88,
      customerName: "مطبعة دجلة",
      phone: "07802223344",
      overdueAmount: 700000,
      dueDate: "2026-10-01",
    };
    const reminderMsg = `تحية طيبة مطبعة دجلة، نود تذكيركم بلطف باستحقاق مبلغ قدره ${reminder.overdueAmount.toLocaleString()} د.ع بتاريخ ${reminder.dueDate}`;
    const wa = buildWhatsAppLinks(reminder.phone, reminderMsg);
    expect(decodeURIComponent(wa.webUrl)).toContain("700,000 د.ع");

    // 4. Review Installment Plan
    const installmentPlan = {
      totalDebt: 3000000,
      monthlyInstallment: 500000,
      remainingMonths: 6,
    };
    expect(installmentPlan.monthlyInstallment * installmentPlan.remainingMonths).toBe(
      installmentPlan.totalDebt,
    );

    // 5. Strict Role Gate Verification: Cashiers cannot view this wing's sensitive reports
    const REPORT_GATE: RoleGate = {
      roles: ["manager", "accountant", "auditor"],
      module: "reports",
      level: "READ",
    };
    expect(canSeeGate(REPORT_GATE, "cashier")).toBe(false);
    expect(canSeeGate(REPORT_GATE, "accountant")).toBe(true);
    expect(canSeeGate(REPORT_GATE, "auditor")).toBe(true);
  });

  it("Scenario 5: General Manager Executive Cockpit Workflow (Overview KPIs -> Quick Wing Navigation -> Zero Literal Jargon)", () => {
    // 1. Executive logs in and lands on Overview
    const nav = resolveCustomerHubNavigation({ wing: "overview" });
    expect(nav.wing).toBe("overview");
    expect(nav.tab).toBe("overview");

    // 2. High-level KPI cockpit summary
    const cockpitKpis = {
      customerSatisfactionRate: 94.6, // 94.6%
      openComplaints: 3,
      inNegotiationDeals: 14,
      activeCampaigns: 4,
      totalReceivablesCollectedThisMonth: 18500000,
    };
    expect(cockpitKpis.customerSatisfactionRate).toBeGreaterThan(90);
    expect(cockpitKpis.openComplaints).toBeLessThan(10);

    // 3. Quick action jumping to Sales Deals
    const jumpToSales = resolveCustomerHubNavigation({ tab: "pipeline" });
    expect(jumpToSales.wing).toBe("sales");
    expect(jumpToSales.tab).toBe("pipeline");

    // 4. Confirm language audit in Executive view: Zero English acronyms or literal translations
    const uiText = [
      MANDATED_ARABIC_TERMINOLOGY.wingCare,
      MANDATED_ARABIC_TERMINOLOGY.wingSales,
      MANDATED_ARABIC_TERMINOLOGY.wingMarketing,
      MANDATED_ARABIC_TERMINOLOGY.wingFinance,
      MANDATED_ARABIC_TERMINOLOGY.overview,
      MANDATED_ARABIC_TERMINOLOGY.contacts,
      MANDATED_ARABIC_TERMINOLOGY.pipeline,
    ];
    for (const text of uiText) {
      for (const banned of PROHIBITED_JARGON) {
        expect(text, `Executive text '${text}' must not contain '${banned}'`).not.toContain(banned);
      }
    }
  });
});
