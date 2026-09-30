# ذاكرة إصلاح تعارض التصنيف المالي لبطاقة تعديل المنتجات (30-09-2026)

**التاريخ:** 30 سبتمبر 2026  
**النطاق:** إصلاح خطأ تعديل بطاقة المنتج المخزني ذي التاريخ التشغيلي، وقصر توجيهات الخدمات التشغيلية على الخدمات الحقيقية حصراً، وتصحيح رمز الخطأ من تضارب التزامن المتفائل إلى طلب غير صالح.  
**الملفات الرئيسية المعدلة:**
- الخادم وإدارة المنتجات: `server/services/catalog/productCreate.ts`, `server/services/productEditService.ts`.
- حزمة الاختبارات: `server/services/__tests__/productEdit.test.ts`.  
**الفرع:** `etc-Let-s-choose-reconcile_purchase_shipping_expenses-5-Verify-Constraints-Words-count`  
**البروتوكولات المفعلة:** Sub-Agents Network, V.E.R.I.F.Y Protocols, Zero-Hallucination & Fact-Check, Closed-Loop Auto-Correction, Definition of Done (DoD).

---

## ١. التحقيق الجنائي وكشف الجذور (Root Cause Analysis - RCA)

### المشكلة المشخّصة:
ظهور خطأ صريح عند محاولة تعديل بطاقة منتج سلعي مخزني (مثل المنتج #2700 في مسار `/products/:id/edit`):
> «لا يمكن تغيير التصنيف المالي لمنتج له تاريخ تشغيلي — تغيير نوع المنتج أو الخدمة أو الأمانة أو المودِع سيجعل حركات المخزون أو المبيعات والمرتجعات والإلغاءات القديمة تُفسَّر بقواعد غير التي أُنشئت بها. أنشئ منتجاً جديداً بالتصنيف المطلوب، ثم عطّل المنتج القديم للمبيعات الجديدة. — تعارض: تغيّر السجل في مكان آخر — أعد تحميل الشاشة ثم كرّر الحفظ»

### الأسباب الجذرية:
1. **انقلاب نوع المنتج السلعي تلقائياً إلى خدمة طباعة (`PRINT_SERVICE`):**
   في الالتزام `346eeba8` وحملة إضافة توجيهات الخدمات لعروض الأسعار والمبيعات المتقدمة، تم تعريف المتغير داخل `productEditService.ts` بالشكل التالي:
   ```typescript
   const hasServiceRouting = effectiveShowInPrintPos || effectiveShowInReception || effectiveShowInQuotations || effectiveShowInAdvancedSales;
   const effectiveProductType = hasServiceRouting ? "PRINT_SERVICE" : requestedProductType;
   ```
   هذا التحويل كان غير مشروط بكون المنتج خدمة أصلاً (`isService`)! فعندما يحمل منتج سلعي مخزني عادي (`isService = false`) خيار ظهور في عروض الأسعار أو الاستقبال أو المبيعات المتقدمة، كان السيرفر يحوّل `productType` في الذاكرة قسراً إلى `"PRINT_SERVICE"`.
2. **اصطدام التعديل بحارس التصنيف المالي التاريخي:**
   لما كان المنتج المخزني يمتلك حركات مخزنية أو فواتير سابقة (`invoiceItems` أو `inventoryMovements`)، فإن مقارنة `productTypeChanged` كانت تكتشف تغييراً من النوع المخزني الأصلي (مثل `NULL` أو `"قرطاسية"`) إلى `"PRINT_SERVICE"`، مما يطلق حارس منع تغيير التصنيف المالي لحماية قيود التكلفة المرجحة والمخزون.
3. **توليد رمز خطأ مضلل في واجهة المستخدم (`CONFLICT` بدلاً من `BAD_REQUEST`):**
   كان الحارس يرمي استثناء TRPC برمز `CONFLICT`، وهو رمز محجوز في بنية النظام للتضارب المتزامن (Optimistic Locking Concurrency Conflict). ونتيجة لذلك كانت دوال المعالجة بالواجهة (`shared/saveOutcome.ts` و `RecordForm.tsx`) تدمج نص الخطأ مع:
   `" — تعارض: تغيّر السجل في مكان آخر — أعد تحميل الشاشة ثم كرّر الحفظ"`.
4. **تسرّب المشكلة في مسار الإنشاء (`productCreate.ts`):**
   تبيّن أن `productCreate.ts` احتوى على نفس الثغرة حيث كان `isPrintServiceProduct` يتحقق من الأعلام دون تقييد بـ `isService`:
   ```typescript
   const isPrintServiceProduct = showInPrintPos || !!input.showInReception || !!input.showInQuotations || !!input.showInAdvancedSales || input.productType === PRINT_SERVICE_TYPE;
   ```
   مما يؤدي لإنشاء سلع مخزنية تحمل `productType = 'PRINT_SERVICE'`.

---

## ٢. الحلول الهندسية المنفذة

### ١. حصر توجيهات خدمات الطباعة على الخدمات الحقيقية (`isService = true`):
- في `server/services/catalog/productCreate.ts`:
  ```typescript
  const isPrintServiceProduct = isService && (showInPrintPos || !!input.showInReception || !!input.showInQuotations || !!input.showInAdvancedSales || input.productType === PRINT_SERVICE_TYPE);
  ```
- في `server/services/productEditService.ts`:
  ```typescript
  const hasServiceRouting = willBeService && (
    effectiveShowInPrintPos ||
    effectiveShowInReception ||
    effectiveShowInQuotations ||
    effectiveShowInAdvancedSales ||
    p.productType === PRINT_SERVICE_TYPE ||
    requestedProductType === PRINT_SERVICE_TYPE
  );
  const effectiveProductType = hasServiceRouting ? PRINT_SERVICE_TYPE : requestedProductType;
  ```

### ٢. التمييز بين المسار التشغيلي الحقيقي والتسميات الوصفية (`operationalProductRoute`):
- بناء دالة صريحة تميّز بين تغيير المسار المالي/التشغيلي الحقيقي وتعديل التصنيفات النصية العادية:
  ```typescript
  const operationalProductRoute = (type: string | null | undefined, isSvc: boolean): "PRINT_SERVICE" | "DIGITAL_CARD" | "STANDARD" => {
    if (type === "DIGITAL_CARD") return "DIGITAL_CARD";
    if (isSvc && type === PRINT_SERVICE_TYPE) return "PRINT_SERVICE";
    return "STANDARD";
  };
  const productRouteChanged = operationalProductRoute(effectiveProductType, willBeService) !== operationalProductRoute(p.productType, !!p.isService);
  ```
- السلع المخزنية العادية تبقى دائماً ضمن مسار `"STANDARD"`، مما يتيح للمستخدم تعديل حقولها أو تصنيفاتها العادية دون إطلاق الحارس المالي.

### ٣. تصحيح رمز الخطأ إلى `BAD_REQUEST`:
- استبدال `CONFLICT` بـ `BAD_REQUEST` في حراس تغيير التصنيف المالي وحارس مكونات البكجات في `productEditService.ts`، لضمان عرض الرسالة التوضيحية بدقة دون إيهام المستخدم بوجود تضارب تزامن متفائل في مكان آخر.

### ٤. شبكة الأمان والاختبارات التراجعية:
- إضافة اختبارين محددين في `server/services/__tests__/productEdit.test.ts`:
  1. السماح بتعديل منتج مخزني عادي له تاريخ فواتير وتفعيل توجيهات المبيعات وعروض الأسعار دون اعتباره تغييراً في التصنيف المالي.
  2. السماح بتعديل منتج مخزني ذي `productType = null` وله تاريخ فواتير مع تفعيل توجيهات المبيعات.
- اجتياز كافة اختبارات ملف `productEdit.test.ts` الـ 69 بنسبة 100%.

---

## ٣. التحقق الهندسي وبوابات الجودة (V.E.R.I.F.Y)

1. **V - Verification of Invariants:** صون استقرار التصنيف المالي للخدمات والسلع، وحماية تاريخ المخزون والتكلفة المرجحة WAVG.
2. **E - Execution & Fact-Check:** تشغيل الاختبارات فعلياً على قاعدة بيانات الاختبارات، والتأكد من اجتياز 69/69 اختباراً في `productEdit.test.ts`.
3. **R - Ratchets & Guards:** فحص الأنواع الصارم `pnpm check` (صفر أخطاء) واجتياز كافة الحراس الـ 45 في `pnpm check:guards` بنسبة 100%.
4. **I - Isolation & Coordination:** عزل ملفات الجلسة وتفادي المساس بأي ملف تابع للشرائح المتزامنة في `coord`.
5. **F - Forensic Diagnostics:** إثبات زوال رسالة التضارب والتعارض المضللة عند الحفظ.
6. **Y - Yield & Deployment:** توثيق الذاكرة وإدراج التحديث في سجل الحملات تمهيداً للإيداع والدمج.
