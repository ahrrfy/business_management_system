# توحيد مكوّن البحث ومسح الباركود ونمذجته من الكاشير لجميع شاشات النظام ونشره إنتاجياً (22-09-2026)

## السياق والنتائج الميدانية (PR #1203 — الالتزام المدموج `ad85f619`)

استجابةً للتوجيهات القيادية والتشغيلية بإجراء تدقيق جنائي وبياني شامل (Graph Engineering) لكافة حقول البحث ومسح الباركود والكتابة في النظام، تم استنساخ ونمذجة مكون البحث ومسح الباركود المعتمد في نقطة البيع (POS / الكاشير) وتعميمه ليكون المكون الموحد الشامل لكافة شاشات النظام. قضى هذا التحول الهندسي الجذري على مشاكل اختفاء المسافات عند الكتابة ("عمار السلامي")، وتذبذب ملاحة العناوين (URL Churn)، واستنزاف الشبكة بالاستعلامات المتسارعة غير المفرملة (Zero-Debounce).

تم التحقق محلياً واجتياز فحص الأنواع الصارم وحراس الجودة الـ 42، وتفعيل بروتوكول المعالجة التلقائية والشفاء الذاتي (Auto-Remediation Loop) على GitHub CI، ودُمج الـ PR #1203 في `main`، ونُشر التحديث بنجاح كامل على سيرفر الإنتاج Hostinger VPS (`alroya-prod`) عبر سكربت النشر المدار الذري `pnpm prod:deploy` في **241.2 ثانية** دون أي انقطاع للخدمة، واستقرت خوادم PM2 العنقودية وجسر الحضور مع استجابة فحص الصحة `/healthz` بـ `200 OK` على النطاقين الحيّين (`alarabiya.online` و `srv1548487.hstgr.cloud`).

---

## ١. التحقيق الجنائي والأسباب الجذرية المكتشفة

### أ. علة اختفاء المسافات بين الكلمات عند الكتابة (Space Trimming Bug)
1. **الموقع الأول:** الدالة `normalizeKnownSystemBarcode` في `shared/barcodeScanner.ts` كانت تُطبق `raw.trim()` على النصوص الحرة غير الباركودية، وتُستدعى في أحداث `onChange` التابعة لـ `ListToolbar.tsx` و `DataTable.tsx`. هذا كان يؤدي لمسح مفتاح المسافة فور ضغطه وتجميد المؤشر بين الكلمات العربية (مثل كتابة "عمار " فتصبح "عمار").
2. **الموقع الثاني:** آلة الحالة التوقيتية `ScanBurstDetector` في `client/src/lib/barcodeScanTiming.ts` كانت تلتقط أي مفتاح بفاصل زمني $\le 120\text{ms}$ كبداية ومضة باركود أجهزة. فإذا كتب المستخدم كلمة ثم ضغط مسافة بسرعة طبيعية ($\approx 60-100\text{ms}$)، كان الكاشف يبتلع المسافة ويعتبرها ومضة أجهزة، مانعاً الحدث الافتراضي بـ `e.preventDefault()`.

### ب. علة السرعة الزائدة وتدافع الروابط واستنزاف الشبكة (Debounce & URL Churn)
- حقول البحث في شاشات مثل `SalesPipeline.tsx` و `BulkPicker.tsx` و `BarcodeLabels.tsx` و `Vouchers.tsx` و `StudioImageDiscoveryPanel.tsx` كانت ترسل طلبات شبكة فورية مع كل حرف (Zero-Debounce) أو تُحدث معلمات عنوان المتصفح `navigate(..., { replace: true })` عند كل ضربة مفتاح، مما يسبب وميض الواجهة وتدافع استعلامات tRPC وإرهاق السيرفر.

---

## ٢. الحلول والمعمارية الهندسية المعتمدة

### ١. ترقية محرك الباركود وصون الكتابة الحرة
- [`shared/barcodeScanner.ts`](shared/barcodeScanner.ts): إلغاء استدعاء `raw.trim()` للنصوص الحرة داخل `normalizeKnownSystemBarcode`، صيانةً للمسافات الطبيعية التي يكتبها المستخدم.
- [`client/src/lib/barcodeScanTiming.ts`](client/src/lib/barcodeScanTiming.ts): تمييز المسافة البشرية الفاصلة بين الكلمات (بفاصل $> 40\text{ms}$) وتمريرها فوراً دون أي اعتراض، مع حصر اعتراض المسافة فقط في ومضات الباركود الفيزيائية فائقة السرعة ($\le 40\text{ms}$).

