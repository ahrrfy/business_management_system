# ذاكرة تطوير حقل البحث التنبؤي الذكي للطرود والمطابقة الجزئية للأرقام والحروف والتحصين الشامل (25-09-2026)

**التاريخ:** 25 سبتمبر 2026  
**النطاق:** منظومة التوصيل (`/delivery`)، استعلامات التوصيل (`queries.ts`)، راوتر التوصيل (`deliveryRouter.ts`)، قسم استلام تحصيلات الاستقبال (`ReceptionCollectSection.tsx`)، مركز التوصيل (`DeliveryHub.tsx`)، عقود التخزين المؤقت لـ PWA (`scripts/storefront-pwa-contract.mjs`)، والواجهات الأمامية وسهولة الوصول (WAI-ARIA Combobox)  
**طلب السحب:** PR #1251 (الالتزام المدموج في `main`)  
**النشر الإنتاجي:** منشور بنجاح تام على خادم الإنتاج Hostinger VPS (`srv1548487.hstgr.cloud` / `187.124.183.140` / `alroya-prod`) عبر النشر الذري المُدار `pnpm prod:deploy` (229.3 ثانية، استقرار PM2 لـ 3 عناقيد + جسر الحضور، واستجابة 200 OK على `https://alarabiya.online`)  
**الحالة:** مدموج في main ومنشور على الإنتاج 100% بنجاح تام وأخضر شامل لكافة خطوط أنابيب CI وشاردات الاختبارات الثمانية.

---

## ١. ملخص المطلب الاستراتيجي للمالك

طالب المالك بتطوير محرك وحقل البحث ليصبح ذكياً وتنبؤياً بالكامل:
> «بصفتك الخبير الهندسي البرمجي والاستشاري الشريك، طور حقل البحث واجعله يتوقع ويبحث بجزء او من كم حرف ومن كم رقم وليس ويظهر هل فهمتني؟»
> «نفذ التعديلات والمعالجات والاصلاحات بفريق وبروتوكولات Sub-Agents Network, V.E.R.I.F.Y Protocols, Zero-Hallucination & Fact-Check, Closed-Loop Auto-Correction بشكل عميق وذري وشامل 100%»
> «طيب نفذ بروتوكول الدفع الى المستودع والدمج وبروتوكول المعالجة التلقائي للملاحظات وبعدها بروتوكول النشر الذري»

---

## ٢. التحقيق الجنائي لشبكة الوكلاء الفرعيين (Sub-Agents Network)

1. **مدقق الأمان والاستعلامات الخلفية (Security & Query Auditor):**
   - **فحص ثغرات الحقن (SQLi):** التأكد من خلو الاستعلامات من أي دمج نصي خام واستخدام معاملات SQL المهيأة مع تهريب علامات النسبة المئوية والشرطة السفلية عبر `escLike(raw, '!')` وقيد `ESCAPE '!'`.
   - **عزل الفروع الصارم (Multi-Tenant Branch Scoping):** التحقق من إنفاذ شرط الفرع الصارم `consignments.branchId = :scopedBranchId` ومنع أي تسريب بين الفروع.
   - **الحماية من DoS:** حظر البحث عند إدخال أقل من حرفين/رقمين مع فرض حد أقصى صارم (`limit: 20`).
   - **ترجيح النتائج الذكي (Relevance Scoring):** ترجيح التطابق التام، ثم التطابق بالبادئة، ثم التطابق الجزئي الداخلي، مع ترتيب الحالات التشغيلية النشطة أولاً (`OUT_FOR_DELIVERY` ثم `DISPATCHED` ثم `DELIVERED`).

2. **مدقق تجربة المستخدم وسهولة الوصول (UI/UX & A11y Auditor):**
   - **تطبيق معيار WAI-ARIA Combobox:** تحويل حقل الإدخال إلى نمط Combobox قياسي مع سمات `role="combobox"`، `aria-expanded`، `aria-controls`، `aria-autocomplete="list"`، و `aria-activedescendant`.
   - **قائمة النتائج والمؤشر النشط:** ربط القائمة كـ `role="listbox"` والعناصر كـ `role="option"` مع التمرير البصري التلقائي `scrollIntoView({ block: 'nearest' })` عند التنقل بالأسهم.
   - **تمرير مسح الباركود (Barcode Scanner Pass-through):** عند ضغط Enter في حال عدم تحديد أي عنصر من القائمة، يتم تمرير القيمة مباشرة لمعالج مسح الباركود السريع لعدم تعطيل الكاشير والمستودع.
   - **سياسة صفر إيموجي (Zero-Emoji):** استبدال كافة الرموز التعبيرية بأيقونات Lucide النظامية المتناسقة (`Package`, `User`, `Phone`, `FileText`, `MapPin`, `Sparkles`).
   - **صون المسافات العربية (Trim-Safety):** عدم استخدام `trim()` غير المنضبط أثناء الكتابة الحية في الحقل لتمكين كتابة الأسماء المركبة مثل "عبد الله".

