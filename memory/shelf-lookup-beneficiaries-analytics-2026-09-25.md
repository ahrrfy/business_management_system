# ذاكرة المشروع: منظومة إحصائيات المستفيدين ومسح أسعار الرفوف والباركود الذكي

**التاريخ:** 25 سبتمبر 2026  
**الفرع الأساسي:** `service_beneficiaries_statistics` (مدموج إلى `main` بالالتزام `966ee86b`)  
**طلب الدمج المعتمد:** PR #1258  
**النشر الإنتاجي المدار:** Hostinger VPS بنجاح في 219.8 ثانية (`/healthz` 200 OK، `/shelf-lookup` 200 OK)  
**البروتوكولات المفعلة:** Sub-Agents Network · V.E.R.I.F.Y Protocols · Zero-Hallucination & Fact-Check · Closed-Loop Auto-Correction · Atomic Deployment

---

## ١. سياق الطلب والأهداف المعمارية

استجابةً لطلب المالك الكريم نصاً:
> «بصفتك الخبير التقني والاستشاري الاحترافي اريد ان ارى عدد المستفيدين من الخدمة واحصائيات معقولة نفذ التعديلات والمعالجات والاصلاحات بفريق وبروتوكولات Sub-Agents Network, V.E.R.I.F.Y Protocols, Zero-Hallucination & Fact-Check, Closed-Loop Auto-Correction بشكل عميق وذري وشامل 100%»

### الأهداف الأساسية:
1. **تتبّع حركة المستفيدين الفعليين (Traffic & Beneficiaries Tracking):** قياس عدد مرات الاستعلام، وعدد الزوار الفريدين (المستفيدين الفعليين عبر `visitorId` مشتق أو محفوظ محلياً)، ونشاط اليوم، وحجم المنتجات الفريدة المفحوصة.
2. **محرك التحليلات المعزول والذري (Deterministic Analytics Engine):** استخراج تحليلات أوقات الذروة على مدار اليوم (24 ساعة) بحساب توقيت بغداد (UTC+3) دون الاعتماد على جداول توقيت MySQL الافتراضية، مع توزيع الأجهزة والفروع وقائمة أعلى المنتجات استعلاماً.
3. **التكامل الآلي غير المعطّل (Non-blocking Resilient Ingestion):** تسجيل كل عملية مسح أو استعلام أسعار من واجهة المتجر واستعلام الرفوف العامة دون التأثير على سرعة الاستجابة للعميل، مع معالجة استباقية لأخطاء المفاتيح الأجنبية (`ER_NO_REFERENCED_ROW_2`) في حال فُحصت باركودات غير مسجلة أو محذوفة.
4. **لوحة تحكم إحصائية احترافية (Executive Analytics Dashboard):** مكوّن بصري متكامل عالي النفاذية في صفحة ملصقات الرفوف والباركود الذكي (`ShelfQrLabels.tsx`) بتصميم RTL عربي بالكامل، ورموز ألوان الدلالات الرسمية (`var(--sem-*)`)، والتزام صارم بعدم استخدام الإيموجي في واجهة المستخدم، وتوفير حالات التحميل الهيكلية (Skeletons)، ودعم بيانات تجريبية للمعاينة الأولية.

---

## ٢. المعالجات والتحسينات المنجزة

### أ) طبقة قاعدة البيانات والمخطط الهيكلي (`drizzle/schema.ts` و `0367_shelf_lookup_logs.sql`)
1. **جدول سجلات المسح والاستعلام `shelf_lookup_logs`:**
   - الحقول: `id` (int PK auto-increment), `branchId` (FK nullable to branches), `productId` (FK nullable to products), `barcode` (varchar 100), `source` (enum: `'QR_SCAN'`, `'DIRECT_LOOKUP'`, `'BARCODE_SEARCH'`, `'KIOSK'`), `visitorId` (varchar 64 nullable), `deviceType` (varchar 32 nullable), `searchQuery` (varchar 255 nullable), `scannedAt` (timestamp default current_timestamp).
   - الفهارس المركبة للأداء العالي (O(log N)):
     - `shelf_lookup_source_idx` على `source`.
     - `shelf_lookup_scanned_at_idx` على `scannedAt`.
     - `shelf_lookup_branch_scanned_idx` على `(branchId, scannedAt)`.
     - `shelf_lookup_product_scanned_idx` على `(productId, scannedAt)`.
     - `shelf_lookup_visitor_idx` على `visitorId`.
2. **هجرة معتمدة بقفل coord الذري:** تم إصدار الهجرة `0367_shelf_lookup_logs.sql` وتطبيقها ذرّياً على قاعدة بيانات الإنتاج.

### ب) محرك التحليلات والخدمة الخلفية (`server/services/shelfAnalyticsService.ts`)
1. **دالة `logShelfLookup` غير المعطّلة:** تسجيل الاستعلامات بأمان، مع التقاط خطأ المفتاح الأجنبي وإعادة الحفظ بروابط فارغة في حال لم يكن المنتج أو الفرع موجوداً في قاعدة البيانات لمنع فقدان حركة المسح العامة.
2. **دالة حساب نطاق اليوم بتوقيت بغداد `baghdadTodayUtcRange`:**
   - احتساب بداية ونهاية اليوم الحالي بتوقيت بغداد (UTC+3) وتحويلهما إلى UTC لتصفية الاستعلامات بدقة متناهية.