### ٢. المكونات الموحدة المنشأة
- [`client/src/components/search/UnifiedSearchInput.tsx`](client/src/components/search/UnifiedSearchInput.tsx):
  - **الهوية البصرية للكاشير:** زوايا منحنية (`rounded-xl`)، إطار هوية ناعم، وتباين عالي مع دعم الأنماط (`variant="default"` و `variant="pos"`).
  - **صون الكتابة العربية:** تخزين محلي فوري (60fps) بدون أي اقتطاع مسافات أثناء الكتابة الحية.
  - **التحكم بالسرعة (Debounce الذكي):** تأجيل افتراضي (180ms - 250ms) لكبح استنزاف الشبكة واستقرار ملاحة المتصفح.
  - **كشف الباركود التلقائي:** التقاط الماسح الضوئي الفيزيائي وتصحيح تخطيط المفاتيح العربي التلقائي (`÷آ{...` -> `INV-...`).
  - **زر مسح فوري (X):** يظهر فقط عند وجود نص، ويعيد التركيز للحقل بلمسة واحدة.
  - **اختصارات لوحة المفاتيح:** `F2` للتركيز، `Escape` للمسح، و `Enter` للبحث والمسح المباشر.
  - **دعم الخصائص الشامل:** يدعم `dir` ("rtl" / "ltr")، والأحجام (`compact`, `default`, `lg`)، و `inputRef` و `ref`.
- [`client/src/components/search/UnifiedProductSearch.tsx`](client/src/components/search/UnifiedProductSearch.tsx):
  - مكوّن الإكمال التلقائي مستنسخ من بطاقات كاشير POS مع عرض السعر (IQD) والرصيد المتاح وإشارات المرور الملونة.

---

## ٣. نتائج التدقيق البياني الشامل (Graph Engineering Audit)

تم جرد وإعادة ربط 41 عقدة تفاعلية عبر النظام بنسبة تغطية 100% على ثلاث موجات تنفيذية ذرية:

| الموجة | النطاق والشاشات المشمولة | الالتزام | الأثر والتحسين الميداني |
|---|---|---|---|
| **الموجة الأولى (Wave 1)** | `ListToolbar.tsx` (يعمم على >35 شاشة)، `DataTable.tsx`، `BulkPicker.tsx`، `SalesPipeline.tsx`، `ReceptionDraftsPage.tsx`، `WorkOrderMaterialsEditor.tsx`، `StudioImageDiscoveryPanel.tsx`، `ProductRelatedProductsEditor.tsx`، `ServiceForm.tsx`، `CustomerPicker.tsx`، `SupplierPicker.tsx` | `99806b13` | كبح الاستعلامات المتسارعة فوراً، حماية مدخلات المبيعات واستقبال الطلبات، وإلغاء الاستعلامات اللانهائية المزدوجة |
| **الموجة الثانية (Wave 2)** | `VoucherFormShared.tsx`، `Vouchers.tsx`، `BarcodeLabels.tsx`، `BundleForm.tsx`، `CountPortal.tsx`، `MyStocktakeWorkspace.tsx`، `ReceptionHandoverPage.tsx`، `ReceptionWorkflowPage.tsx` | `589757df` | توحيد حقول السندات وطباعة الملصقات ومساحات عمل الجرد والاستلام الميداني للمرتجعات والتسليم |
| **الموجة الثالثة (Wave 3)** | `CompanyStatementScanQueue.tsx`، `EntityPicker.tsx`، `SalesRegister.tsx`، `StudioProductPicker.tsx`، `StudioCaptureStation.tsx` | `31298820` | توحيد كشوفات التوصيل بالباركود، منتقي الكيانات السريع، سجل المبيعات، واستوديو تصوير المنتجات |

---

## ٤. بروتوكول المعالجة التلقائية والشفاء الذاتي (Auto-Remediation Loop)

تم تفعيل حلقة الشفاء الذاتي عن بُعد برصد سجلات CI ومعالجة كافة الملاحظات في الالتزام الذري `9626cf16`:
1. صون عقد `shouldSubmitManualBarcode` في محطة تصوير الاستوديو.
2. حل خطأ بيئة الاختبار لـ `BarcodeSearchCue.tsx` باستيراد `* as React from "react"`.
3. صون تعبيرات عقد `useBarcodeInput` في بوابات الجرد ومحرر مواد أوامر الشغل دون المساس بالمكون الموحد.
4. تحول كافة فحوصات GitHub CI الـ 14 إلى اللون الأخضر الكامل (100% Pass).

---

## ٥. النشر في الإنتاج والتحقق الميداني

- **الدمج:** دمج PR #1203 في `main` بالالتزام `ad85f6190c91f67dcf00a7f824fdf982bf024741`.
- **النشر المدار على VPS:** تم تنفيذ `sudo -iu deploy bash -lc 'cd /home/deploy/erp && pnpm prod:deploy'` واجتياز المراحل الـ 12 الذرية بنجاح في 241.2 ثانية.
- **التحقق من صحة النظام:**
  - `git rev-parse HEAD`: مطابق لـ `ad85f6190c91f67dcf00a7f824fdf982bf024741`.
  - خوادم PM2: `erp-server` (3 cluster nodes) و `erp-hr-bridge` (PID `3308627`) في حالة `online` مستقرة.
  - فحص المتجر والمضيف الإداري: `categories=85, products=1, quote=ok` على كِلا المضيفين.
  - نقطة نهاية الصحة الحية: `https://alarabiya.online/healthz` استجابة `200 OK`.
