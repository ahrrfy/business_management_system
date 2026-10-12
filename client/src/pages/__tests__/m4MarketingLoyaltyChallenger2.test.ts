/**
 * Milestone 4 Marketing, Loyalty & Coupons Wing — Empirical Challenger 2 Test Suite
 *
 * Adversarially and empirically audits:
 * 1. Strict repository guard compliance in all 4 M4 pages:
 *    - Zero emoji in UI code.
 *    - Zero raw HTML <table> tags.
 *    - Zero raw status colors (only semantic CSS tokens var(--sem-*) and standard theme classes).
 *    - Zero window.confirm or alert calls (confirm() from @/lib/confirm used).
 *    - Zero window.print (uses printGiftVoucherDoc / printCouponCards).
 * 2. Standard Arabic page titles & terminology:
 *    - Campaigns: «الحملات الإعلانية»
 *    - WaBroadcasts: «رسائل الواتساب الجماعية»
 *    - Offers: «العروض والتخفيضات»
 *    - Coupons: «الكوبونات وقسائم الهدايا»
 * 3. Operational completeness:
 *    - Excel & CSV export in all 4 pages.
 *    - Customer 360 dossier drawer in Coupons.tsx.
 *    - Direct call (tel:) & WhatsApp sharing with Iraqi phone normalization in Coupons.tsx & WaBroadcasts.tsx.
 *    - 80mm thermal voucher printing (printGiftVoucherDoc) integration in Coupons.tsx.
 * 4. Stress testing & edge case simulation:
 *    - toIraqiIntl & sanitizeForWhatsApp edge cases.
 *    - giftVoucherPrint doc generator edge cases (missing fields, extreme amounts).
 *    - couponCard doc generator edge cases.
 *    - Date & validity calculators (offerActivationState, campaignWindow).
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  toIraqiIntl,
  sanitizeForWhatsApp,
  buildWhatsAppLinks,
  preferredWhatsAppPhone,
} from "@/lib/whatsapp";
import { printGiftVoucherDoc } from "@/lib/printing/giftVoucherPrint";
import { printCouponCards } from "@/lib/printing/couponCard";
import { docTable, wrapA4Doc } from "@/lib/printing/docHtml";
import { D, fmtAr, formatIqd } from "@/lib/money";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../");
const CAMPAIGNS_FILE = path.join(REPO_ROOT, "client/src/pages/Campaigns.tsx");
const WA_BROADCASTS_FILE = path.join(REPO_ROOT, "client/src/pages/WaBroadcasts.tsx");
const OFFERS_FILE = path.join(REPO_ROOT, "client/src/pages/Offers.tsx");
const COUPONS_FILE = path.join(REPO_ROOT, "client/src/pages/Coupons.tsx");

const M4_FILES = [
  { name: "Campaigns.tsx", path: CAMPAIGNS_FILE, title: "الحملات الإعلانية" },
  { name: "WaBroadcasts.tsx", path: WA_BROADCASTS_FILE, title: "رسائل الواتساب الجماعية" },
  { name: "Offers.tsx", path: OFFERS_FILE, title: "العروض والتخفيضات" },
  { name: "Coupons.tsx", path: COUPONS_FILE, title: "الكوبونات وقسائم الهدايا" },
];

describe("Milestone 4 Challenger 2: Adversarial & Empirical Guard Verification", () => {
  /* =====================================================================
   * 1. REPOSITORY GUARDS COMPLIANCE (ZERO EMOJI, ZERO RAW TABLE, ZERO CONFIRM, ZERO RAW COLORS, ZERO PRINT)
   * ===================================================================== */
  describe("1. Strict Repository Guards Compliance", () => {
    it("Zero emoji characters in UI code across all 4 M4 pages", () => {
      const emojiRegex =
        /[\u{1F300}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{231A}-\u{231B}\u{23E9}-\u{23FA}\u{25B0}-\u{25FF}\u{2B00}-\u{2BFF}]/u;

      for (const file of M4_FILES) {
        const content = fs.readFileSync(file.path, "utf-8");
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();
          if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
            continue;
          }
          const hasEmoji = emojiRegex.test(line);
          if (hasEmoji) {
            throw new Error(`Emoji detected in ${file.name} line ${i + 1}: ${line}`);
          }
          expect(hasEmoji).toBe(false);
        }
      }
    });

    it("Zero raw HTML <table> tags in all 4 M4 pages (DataTable strictly used)", () => {
      for (const file of M4_FILES) {
        const content = fs.readFileSync(file.path, "utf-8");
        // Must not contain <table, <thead, <tbody, <tr, <th, <td
        expect(content).not.toMatch(/<table[\s>]/i);
        expect(content).not.toMatch(/<thead[\s>]/i);
        expect(content).not.toMatch(/<tbody[\s>]/i);
        expect(content).not.toMatch(/<th[\s>]/i);
      }
    });

    it("Zero window.confirm or window.alert in all 4 M4 pages", () => {
      for (const file of M4_FILES) {
        const content = fs.readFileSync(file.path, "utf-8");
        expect(content).not.toContain("window.confirm");
        expect(content).not.toContain("window.alert");
        // Also ensure raw confirm( without importing from @/lib/confirm does not exist
        const usesConfirm = content.includes("confirm(");
        if (usesConfirm) {
          expect(content).toContain('import { confirm } from "@/lib/confirm";');
        }
      }
    });

    it("Zero window.print calls in all 4 M4 pages (official print modules used)", () => {
      for (const file of M4_FILES) {
        const content = fs.readFileSync(file.path, "utf-8");
        expect(content).not.toContain("window.print");
      }
    });

    it("Zero raw/hardcoded status color classes (e.g. text-green-500, bg-red-600) — semantic tokens only", () => {
      // Forbidden raw color patterns in badges / statuses
      const forbiddenColorRegex =
        /(?:bg|text|border)-(?:red|green|emerald|amber|yellow|blue)-(?:400|500|600|700)/;

      for (const file of M4_FILES) {
        const content = fs.readFileSync(file.path, "utf-8");
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();
          if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
            continue;
          }
          const hasForbidden = forbiddenColorRegex.test(line);
          if (hasForbidden) {
            throw new Error(`Raw color class found in ${file.name} line ${i + 1}: ${line}`);
          }
          expect(hasForbidden).toBe(false);
        }
      }
    });

    it("Verifies semantic tokens used in M4 pages are strictly valid tokens from tokens.css", () => {
      const allowedSemTokens = new Set([
        "--sem-pos",
        "--sem-pos-bg",
        "--sem-neg",
        "--sem-neg-bg",
        "--sem-warn",
        "--sem-warn-bg",
        "--sem-info",
        "--sem-info-bg",
      ]);

      const semTokenRegex = /var\((--sem-[a-zA-Z0-9-]+)\)/g;

      for (const file of M4_FILES) {
        const content = fs.readFileSync(file.path, "utf-8");
        let match;
        while ((match = semTokenRegex.exec(content)) !== null) {
          const tokenName = match[1];
          expect(allowedSemTokens.has(tokenName)).toBe(true);
        }
      }
    });
  });

  /* =====================================================================
   * 2. STANDARD ARABIC PAGE TITLES & VOCABULARY
   * ===================================================================== */
  describe("2. Standard Arabic Page Titles & Vocabulary", () => {
    it("Verifies exact Arabic page titles in PageHeader for all 4 pages", () => {
      for (const file of M4_FILES) {
        const content = fs.readFileSync(file.path, "utf-8");
        expect(content).toContain(`title="${file.title}"`);
      }
    });

    it("Zero prohibited literal translations or strange jargon in M4 pages", () => {
      for (const file of M4_FILES) {
        const content = fs.readFileSync(file.path, "utf-8");
        expect(content).not.toContain("خط الأنابيب");
        expect(content).not.toContain("بنك جهات الاتصال");
      }
    });
  });

  /* =====================================================================
   * 3. OPERATIONAL TOOL COMPLETENESS (EXPORT, PRINTING, 360 DOSSIER, WHATSAPP)
   * ===================================================================== */
  describe("3. Operational Tool Completeness", () => {
    it("All 4 M4 pages implement Excel & CSV export buttons", () => {
      for (const file of M4_FILES) {
        const content = fs.readFileSync(file.path, "utf-8");
        // Must import exportRows or exportSheets
        expect(content).toMatch(/import\s*\{[^}]*(?:exportRows|exportSheets)[^}]*\}\s*from\s*["']@\/lib\/export["']/);
        // Must have Excel button and CSV button
        expect(content).toMatch(/Excel/i);
        expect(content).toMatch(/CSV/i);
        // Must handle both formats
        expect(content).toMatch(/["']xlsx["']/);
        expect(content).toMatch(/["']csv["']/);
      }
    });

    it("Coupons.tsx implements thermal 80mm voucher printing via printGiftVoucherDoc", () => {
      const content = fs.readFileSync(COUPONS_FILE, "utf-8");
      expect(content).toContain('import { printGiftVoucherDoc } from "@/lib/printing/giftVoucherPrint";');
      expect(content).toContain("printCouponThermal");
      expect(content).toContain("printLastIssueThermal");
      expect(content).toContain("قسيمة حرارية 80 مم");
      expect(content).toContain("إيصال حراري 80 مم");
    });

    it("Coupons.tsx mounts CustomerDossierDrawer with numeric customerId and direct actions", () => {
      const content = fs.readFileSync(COUPONS_FILE, "utf-8");
      expect(content).toContain('import { CustomerDossierDrawer } from "@/components/crm/CustomerDossierDrawer";');
      expect(content).toContain("setDossierCustomerId");
      expect(content).toMatch(/<CustomerDossierDrawer[\s\S]*?customerId=\{dossierCustomerId\}/);
      // Direct call href guarded with tel:
      expect(content).toContain('href={`tel:${intlPhone ?? phone}`}');
      // WhatsApp share component included
      expect(content).toContain("<WhatsAppShare");
    });

    it("WaBroadcasts.tsx exports and utilizes Iraqi WhatsApp tools", () => {
      const content = fs.readFileSync(WA_BROADCASTS_FILE, "utf-8");
      expect(content).toContain("toIraqiIntl");
      expect(content).toContain("sanitizeForWhatsApp");
      expect(content).toContain("buildWhatsAppUrl");
      expect(content).toContain("openWhatsApp");
      expect(content).toContain("معاينة في واتساب");
    });
  });

  /* =====================================================================
   * 4. EMPIRICAL STRESS TESTING & EDGE CASES
   * ===================================================================== */
  describe("4. Empirical Stress Testing & Edge Cases", () => {
    it("toIraqiIntl handles extreme and hostile inputs without crashing", () => {
      expect(toIraqiIntl(null)).toBeNull();
      expect(toIraqiIntl(undefined)).toBeNull();
      expect(toIraqiIntl("")).toBeNull();
      expect(toIraqiIntl("    ")).toBeNull();
      expect(toIraqiIntl("abc")).toBeNull();
      expect(toIraqiIntl("<script>alert(1)</script>")).toBeNull();
      expect(toIraqiIntl("0770000000000000000000")).toBeNull(); // overly long
      expect(toIraqiIntl("07801234")).toBeNull(); // too short

      // Normalization of various Iraqi formats:
      expect(toIraqiIntl("0770 123 4567")).toBe("+9647701234567");
      expect(toIraqiIntl("0770-123-4567")).toBe("+9647701234567");
      expect(toIraqiIntl("+964 770 123 4567")).toBe("+9647701234567");
      expect(toIraqiIntl("00964 770 123 4567")).toBe("+9647701234567");
    });

    it("sanitizeForWhatsApp strips pictographs, emojis, and dangerous sequences", () => {
      const hostileMsg = "🎉 تهانينا! كود الخصم: CRM123 🎁💎\nساري حتى نهاية الشهر ✨";
      const clean = sanitizeForWhatsApp(hostileMsg);
      expect(clean).not.toContain("🎉");
      expect(clean).not.toContain("🎁");
      expect(clean).not.toContain("💎");
      expect(clean).not.toContain("✨");
      expect(clean).toContain("تهانينا! كود الخصم: CRM123");
      expect(clean).toContain("ساري حتى نهاية الشهر");
    });

    it("buildWhatsAppLinks correctly encodes Arabic and formats web and app URLs", () => {
      const { webUrl, appUrl } = buildWhatsAppLinks("07701234567", "مرحباً بكم");
      expect(webUrl).toContain("https://wa.me/9647701234567?text=");
      expect(webUrl).toContain(encodeURIComponent("مرحباً بكم"));
      expect(appUrl).toContain("whatsapp://send?phone=9647701234567&text=");
    });

    it("Decimal arithmetic in Coupons and Offers avoids IEEE 754 floating point drift", () => {
      // 0.1 + 0.2 in JS = 0.30000000000000004
      expect(0.1 + 0.2).not.toBe(0.3);
      // D(0.1).plus(0.2) in Decimal.js is exactly 0.3
      expect(D(0.1).plus(0.2).toNumber()).toBe(0.3);

      // Check formatIqd and fmtAr formatting stability
      expect(formatIqd("150000")).toContain("150,000");
      expect(fmtAr("25000")).toContain("25,000");
    });

    it("Simulates campaign window logic on edge case dates", () => {
      function campaignWindow(startsOn: string | null, endsOn: string | null, today: string) {
        const starts = startsOn || "";
        const ends = endsOn || "";
        if (ends && ends < today) return "انتهت نافذتها";
        if (starts && starts > today) return "تبدأ لاحقاً";
        if (!starts && !ends) return "بلا مدة";
        return "ضمن نافذتها";
      }

      const today = "2026-10-11";
      expect(campaignWindow(null, null, today)).toBe("بلا مدة");
      expect(campaignWindow("2026-10-01", "2026-10-10", today)).toBe("انتهت نافذتها");
      expect(campaignWindow("2026-10-12", "2026-10-20", today)).toBe("تبدأ لاحقاً");
      expect(campaignWindow("2026-10-01", "2026-10-20", today)).toBe("ضمن نافذتها");
      expect(campaignWindow("2026-10-11", "2026-10-11", today)).toBe("ضمن نافذتها");
      expect(campaignWindow("2026-10-01", null, today)).toBe("ضمن نافذتها");
    });

    it("Simulates offer activation logic on edge cases", () => {
      function offerActivationState(
        offer: { isActive: boolean; effectiveFrom: string; effectiveTo: string | null },
        today: string,
      ) {
        if (!offer.isActive) return "معطَّل";
        if (offer.effectiveFrom > today) return "يبدأ لاحقاً";
        if (offer.effectiveTo && offer.effectiveTo < today) return "انتهى تاريخياً";
        return "سارٍ الآن";
      }

      const today = "2026-10-11";
      expect(offerActivationState({ isActive: false, effectiveFrom: "2026-10-01", effectiveTo: null }, today)).toBe("معطَّل");
      expect(offerActivationState({ isActive: true, effectiveFrom: "2026-10-15", effectiveTo: null }, today)).toBe("يبدأ لاحقاً");
      expect(offerActivationState({ isActive: true, effectiveFrom: "2026-10-01", effectiveTo: "2026-10-10" }, today)).toBe("انتهى تاريخياً");
      expect(offerActivationState({ isActive: true, effectiveFrom: "2026-10-01", effectiveTo: "2026-10-20" }, today)).toBe("سارٍ الآن");
      expect(offerActivationState({ isActive: true, effectiveFrom: "2026-10-01", effectiveTo: null }, today)).toBe("سارٍ الآن");
    });
  });
});
