# ذاكرة حل تناقض تصنيف المصروف في صندوق القرارات ومواءمة شارات الأثر المالي (01-10-2026)

**التاريخ:** 01 تشرين الأول / أكتوبر 2026  
**النطاق:** معالجة التناقض البصري والتصنيفي المالي بين صندوق القرارات (`DecisionRow`) وجدول المصروفات العام (`Expenses`) للمصروفات المعلقة، وإلزام ظهور الفئة التشغيلية المُدارة ومركز التكلفة في صف القرار، ومواءمة شارات الأثر المالي بين طبيعة القرار المستقبلي والوضع الراهن للطلب.  
**الملفات الرئيسية المعدلة:**
- خادم قرارات الخزينة: `server/services/decisions/sources/treasury.ts`.
- واجهة صف القرار: `client/src/components/decision/DecisionRow.tsx`.
- محددات وعرض المصروفات: `client/src/components/expenses/expenseView.ts`, `client/src/pages/Expenses.tsx`.
- قواميس التسميات المشتركة: `shared/expenseLabels.ts`.
- كروت الموبايل ولوحة التتبع وسندات الطباعة: `client/src/components/expenses/ExpenseMobileCard.tsx`, `client/src/components/expenses/ExpenseTracePanel.tsx`, `client/src/components/expenses/printExpenseReceipt.ts`.
- حزم الاختبارات والتحقق: `server/services/__tests__/decisionInbox.test.ts`, `client/src/components/decision/DecisionRow.test.ts`, `client/src/components/expenses/expenseView.test.ts`.  
**الفرع:** `investigate_teamwork_preview_discrepancy`  
**طلب الدمج المعتمد والمنشور:** PR #1359 (الالتزام `6dd11c63aba9e98a40be4697ae488eb00d6e46d7`)  
**البروتوكولات المفعلة:** Definition of Done (DoD), Teamwork Preview Multi-Agent Protocol (SWE Light + 3 Adversarial Reviews + Independent Victory Audit), CI/CD Remote Auto-Healing, Production Atomic Deployment (`pnpm prod:deploy`).

---

## ١. تحليل المتطلبات والواقع التشغيلي السابق (Root Cause Analysis - RCA)

### بلاغ المالك والواقع المرصود:
عند استعراض طلب اعتماد المصروف رقم `EXP#592` بمبلغ `4,525,000` د.ع (المتعلق بتجهيز وقود 3600 لتر)، ظهر تناقضان جوهريان بين شاشتين:
1. **في صندوق القرارات (شاشة الاعتماد):** ظهر العنوان «CASH · مصروف مواصلات/شحن» مع شارة برتقالية «خروج مال» وغياب تام لمركز التكلفة.
2. **في جدول المصروفات (شاشة المصروفات العامة):** ظهرت الفئة بوضوح «وقود ومحروقات» مع «مركز: الإدارة والتشغيل»، وتحت مجموعة «طلبات اعتماد غير منفذة» شارة زرقاء «بلا أثر مالي» وتوضيح «طلب اعتماد خزينة — لم يُصرف».

### الكشف الجنائي لجذور التناقض:
1. **جذر خلل الفئة التشغيلية:**
   * في جدول المصروفات، كانت الشاشة تعتمد على دالة `expenseCategoryText` التي تستعلم جدول الفئات المُدارة `expenseCategories.name`، فتُظهر الفئة الفعلية الدقيقة «وقود ومحروقات».
   * أما استعلام `expenseSource` في خادم القرارات (`treasury.ts`)، فكان يقتصر على استعلام عمود الدلو المحاسبي الخام `expenses.category` من جدول `expenses` دون عمل `leftJoin` مع `expenseCategories`، ثم يمرره لدالة `expenseBucketLabel`، مما يُسقط الفئة إلى الدلو العام `TRANSPORT` («مواصلات/شحن») ويتجاهل مركز التكلفة `expenses.costCenter` تماماً.
2. **جذر التباس شارة الأثر المالي:**
   * في صندوق القرارات، كانت الشارة تمثل حافز/بوابة الاعتماد (`ApprovalTrigger: "MONEY_OUT"`) استناداً لسياسة الاعتماد التي تقصر تدخل المالك على «خروج مال» أو «محو أثر قائم»، أي أن الشارة تصف الإجراء المستقبلي المشروط بالاعتماد.
   * في جدول المصروفات، كانت الشارة تمثل حالة التمويل الراهنة (`funding: "PENDING"` من `EXPENSE_FUNDING_META`)، حيث أن المصروف ما زال قيد الانتظار ولم يُصرف من الخزينة، فهو في اللحظة الراهنة «بلا أثر مالي».
   * غياب النصوص التوضيحية والتلميحات جعل المالك يظن أن هناك تضارباً محاسبياً بين النظامين.

