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
import { ROLE_TEMPLATES, type PermissionMap } from "@shared/permissions";

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