3. **دالة `getShelfBeneficiariesStats`:**
   - استخراج بطاقات الأداء الرئيسية (KPIs): إجمالي عمليات المسح، الزوار الفريدون (المستفيدون الفعليون)، مسوحات اليوم، والمنتجات الفريدة.
   - توزيع الأجهزة (جوال، حاسوب، لوحي، ماسح، أخرى).
   - توزيع الفروع مع نسب الحجم المئوية.
   - الخط الزمني لساعات الذروة (24 ساعة) عبر `HOUR(DATE_ADD(scannedAt, INTERVAL 3 HOUR))` لمنع مشاكل جداول `time_zone` في بيئات Docker والسحاب.
   - قائمة أعلى 10 منتجات استعلاماً مع الأسعار الحالية والباركود.
   - سجل النشاط الحي لآخر عمليات المسح مع صياغة التوقيت النسبي.
4. **دالة توليد البيانات التجريبية `seedDemoShelfAnalyticsData`:** لإتاحة تجربة فورية ومعاينة بصرية مباشرة لإحصائيات الخدمة.

### ج) مسار tRPC الخلفي وراوتر المتجر (`shelfAnalyticsRouter.ts` و `storefrontRouter.ts`)
1. **الراوتر الإداري `shelfAnalyticsRouter`:**
   - إجراء الاستعلام `getBeneficiariesStats` وإجراء التوليد التجريبي `seedDemoData` بصلاحية المدير.
   - التسجيل في راوتر النظام الشامل `server/routers.ts` تحت المفتاح `shelfAnalytics`.
2. **تكامل واجهة المتجر واستعلام الرفوف `storefrontRouter.ts`:**
   - عند استدعاء `shelfLookup`، يتم التقاط `visitorId` و `deviceType` و `branchId` و `productId` وتسجيل العملية في الخلفية دون تعطيل العميل.

### د) واجهة المستخدم ولوحة التحليلات (`ShelfBeneficiariesAnalytics.tsx` و `ShelfQrLabels.tsx`)
1. **مكوّن التحليلات `ShelfBeneficiariesAnalytics.tsx`:**
   - بطاقات إحصائية تفاعلية بألوان دلالية راقية (`--sem-info`, `--sem-success`, `--sem-primary`, `--sem-warning`).
   - مخطط أعمدة أفقي لساعات النشاط والذروة على مدار اليوم.
   - جداول توزيع الفروع والأجهزة وأعلى المنتجات المستعلم عنها.
   - جدول النشاط الأخير للمسوحات مع وسوم نوع الجهاز ومصدر الاستعلام.
   - حالات تحميل كاملة (Skeleton Loaders) ومواءمة شاشات الموبايل والحواسيب.
   - إمكانية الوصول والتسميات التوضيحية (ARIA labels, focus outlines, contrast AA).
2. **تكامل صفحة ملصقات الرفوف `ShelfQrLabels.tsx`:**
   - إضافة مبدّل تبويبات علوي أنيق للتنقل السلس بين:
     1. "طباعة ملصقات الرفوف"
     2. "إحصائيات المستفيدين" مع شارة حية.
3. **صفحة العميل `client/src/pages/ShelfPriceLookup.tsx`:**
   - توليد وحفظ معرّف زائر فريد ثابت (`visitorId`) في `localStorage` مع التراجع الآمن إلى `sessionStorage`.
   - كشف نوع جهاز العميل وتمريره مع طلب الاستعلام.

---

## ٣. نتائج التحقق الذري والنشر (V.E.R.I.F.Y)

- **حزمة الاختبارات الآلية (`server/services/__tests__/shelfAnalytics.test.ts`):**
  - اختبارات تسجيل الاستعلام والتعافي من أخطاء المفاتيح الأجنبية.
  - اختبارات استخراج إحصائيات المستفيدين ومطابقة الأرقام الفعلية.
  - اختبارات توزيع ساعات الذروة بتوقيت بغداد وتوزيع الأجهزة.
  - نجاح 6/6 اختبارات بنسبة 100%.
- **فحص الأنواع (`pnpm check`):** 0 أخطاء (100% Green).
- **حراس الجودة المعمارية (`pnpm check:guards`):** اجتياز كافة الحراس الـ 45 بنسبة 100%.
- **GitHub Actions CI (PR #1258):** اجتياز كامل لجميع الشاردات والوظائف الـ 14 بنجاح تام (All Green).
- **الدمج مع `main`:** الالتزام المدموج `966ee86b`.
- **النشر الإنتاجي المدار (`pnpm prod:deploy`):**
  - نُفذ بنجاح على خادم Hostinger VPS (`srv1548487.hstgr.cloud`) في 219.8 ثانية.
  - تطبيق هجرة قاعدة البيانات `0367_shelf_lookup_logs.sql`.
  - إعادة التحميل المتدحرج بدون انقطاع لعمال PM2 (النسخ 5، 6، 7).
  - اجتياز فحوصات الصحة 200 OK على `/healthz` و `/shelf-lookup`.
- **تحرير قفل التنسيق (`coord`):** تم تحرير القفل `service-beneficiaries-statistics` وإغلاق الجلسة بنجاح.
