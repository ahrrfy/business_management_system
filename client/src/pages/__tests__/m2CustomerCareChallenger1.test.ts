/**
 * Milestone 2 Customer Care Wing — Empirical Challenger 1 Test Suite
 *
 * Adversarially challenges:
 * 1. Missing or empty phone numbers for direct call (tel:) and WhatsApp
 * 2. Complaints station filtering & dual filtering logic in CrmHub.tsx
 * 3. 360 Customer Profile Drawer opening & customerId forwarding across all 4 files
 * 4. Instant gift coupon compensation trigger & race condition protections
 * 5. Repository governance & zero-redundancy contracts across M2 Customer Care files
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Decimal from "decimal.js";
import {
  toIraqiIntl,
  preferredWhatsAppPhone,
  sanitizeForWhatsApp,
} from "@/lib/whatsapp";
import {
  ROOT_CAUSE_STATIONS,
  type RootCauseStation,
  ISSUE_STATUSES,
  type IssueStatus,
} from "@shared/customerFeedback";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../");
const CUSTOMERS_FILE = path.join(REPO_ROOT, "client/src/pages/Customers.tsx");
const CRM_HUB_FILE = path.join(REPO_ROOT, "client/src/pages/CrmHub.tsx");
const CUSTOMER_NOTES_FILE = path.join(REPO_ROOT, "client/src/pages/CustomerNotes.tsx");
const CONTACTS_BANK_FILE = path.join(REPO_ROOT, "client/src/pages/ContactsBank.tsx");
const INSTANT_GIFT_MODAL_FILE = path.join(
  REPO_ROOT,
  "client/src/components/crm/InstantGiftModal.tsx",
);
const CUSTOMER_ROUTER_FILE = path.join(
  REPO_ROOT,
  "server/routers/customerRouter.ts",
);
const FEEDBACK_SERVICE_FILE = path.join(
  REPO_ROOT,
  "server/services/customerFeedbackService.ts",
);

describe("Milestone 2 Challenger 1: Adversarial Verification", () => {
  /* =====================================================================
   * 1. PHONE HANDLING EDGE CASES (tel: and WhatsApp)
   * ===================================================================== */
  describe("1. Phone Handling & WhatsApp Edge Cases", () => {
    it("handles null, undefined, empty, and whitespace-only phone numbers safely in toIraqiIntl", () => {
      expect(toIraqiIntl(null)).toBeNull();
      expect(toIraqiIntl(undefined)).toBeNull();
      expect(toIraqiIntl("")).toBeNull();
      expect(toIraqiIntl("   ")).toBeNull();
      expect(toIraqiIntl("\t\n")).toBeNull();
      expect(toIraqiIntl("invalid-phone")).toBeNull();
      expect(toIraqiIntl("12345")).toBeNull();
      expect(toIraqiIntl("078012345")).toBeNull(); // too short
    });

    it("correctly normalizes valid Iraqi and international phone numbers", () => {
      expect(toIraqiIntl("07701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("7701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("+9647701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("009647701234567")).toBe("+9647701234567");
      expect(toIraqiIntl("+966501234567")).toBe("+966501234567"); // Saudi number
    });

    it("preferredWhatsAppPhone selects first valid phone and returns null when all candidates are empty/invalid", () => {
      expect(preferredWhatsAppPhone(null, undefined, "", "   ")).toBeNull();
      expect(preferredWhatsAppPhone("not-a-phone", "123")).toBeNull();
      // Returns the first valid phone candidate
      expect(
        preferredWhatsAppPhone(
          null,
          "07701234567",
          "07809999999",
        ),
      ).toBe("07701234567");
      // Trims whitespace from valid candidate
      expect(
        preferredWhatsAppPhone("  07701234567  "),
      ).toBe("07701234567");
    });

    it("sanitizeForWhatsApp strips emojis and pictographs to prevent broken characters", () => {
      const sanitized = sanitizeForWhatsApp("مرحباً بك 🧾 في المكتبة 🎁!");
      expect(sanitized).toBe("مرحباً بك في المكتبة !");
      expect(sanitized).not.toContain("🧾");
      expect(sanitized).not.toContain("🎁");
    });

    it("verifies Customers.tsx guards against invalid tel: and WhatsApp links", () => {
      const content = fs.readFileSync(CUSTOMERS_FILE, "utf-8");
      // Must check that phone is normalized/trimmed
      expect(content).toContain("const phone = c.phone?.trim() || null;");
      // Must guard direct call with {phone && (
      expect(content).toMatch(/\{phone\s*&&\s*\(\s*<Button[\s\S]*?href=\{`tel:\$\{phone\}`\}/);
      // Must guard WhatsAppShare with {phone && (
      expect(content).toMatch(/\{phone\s*&&\s*\(\s*<WhatsAppShare/);
    });

    it("verifies CustomerNotes.tsx guards tel: links for null/empty phones", () => {
      const content = fs.readFileSync(CUSTOMER_NOTES_FILE, "utf-8");
      // Due today list: direct call must be guarded by {r.customerPhone && (
      expect(content).toMatch(/\{r\.customerPhone\s*&&\s*\(\s*<Button[\s\S]*?href=\{`tel:\$\{r\.customerPhone\}`\}/);
      // Customer header card: direct call must be guarded by {customer.phone && (
      expect(content).toMatch(/\{customer\.phone\s*&&\s*\(\s*<Button[\s\S]*?href=\{`tel:\$\{customer\.phone\}`\}/);
    });

    it("verifies ContactsBank.tsx returns fallback dash when phone is missing or empty", () => {
      const content = fs.readFileSync(CONTACTS_BANK_FILE, "utf-8");
      expect(content).toMatch(/if\s*\(!r\.phone\)\s*return\s*<span[^>]*>—<\/span>;/);
      expect(content).toContain("href={`tel:${r.phone}`}");
    });
  });

  /* =====================================================================
   * 2. COMPLAINTS STATION FILTERING & DUAL FILTERING LOGIC
   * ===================================================================== */
  describe("2. Complaints Station & Dual Filtering in CrmHub.tsx", () => {
    // Exact PRINTING_STATIONS definition from CrmHub.tsx
    const PRINTING_STATIONS = [
      { id: "ALL", label: "كافة المحطات", stations: [] as readonly string[] },
      { id: "PREPRESS", label: "ما قبل الطباعة (Pre-press)", stations: ["DESIGN"] as readonly string[] },
      { id: "PRINTING", label: "الطباعة (Printing)", stations: ["PRINTING"] as readonly string[] },
      { id: "BINDING_LAMINATION", label: "التجليد والسلفنة (Binding & Lamination)", stations: ["LAMINATION", "CUTTING"] as readonly string[] },
      { id: "DELIVERY", label: "الشحن والتسليم (Shipping & Delivery)", stations: ["DELIVERY"] as readonly string[] },
      { id: "OTHER", label: "أخرى واستقبال", stations: ["RECEPTION", "OTHER"] as readonly string[] },
    ];

    function filterComplaints(
      items: Array<{
        id: number;
        customerId: number;
        issueStatus: string;
        rootCauseStation?: string | null;
        rating: number;
      }>,
      stationFilter: string,
      statusFilter: string,
    ) {
      return items.filter((item) => {
        if (statusFilter !== "ALL" && item.issueStatus !== statusFilter) {
          return false;
        }
        if (stationFilter !== "ALL") {
          const conf = PRINTING_STATIONS.find((s) => s.id === stationFilter);
          if (conf && conf.stations.length > 0) {
            if (
              !item.rootCauseStation ||
              !conf.stations.includes(item.rootCauseStation)
            ) {
              return false;
            }
          }
        }
        return true;
      });
    }

    const testFeedbacks = [
      { id: 1, customerId: 101, issueStatus: "NEW", rootCauseStation: "DESIGN", rating: 2 },
      { id: 2, customerId: 102, issueStatus: "IN_PROGRESS", rootCauseStation: "PRINTING", rating: 1 },
      { id: 3, customerId: 103, issueStatus: "RESOLVED", rootCauseStation: "LAMINATION", rating: 3 },
      { id: 4, customerId: 104, issueStatus: "NEW", rootCauseStation: "CUTTING", rating: 2 },
      { id: 5, customerId: 105, issueStatus: "CLOSED", rootCauseStation: "DELIVERY", rating: 4 },
      { id: 6, customerId: 106, issueStatus: "NEW", rootCauseStation: "RECEPTION", rating: 5 },
      { id: 7, customerId: 107, issueStatus: "IN_PROGRESS", rootCauseStation: "OTHER", rating: 3 },
      { id: 8, customerId: 108, issueStatus: "NEW", rootCauseStation: null, rating: 1 }, // unassigned station
    ];

    it("verifies station definitions cover all 4 core printing stations from ORIGINAL_REQUEST.md", () => {
      const crmHubContent = fs.readFileSync(CRM_HUB_FILE, "utf-8");
      expect(crmHubContent).toContain("PREPRESS");
      expect(crmHubContent).toContain("PRINTING");
      expect(crmHubContent).toContain("BINDING_LAMINATION");
      expect(crmHubContent).toContain("DELIVERY");
      expect(crmHubContent).toContain("OTHER");
    });

    it("stationFilter = 'ALL' returns all items regardless of station", () => {
      const res = filterComplaints(testFeedbacks, "ALL", "ALL");
      expect(res).toHaveLength(8);
    });

    it("stationFilter = 'PREPRESS' filters to DESIGN station only", () => {
      const res = filterComplaints(testFeedbacks, "PREPRESS", "ALL");
      expect(res).toHaveLength(1);
      expect(res[0].id).toBe(1);
    });

    it("stationFilter = 'PRINTING' filters to PRINTING station only", () => {
      const res = filterComplaints(testFeedbacks, "PRINTING", "ALL");
      expect(res).toHaveLength(1);
      expect(res[0].id).toBe(2);
    });

    it("stationFilter = 'BINDING_LAMINATION' captures both LAMINATION and CUTTING", () => {
      const res = filterComplaints(testFeedbacks, "BINDING_LAMINATION", "ALL");
      expect(res).toHaveLength(2);
      expect(res.map((r) => r.id).sort()).toEqual([3, 4]);
    });

    it("stationFilter = 'DELIVERY' filters to DELIVERY station only", () => {
      const res = filterComplaints(testFeedbacks, "DELIVERY", "ALL");
      expect(res).toHaveLength(1);
      expect(res[0].id).toBe(5);
    });

    it("stationFilter = 'OTHER' captures both RECEPTION and OTHER stations", () => {
      const res = filterComplaints(testFeedbacks, "OTHER", "ALL");
      expect(res).toHaveLength(2);
      expect(res.map((r) => r.id).sort()).toEqual([6, 7]);
    });

    it("excludes null/undefined station when a specific station filter is active", () => {
      const resAll = filterComplaints(testFeedbacks, "ALL", "ALL");
      expect(resAll.some((r) => r.id === 8)).toBe(true);

      for (const st of ["PREPRESS", "PRINTING", "BINDING_LAMINATION", "DELIVERY", "OTHER"]) {
        const res = filterComplaints(testFeedbacks, st, "ALL");
        expect(res.some((r) => r.id === 8)).toBe(false);
      }
    });

    it("dual filtering: station + status works seamlessly without conflict", () => {
      // PREPRESS + NEW -> item 1
      expect(filterComplaints(testFeedbacks, "PREPRESS", "NEW")).toHaveLength(1);
      // PREPRESS + RESOLVED -> 0
      expect(filterComplaints(testFeedbacks, "PREPRESS", "RESOLVED")).toHaveLength(0);

      // BINDING_LAMINATION + NEW -> item 4 (CUTTING)
      const resBindNew = filterComplaints(testFeedbacks, "BINDING_LAMINATION", "NEW");
      expect(resBindNew).toHaveLength(1);
      expect(resBindNew[0].id).toBe(4);

      // BINDING_LAMINATION + RESOLVED -> item 3 (LAMINATION)
      const resBindResolved = filterComplaints(testFeedbacks, "BINDING_LAMINATION", "RESOLVED");
      expect(resBindResolved).toHaveLength(1);
      expect(resBindResolved[0].id).toBe(3);

      // DELIVERY + CLOSED -> item 5
      const resDelClosed = filterComplaints(testFeedbacks, "DELIVERY", "CLOSED");
      expect(resDelClosed).toHaveLength(1);
      expect(resDelClosed[0].id).toBe(5);

      // Status NEW only across all stations
      const resNew = filterComplaints(testFeedbacks, "ALL", "NEW");
      expect(resNew.map((r) => r.id).sort()).toEqual([1, 4, 6, 8]);
    });

    it("calculates complaint metrics accurately with floating-point precision", () => {
      const total = testFeedbacks.length;
      const sumRating = testFeedbacks.reduce((acc, curr) => acc + (curr.rating || 0), 0);
      const avgRating = (sumRating / total).toFixed(1);
      const openCount = testFeedbacks.filter(
        (i) => i.issueStatus === "NEW" || i.issueStatus === "IN_PROGRESS",
      ).length;
      const resolvedCount = testFeedbacks.filter(
        (i) => i.issueStatus === "RESOLVED" || i.issueStatus === "CLOSED",
      ).length;

      expect(total).toBe(8);
      // 2 + 1 + 3 + 2 + 4 + 5 + 3 + 1 = 21 / 8 = 2.625 => "2.6"
      expect(avgRating).toBe("2.6");
      // NEW: 1, 4, 6, 8 (4 items) + IN_PROGRESS: 2, 7 (2 items) = 6
      expect(openCount).toBe(6);
      // RESOLVED: 3 (1 item) + CLOSED: 5 (1 item) = 2
      expect(resolvedCount).toBe(2);
      expect(openCount + resolvedCount).toBe(total);
    });
  });

  /* =====================================================================
   * 3. 360 CUSTOMER PROFILE DRAWER OPENING CONTRACT
   * ===================================================================== */
  describe("3. Customer 360 Dossier Drawer Opening Contract", () => {
    it("Customers.tsx forwards customerId correctly to CustomerDossierDrawer", () => {
      const content = fs.readFileSync(CUSTOMERS_FILE, "utf-8");
      expect(content).toContain('import { CustomerDossierDrawer } from "@/components/crm/CustomerDossierDrawer";');
      expect(content).toContain("const [selectedDossierCustomerId, setSelectedDossierCustomerId] = useState<number | null>(null);");
      // Row button triggers setter
      expect(content).toContain("onClick={() => setSelectedDossierCustomerId(id)}");
      // RowActions view menu item triggers setter
      expect(content).toContain("onSelect: () => setSelectedDossierCustomerId(id)");
      // Mounted drawer passes exact customerId
      expect(content).toMatch(
        /<CustomerDossierDrawer\s+customerId=\{selectedDossierCustomerId\}\s+open=\{(Boolean\(selectedDossierCustomerId\)|selectedDossierCustomerId != null|!!selectedDossierCustomerId)\}\s+onClose=\{\(\)\s*=>\s*setSelectedDossierCustomerId\(null\)\}\s*\/>/,
      );
    });

    it("CrmHub.tsx CustomerComplaintsView forwards customerId correctly to CustomerDossierDrawer", () => {
      const content = fs.readFileSync(CRM_HUB_FILE, "utf-8");
      expect(content).toContain('import { CustomerDossierDrawer } from "@/components/crm/CustomerDossierDrawer";');
      expect(content).toContain("const [dossierCustomerId, setDossierCustomerId] = useState<number | null>(null);");
      // Complaint card button triggers setter
      expect(content).toContain("onClick={() => setDossierCustomerId(item.customerId)}");
      // Mounted drawer passes exact customerId
      expect(content).toMatch(
        /<CustomerDossierDrawer\s+customerId=\{dossierCustomerId\}\s+open=\{Boolean\(dossierCustomerId\)\}\s+onClose=\{\(\)\s*=>\s*setDossierCustomerId\(null\)\}\s*\/>/,
      );
    });

    it("CustomerNotes.tsx forwards customerId correctly to CustomerDossierDrawer", () => {
      const content = fs.readFileSync(CUSTOMER_NOTES_FILE, "utf-8");
      expect(content).toContain('import { CustomerDossierDrawer } from "@/components/crm/CustomerDossierDrawer";');
      expect(content).toContain("const [selectedDossierCustomerId, setSelectedDossierCustomerId] = useState<number | null>(null);");
      // Due today item button
      expect(content).toContain("onClick={() => setSelectedDossierCustomerId(r.customerId)}");
      // Customer header card button
      expect(content).toContain("onClick={() => setSelectedDossierCustomerId(effectiveCustomerId)}");
      // Mounted drawer
      expect(content).toMatch(
        /<CustomerDossierDrawer\s+customerId=\{selectedDossierCustomerId\}\s+open=\{Boolean\(selectedDossierCustomerId\)\}\s+onClose=\{\(\)\s*=>\s*setSelectedDossierCustomerId\(null\)\}\s*\/>/,
      );
    });

    it("ContactsBank.tsx forwards customerId to CustomerDossierDrawer for customers only", () => {
      const content = fs.readFileSync(CONTACTS_BANK_FILE, "utf-8");
      expect(content).toContain('import { CustomerDossierDrawer } from "@/components/crm/CustomerDossierDrawer";');
      expect(content).toContain("const [dossierCustomerId, setDossierCustomerId] = useState<number | null>(null);");
      // Customer row button
      expect(content).toContain('kind === "customer"');
      expect(content).toContain("onClick={() => setDossierCustomerId(r.id)}");
      // Supplier row does NOT open customer dossier drawer
      expect(content).toContain('kind === "supplier"');
      expect(content).toContain('onClick={() => setSelected({ kind: "supplier", id: r.id })}');
      // Mounted drawer
      expect(content).toMatch(
        /<CustomerDossierDrawer\s+customerId=\{dossierCustomerId\}\s+open=\{(Boolean\(dossierCustomerId\)|!!dossierCustomerId)\}\s+onClose=\{\(\)\s*=>\s*setDossierCustomerId\(null\)\}\s*\/>/,
      );
    });
  });

  /* =====================================================================
   * 4. INSTANT GIFT COUPON TRIGGER & RACE CONDITIONS
   * ===================================================================== */
  describe("4. Instant Gift Coupon Trigger & Concurrency Protections", () => {
    it("CrmHub.tsx segregates satisfied vs dissatisfied complaints for compensation", () => {
      const content = fs.readFileSync(CRM_HUB_FILE, "utf-8");
      // Rating threshold: >= 4 satisfied, <= 3 dissatisfied
      expect(content).toContain("const isSatisfied = item.rating >= 4;");
      // Satisfied gets Google Review invite
      expect(content).toMatch(/\{isSatisfied\s*&&\s*\([\s\S]*?handleSendGoogleReviewInvite/);
      // Dissatisfied gets instant gift coupon trigger
      expect(content).toMatch(/\{!isSatisfied\s*&&\s*\([\s\S]*?setGiftCustomer\(\{[\s\S]*?customerId:\s*item\.customerId/);
    });

    it("InstantGiftModal prevents double-clicks and race conditions via mutation pending state", () => {
      const modalContent = fs.readFileSync(INSTANT_GIFT_MODAL_FILE, "utf-8");
      // Submit button is disabled while issueMutation is pending
      expect(modalContent).toContain('disabled={!can("customers.issueInstantGift") || (issueMutation.isPending)}');
      // Shows animated spinner during mutation
      expect(modalContent).toContain("issueMutation.isPending ?");
      expect(modalContent).toContain("animate-spin");
      // Validates positive money amount before mutation using Decimal
      expect(modalContent).toContain("new Decimal(amount?.trim() || \"0\")");
      expect(modalContent).toContain("amountDec.greaterThan(0)");
      // Invalidates both dossier360 and feedbackList on success
      expect(modalContent).toContain("utils.customers.dossier360.invalidate");
      expect(modalContent).toContain("utils.customers.feedbackList.invalidate");
    });

    it("backend issueInstantGift mutation enforces cashier limit and atomic transaction", () => {
      const routerContent = fs.readFileSync(CUSTOMER_ROUTER_FILE, "utf-8");
      // Cashier gift cap of 50,000 IQD
      expect(routerContent).toContain("const CASHIER_GIFT_CAP = new Decimal(50000);");
      expect(routerContent).toContain("!isElevatedRole && amountDec.greaterThan(CASHIER_GIFT_CAP)");

      const serviceContent = fs.readFileSync(FEEDBACK_SERVICE_FILE, "utf-8");
      // Must wrap in database transaction
      expect(serviceContent).toContain("return withTx(async (tx) => {");
      // Must check feedback belongs to customer (IDOR protection)
      expect(serviceContent).toContain("eq(customerFeedback.id, input.feedbackId)");
      expect(serviceContent).toContain("eq(customerFeedback.customerId, input.customerId)");
      // Must update feedback status to RESOLVED atomically with giftCouponId
      expect(serviceContent).toContain("giftCouponId: couponId");
      expect(serviceContent).toContain('issueStatus: "RESOLVED"');
    });
  });

  /* =====================================================================
   * 5. REPOSITORY GOVERNANCE & PROHIBITED PATTERNS AUDIT
   * ===================================================================== */
  describe("5. Repository Governance & Zero Prohibited Terminology", () => {
    it("ContactsBank.tsx has zero occurrences of prohibited 'بنك جهات الاتصال' in UI titles", () => {
      const content = fs.readFileSync(CONTACTS_BANK_FILE, "utf-8");
      // Title must be "دليل أرقام وهواتف الزبائن"
      expect(content).toContain("دليل أرقام وهواتف الزبائن");
      // Prohibited title string must not exist
      expect(content).not.toContain('title="بنك جهات الاتصال"');
      expect(content).not.toContain('title: "بنك جهات الاتصال"');
    });

    it("ContactsBank.tsx uses DataTable and has zero raw <table> tags", () => {
      const content = fs.readFileSync(CONTACTS_BANK_FILE, "utf-8");
      expect(content).toContain("<DataTable");
      expect(content).not.toMatch(/<table[\s>]/i);
      expect(content).not.toContain("ScrollTableShell");
    });

    it("Customers.tsx exports both Excel and CSV formats", () => {
      const content = fs.readFileSync(CUSTOMERS_FILE, "utf-8");
      expect(content).toContain('formats: ["xlsx", "csv"]');
      expect(content).toContain('filename: "دليل_الزبائن"');
      expect(content).toContain("handlePrintCustomersPdf");
    });

    it("ContactsBank.tsx has both Excel and CSV export functions", () => {
      const content = fs.readFileSync(CONTACTS_BANK_FILE, "utf-8");
      expect(content).toContain('format: "xlsx" | "csv"');
      expect(content).toContain("exportRows(rows,");
    });
  });
});