3. **مدقق الثوابت المالية والحالات الحدية (Data Invariants Auditor):**
   - **سلامة حساب المبالغ:** استبدال حسابات الفاصلة العائمة البدائية بالحسابات العشرية الدقيقة المعتمدة بالنظام (`round2(netRemaining).toFixed(2)`).
   - **منع مسح طابور الكشف:** تصحيح معالج الاختيار في `ReceptionCollectSection.tsx` ليضيف الطرد المختار إلى الطابور بدلاً من تفريغ القائمة بالكامل.
   - **تطبيع الأرقام المشرقية (+964 والدولية):** تحويل الأرقام الهندية/المشرقية (٠١٢٣٤٥٦٧٨٩) إلى أرقام لاتينية، وتطبيع كود العراق الدولي `+964` والبادئة المحلية `07`.

---

## ٣. المعالجات الهندسية المنفذة

### أ) النواة الخلفية واستعلامات البحث التنبؤي (Backend Engine):
1. **استعلام `predictiveSearchConsignments` في `server/services/delivery/queries.ts`:**
   - فحص الأنماط المدمجة: رقم التتبع الداخلي والخارجي، رقم الوصل والإيصال، اسم الزبون، هاتف الزبون (بتطبيع الرموز والأرقام)، رقم الفاتورة، ورقم أمر الشغل.
   - استبعاد الشحنات المرتجعة (`RETURNED`) مع التركيز على الشحنات المفتوحة والقابلة للتحصيل.
   - وزن وترتيب النتائج بحساب نقاط التطابق (Score) لضمان ظهور النتيجة الأكثر صلة في الصدارة.
2. **إجراء tRPC `delivery.predictiveSearch` في `server/routers/deliveryRouter.ts`:**
   - مدخلات آمنة ومتحقق منها عبر Zod: `query` (حد أدنى 2، حد أقصى 100)، `scopedBranchId`، و `limit` اختياري.
   - استجابة فورية سريعة مع دلالة التصنيف (`matchedField`: `TRACKING_NUMBER` | `PHONE` | `CUSTOMER_NAME` | إلخ).

### ب) المكونات الأمامية وتجربة المستخدم (Frontend Components):
1. **مكون العرض المستقل [PredictiveItemRow.tsx](file:///client/src/components/delivery/PredictiveItemRow.tsx):**
   - استخراج مكوّن العرض للامتثال الصارم لحارس حجم المكونات المعماري D4 (< 400 سطر).
   - عرض الهاتف والعنوان والمبلغ المالي المتبقي والشارات التشغيلية بدقة متناهية ونفاذية BiDi.
2. **مكون الإدخال التنبؤي [PredictiveConsignmentSearchInput.tsx](file:///client/src/components/delivery/PredictiveConsignmentSearchInput.tsx):**
   - حقل بحث تفاعلي مع دعم اختصار F2 للتركيز، والتنقل السلس بالأسهم، وزر الإلغاء السريع، وشارة التحميل الذرية.
3. **تكامل شاشات الاستقبال ومركز التوصيل:**
   - في [ReceptionCollectSection.tsx](file:///client/src/components/reception/ReceptionCollectSection.tsx): دعم البحث التنبؤي لاختيار الطرود الفردية أو إضافتها لكشف التسوية.
   - في [DeliveryHub.tsx](file:///client/src/pages/DeliveryHub.tsx): دعم البحث التنبؤي وتطبيع البحث العربي في شحنات التوصيل.

---

## ٤. بروتوكول المعالجة التلقائية والتصحيح الذاتي (Closed-Loop Auto-Correction)

- **اكتشاف ملاحظة PWA Precache في CI:**  
  عند تشغيل فحص `verify-storefront-pwa-build.mjs` في خط أنابيب CI، رفض الحارس خروج ملف `assets/storefrontSearchNormalize-[hash].js` دون تضمينه في كاش PWA دون اتصال، بسبب قيام Rollup بفصله تلقائياً كحزمة مشتركة بعد استخدام دالة `normalizeArabicSearch` في الشاشات الجديدة.
- **التصحيح الذاتي المغلق:**  
  تم تعديل [scripts/storefront-pwa-contract.mjs](file:///scripts/storefront-pwa-contract.mjs) بإضافة `storefrontSearchNormalize` إلى نمط `STOREFRONT_SHELL_CHUNK_GLOB`.
- **النتيجة:** نجاح فوري لبناء PWA الإنتاجي محلياً وسحابياً (`storefront PWA artifact: OK static=17 precache=38`).

---

## ٥. التحقق والاعتماد (Verification & Quality Gates)

1. **حزمة الاختبارات:**
   - 15/15 اختباراً في [deliveryPredictiveSearch.test.ts](file:///server/services/__tests__/deliveryPredictiveSearch.test.ts) غطت كافة سيناريوهات التطابق واللغات والحالات الحدية بنجاح 100%.
2. **فحص الأنواع وحراس الجودة:**
   - `pnpm check`: صفر أخطاء TypeScript.
   - `pnpm check:guards`: اجتياز كافة الحراس الـ 55 بنجاح تام (100% Green).
3. **التكامل المستمر السحابي (CI):**
   - اجتياز كامل لكافة مهام وسير عمل GitHub Actions وشاردات الاختبار الثمانية (All Green) في PR #1251.
4. **النشر والتشغيل الإنتاجي:**
   - دمج PR #1251 إلى `main`.
   - تنفيذ `pnpm prod:deploy` على خادم `alroya-prod` في 229.3 ثانية.
   - استقرار عناقيد PM2 الثلاثية وتأكيد سلامة الموقع الحي `https://alarabiya.online` برمز 200 OK.
