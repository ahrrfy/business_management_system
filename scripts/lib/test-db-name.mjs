// اسم قاعدة الاختبار الافتراضيّ — **مشتقٌّ من شجرة العمل** (استقرار سير العمل، ٧/٨/٢٦).
//
// العلّة المُعالَجة (موثّقة في الذاكرة وCLAUDE.md): كل شجرات العمل تتشارك الافتراضيّ `erp_test`
// على صندوق الاختبار 3310، و`__setup__.ts` يحذف **كلّ صفوف كلّ الجداول** بعد كل اختبار. فجلستان
// تشتغلان معاً (وهو الشائع هنا: عشرات الأشجار النشطة) تتقاتلان على القاعدة نفسها ⇒ عشرات
// الإخفاقات الزائفة التي لا علاقة لها بالكود، وساعاتٌ تُهدر في مطاردة أشباح.
//
// الحلّ: بلا `TEST_DATABASE_URL` صريحة، تحصل كلّ شجرة عملٍ على قاعدتها تلقائياً باسم
// `erp_<اسم-المجلّد>_test`. المستودع الرئيسيّ (`business_management_system`) يبقى على `erp_test`
// حرفياً ⇒ صفر تغيير على المسار المعتاد ولا على CI (يضبط الرابط صراحةً دائماً).
//
// الاسم يمرّ بحارس `init-test-db.mjs` (يحوي «test» + محلّيّ + ليس المنفذ 3306) بالبناء.
import path from "node:path";

/** المضيف/المنفذ/الاعتماد الافتراضيّ لصندوق الاختبار (حاوية erp-test-db). */
export const TEST_DB_BASE = "mysql://root:testpw@127.0.0.1:3310";

/** اسم المستودع الأصل — شجرته تبقى على `erp_test` (السلوك التاريخيّ). */
const ROOT_DIR_NAME = "business_management_system";

/**
 * يشتقّ اسم قاعدة اختبارٍ صالحاً من مسار جذر شجرة العمل.
 * أمثلة: `…/business_management_system` ⇒ `erp_test`
 *        `…/.claude/worktrees/invoice-below-cost-error-99689b` ⇒ `erp_invoice_below_cost_error_99689b_test`
 */
export function testDbNameForWorktree(rootDir) {
  const dir = path.basename(rootDir || "");
  if (!dir || dir === ROOT_DIR_NAME) return "erp_test";
  const slug = dir
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .slice(0, 40)
    .replace(/_+$/g, "");
  return slug ? `erp_${slug}_test` : "erp_test";
}

/** الرابط الافتراضيّ الكامل لقاعدة اختبار هذه الشجرة (يُتجاوَز بـTEST_DATABASE_URL). */
export function defaultTestDatabaseUrl(rootDir) {
  return `${TEST_DB_BASE}/${testDbNameForWorktree(rootDir)}`;
}
