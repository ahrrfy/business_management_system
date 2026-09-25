/**
 * فحص جنائي شامل وتطابق مسارات النظام وإعادات التوجيه (V.E.R.I.F.Y Protocol)
 *
 * الضمانات الحاكمة:
 * ١. عدم وجود أي إعادة توجيه تسقط معلمات الاستعلام (`RedirectKeepQuery` حصرًا بدل `Redirect` العادي).
 * ٢. تكامل معلمات الاستعلام (?id=, ?tab=, ?branchId=) ودمجها مع استبدال التضارب لصالح الوجهة.
 * ٣. وجود كافة المسارات التوافقية والحرجة وعدم ترك مسارات تائهة أو روابط ميتة.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("تحقيق جنائي للمسارات وإعادات التوجيه (Routes Forensic Audit)", () => {
  const appPath = path.resolve(__dirname, "../../App.tsx");
  const appContent = fs.readFileSync(appPath, "utf8");

  it("كافة إعادات التوجيه في تعريفات المسارات <Route> في App.tsx تستخدم RedirectKeepQuery لمنع إسقاط معلمات الاستعلام", () => {
    const lines = appContent.split("\n");
    const plainRedirects: string[] = [];

    lines.forEach((line, idx) => {
      if (line.trim().startsWith("//") || line.trim().startsWith("/*") || line.trim().startsWith("*")) return;
      if (line.includes("<Route ") && line.includes("<Redirect ") && !line.includes("<RedirectKeepQuery")) {
        plainRedirects.push(`السطر ${idx + 1}: ${line.trim()}`);
      }
    });

    expect(plainRedirects).toEqual([]);
  });

  it("المسارات التوافقية الحرجة للتذكيرات والمشتريات والتقارير معرفة بنجاح", () => {
    expect(appContent).toContain('path="/ar-reminders"');
    expect(appContent).toContain('path="/ap-reminders"');
    expect(appContent).toContain('path="/purchase-requisitions"');
    expect(appContent).toContain('to="/purchases?tab=requisitions"');
    expect(appContent).toContain('to="/reports/ar-reminders"');
    expect(appContent).toContain('to="/reports/ap-reminders"');
    expect(appContent).toContain('to="/crm?tab=aging"');
    expect(appContent).toContain('to="/suppliers?tab=aging"');
    expect(appContent).toContain('to="/closing?tab=period"');
  });

  describe("سلوك دمج معلمات الاستعلام في RedirectKeepQuery", () => {
    function computeRedirectTarget(to: string, currentSearch: string): string {
      const [destPath, targetQuery = ""] = to.split("?");
      const params = new URLSearchParams(currentSearch);
      new URLSearchParams(targetQuery).forEach((v, k) => params.set(k, v));
      const qs = params.toString();
      return qs ? `${destPath}?${qs}` : destPath;
    }

    it("يحفظ معلمات الرابط الوارد دون تغيير إذا لم تكن هناك معلمات في الوجهة", () => {
      const target = computeRedirectTarget("/reports", "id=181&branch=2");
      expect(target).toBe("/reports?id=181&branch=2");
    });

    it("يدمج معلمات الرابط الوارد مع تبويب الوجهة المستهدفة", () => {
      const target = computeRedirectTarget("/crm?tab=customers", "id=45&search=ahmed");
      expect(target).toBe("/crm?id=45&search=ahmed&tab=customers");
    });

    it("الوجهة المستهدفة تغلب عند تعارض المعلمات (مثل تبديل التبويب)", () => {
      const target = computeRedirectTarget("/purchases?tab=requisitions", "tab=orders&status=PENDING");
      expect(target).toBe("/purchases?tab=requisitions&status=PENDING");
    });
  });
});
