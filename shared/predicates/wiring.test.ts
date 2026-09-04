/**
 * اختبارُ الوصلِ — يُثبت أنّ المسندات المشتركة **مُستهلَكةٌ فعلاً** في المستهلكين المتوقَّعين.
 *
 * تحرسُ ضدّ ارتدادِ التكرار: لو أعاد مُطوِّرٌ لاحقٌ نمطَ `role === "admin" || isOwner` أو
 * `Number(x.currentBalance) > 0` مكانَ استدعاء المسند، هذا الاختبار يسقط ويشير للسطر.
 *
 * لا سلوكَ جديداً هنا — الاختبارات العقديّة للمسندات نفسها في ملفّاتها الجارة.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "..", "..");

function readSource(relPath: string): string {
  return readFileSync(resolve(repoRoot, relPath), "utf8");
}

describe("وصلُ المسندات المشتركة بمستهلكيها (م٥ ذيل)", () => {
  it("hasOpenBalance / balanceDirection: DeliveryParties.tsx يستوردهما ويستعملهما", () => {
    const src = readSource("client/src/pages/DeliveryParties.tsx");
    expect(src).toMatch(/from ["']@shared\/predicates["']/);
    expect(src).toMatch(/hasOpenBalance\(p\)/);
    expect(src).toMatch(/balanceDirection\(p, ["']deliveryParty["']\)/);
  });

  it("balanceDirection: DeliveryPartyDetail.tsx يستعملها للتلوين الاتّجاهيّ", () => {
    const src = readSource("client/src/pages/DeliveryPartyDetail.tsx");
    expect(src).toMatch(/from ["']@shared\/predicates["']/);
    expect(src).toMatch(
      /balanceDirection\(party, ["']deliveryParty["']\) === ["']receivable["']/,
    );
  });

  it("canCrossBranches: أربعة مستهلكين خادميّين يستعملون المسند لا نمطَ `admin || isOwner`", () => {
    // ⚠️ يقبل الاستيراد من `@shared/predicates` أو من `../lib/branchAuthority` (النسخة
    // الخادميّة الحاكمة) — كلاهما مصدرٌ صحيح للحقيقة نفسها. الرفضُ هو لكاتبِ يدٍ يعيد نمطَ
    // `role === "admin" || isOwner` بلا مسند.
    const consumers = [
      "server/services/commissions/scope.ts",
      "server/services/companyBranchScope.ts",
      "server/services/productStudioService.ts",
      "server/services/salesPipeline/scope.ts",
    ];
    for (const path of consumers) {
      const src = readSource(path);
      expect(
        src,
        `${path} يجب أن يستورد canCrossBranches من @shared/predicates أو من ../lib/branchAuthority`,
      ).toMatch(
        /canCrossBranches[^\n]*from ["'](?:@shared\/predicates|(?:\.\.\/)+lib\/branchAuthority)["']/,
      );
      expect(src, `${path} يجب أن يستدعي canCrossBranches(...)`).toMatch(
        /canCrossBranches\(/,
      );
    }
  });

  it("invoiceRemaining: installment/plan.ts + sale/controlRequests.ts يستعملانه", () => {
    for (const path of [
      "server/services/installment/plan.ts",
      "server/services/sale/controlRequests.ts",
    ]) {
      const src = readSource(path);
      expect(src, `${path} يجب أن يستورد invoiceRemaining`).toMatch(
        /invoiceRemaining[^\n]*from ["']@shared\/predicates["']/,
      );
      expect(src, `${path} يجب أن يستدعي invoiceRemaining(...)`).toMatch(
        /invoiceRemaining\(/,
      );
    }
  });

  it("isDeadInvoice: ثلاثة مستهلكين على الأقلّ يستعملون المسند بدلاً من isDeadInvoiceStatus(inv.status)", () => {
    const consumers = [
      "server/services/voucher/create.ts",
      "server/services/voucher/invoiceAllocation.ts",
      "server/services/returnService.ts",
      "server/services/returns/requests.ts",
      "server/services/sale/controlRequests.ts",
    ];
    let matched = 0;
    for (const path of consumers) {
      const src = readSource(path);
      const imports = /isDeadInvoice[^\n]*from ["']@shared\/predicates["']/.test(src);
      const called = /\bisDeadInvoice\(/.test(src);
      if (imports && called) matched += 1;
    }
    expect(matched).toBeGreaterThanOrEqual(3);
  });
});