---

## ٢. الحلول الهندسية المنفذة

### ١. ربط الفئات المُدارة ومركز التكلفة بخادم القرارات (`server/services/decisions/sources/treasury.ts`):
- تعديل استعلام `expenseSource.list` لعمل `leftJoin` مع جدول `expenseCategories` على الشرط `eq(expenses.expenseCategoryId, expenseCategories.id)`.
- جلب حقول `expenseCategoryName: expenseCategories.name` و `costCenter: expenses.costCenter`.
- بناء عنوان صف القرار الدقيق:
  ```ts
  const categoryLabel = r.expenseCategoryName?.trim() || expenseBucketLabel(r.category);
  title: `مصروف ${categoryLabel} · ${r.paymentMethod}`,
  subkind: categoryLabel,
  ```
- إضافة مركز التكلفة كعنصر تلخيصي مستقل في `summaryItems` لضمان إفصاحه للمالك أثناء قرار الاعتماد.

### ٢. إحكام البديل الاحتياطي وتشذيب الفراغات (`expenseView.ts`):
- ترقية دالة `expenseCategoryText` لمعالجة النصوص الفارغة والمسافات البيضاء والرجوع الحتمي للدلو المحاسبي عند غياب الفئة المُدارة.
- تعميم نفس المنطق الصارم على كروت الموبايل (`ExpenseMobileCard.tsx`)، لوحة تتبع المصروف (`ExpenseTracePanel.tsx`)، وقوالب طباعة الإيصالات (`printExpenseReceipt.ts`).

### ٣. ضبط وتوضيح دلالات شارات الأثر المالي:
- في `DecisionRow.tsx`: تعديل نص شارة لحظة الخطر لتصبح: **«خروج مال عند الاعتماد»** مع تلميح صريح: `title="طبيعة القرار: خروج مال عند الاعتماد"`.
- في `shared/expenseLabels.ts` و `Expenses.tsx`: تعديل شارة الطلبات المعلقة في جدول المصروفات لتصبح: **«معلق بلا أثر مالي»** مع تلميح يوضح: `title="الوضع الراهن: طلب معلّق بلا أثر مالي حتى الآن"`.
- توضيح شرح تفاصيل التمويل في `fundingDetail` للمصروفات المعلقة لبيان أنها لا تُصرف إلا بعد اعتماد المالك.

---

## ٣. الاختبارات والتحقق والتدقيق الجنائي

1. **اختبارات الوحدة والخادم:**
   - تحديث واختبار `server/services/__tests__/decisionInbox.test.ts` (21 اختباراً) للتأكد من ظهور الفئة المُدارة ومركز التكلفة والرجوع للدلو المحاسبي.
   - بناء جناح اختبارات مخصص `client/src/components/expenses/expenseView.test.ts` (9 اختبارات) يغطي تشذيب الفراغات، حالات null، البديل الاحتياطي، وشارات الأثر المالي.
   - تحديث اختبارات `client/src/components/decision/DecisionRow.test.ts` لتأكيد شارة خروج المال عند الاعتماد.
2. **بروتوكول فريق العمل والتدقيق المستقل (Teamwork Preview):**
   - تنفيذ الإصلاح عبر مسار SWE Light المتخصص.
   - اجتياز 3 جولات مراجعة تدقيقية صارمة (Adversarial Reviews).
   - اجتياز تدقيق النصر المستقل الثلاثي الأبعاد بنتيجة قطعية: **`VICTORY CONFIRMED`**.
3. **حراس البنية التحتية والـ CI:**
   - اجتياز `pnpm check` (0 أخطاء TypeScript).
   - اجتياز كافة حراس الجودة في `pnpm check:guards` (بما فيها حراس التعامد والجداول والتجاوب والتسميات الموحدة).
   - اجتياز كافة وظائف GitHub Actions CI الـ 13 بنجاح وتحولها إلى اللون الأخضر في PR #1359 والدمج في `main` بالالتزام `6dd11c63`.

---

## ٤. النشر الذري للإنتاج (Production Atomic Deployment)

- تم تشغيل سكريبت النشر الذري المُدار `pnpm prod:deploy` بهوية مستخدم `deploy` على خادم Hostinger VPS (`srv1548487.hstgr.cloud`).
- نجاح مراحل النشر المتسلسلة: سحب الكود بـ Fast-Forward، تثبيت الحزم، النسخ الاحتياطي للقاعدة، التحقق من المخطط، البناء، وإعادة تحميل عمال PM2 (`erp-server cluster - 3 instances`) وجسر الحضور (`erp-hr-bridge`).
- مدة النشر: **187.5 ثانية**.
- التحقق المباشر من صحة الخدمة بعد النشر: استجابة `https://srv1548487.hstgr.cloud/healthz` بكود `200 OK`.
