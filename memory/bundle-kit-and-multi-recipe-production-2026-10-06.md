# ذاكرة منظومة إنتاج مكونات البكجات والإنتاج المباشر للوصفات المتعددة

**التاريخ:** ٦ أكتوبر ٢٠٢٦  
**طلب السحب:** [PR #1405](https://github.com/ahrrfy/business_management_system/pull/1405)  
**الالتزام المدموج في `main`:** `d7188d05` (squash)  
**حالة الإنتاج:** منشور حياً عبر `pnpm prod:deploy` ومتحقق بنسبة 100% على خادم الإنتاج Hostinger VPS (`srv1548487.hstgr.cloud`) برمز استجابة 200 OK على `/healthz`.

---

## ١. ملخص الطلب وسياق الأعمال
1. **مولّد إنتاج مكونات البكج (Bundle Kit Production Generator):**
   - تمكين المعمل/المصنع من تحليل مكوّنات أي بكج مصنّع واحتساب العجز الصافي لكل مكوّن بعد فحص رصيد الفرع الصافي المتاح للوعد (ATP Available-to-Promise).
   - جبر العجز استباقياً للمضاعف الشرعي الصحيح للوصفة ومنع الكسور وتلف المخزون.
   - تجميع الخامات المشتركة عبر مكوّنات البكج وكشف المادة المقيدة الحاكمة (عنق الزجاجة) وسقف الأطقم الممكن تصنيعها.
   - ترحيل ذري شامل لأوامر إنتاج كافة المكونات بنقرة واحدة، وتحديث تكلفة البكج التابع تلقائياً.
2. **الإنتاج المباشر للوصفات المتعددة (Direct Multi-Recipe Batch Production):**
   - اختيار متعدد لوصفات الإنتاج النشطة من جدول وبطاقات الوصفات (`ProductionRecipes.tsx`).
   - شريط سفلي عائم تفاعلي (`تم تحديد X وصفات`) يفتح نافذة سريعة لتحديد كميات الدفعات لكل وصفة.
   - فحص استهلاك الخامات المشتركة التراكمي وتنبيهات الهدر.
   - زر جبر علاجي ذكي بنقرة واحدة (`[جبر إلى X]`) لتصحيح الكميات المخالفة لمضاعف الوصفة.
   - ترحيل ذري جماعي بمرجع موحد وبصمة تكرار (Idempotency).

---

## ٢. ما تم بناؤه معمارياً

### أ) العقود والأنواع المشتركة (`shared/`):
- [`shared/bundleProductionTypes.ts`](shared/bundleProductionTypes.ts): مخططات Zod وأنواع DTOs لتحليل وإنتاج مكونات البكج بنمطي `NET_SHORTAGE` و `FULL_QUANTITY`.
- [`shared/multiRecipeProductionTypes.ts`](shared/multiRecipeProductionTypes.ts): مخططات التحليل والتنفيذ للإنتاج المتعدد مع تفكيك عنق الزجاجة `limitingFactors`.

### ب) الخدمات والنواة الذرية (`server/services/production/`):
- [`server/services/production/create.ts`](server/services/production/create.ts): استخراج وتصدير `createProductionInTx(tx, input, actor, options)` لتشغيل أوامر إنتاج فرعية مركبة داخل معاملة خارجية واحدة دون فقدان خاصية التراجع الذري، مع إضافة خيار `{ skipBundleSync: true }` لمنع إعادة حساب تكاليف البكجات بشكل متكرر داخل الحلقات.
- [`server/services/production/bundleProduction.ts`](server/services/production/bundleProduction.ts):
  - `analyzeBundleRequirements`: فحص المكونات، الوصفات النشطة، رصيد ATP، جبر العجز، وتجميع الخامات المشتركة.
  - `produceBundleComponents`: قفل هرمي تصاعدي 2PL، تشعيب بصمات التكرار بـ SHA-256، والتنفيذ الذري مع استدعاء ختامي موحد لـ `syncBundlesContainingComponents`.
- [`server/services/production/multiRecipeProduction.ts`](server/services/production/multiRecipeProduction.ts):
  - `analyzeMultiRecipeRequirements`: فحص صلاحية الوصفات، التدقيق المسبق لقابلية القسمة، وتحديد الخامات العاجزة.
  - `produceMultiRecipeBatches`: التحقق الحتمي للأقفال، الترحيل المجمع، ومزامنة تكاليف البكجات التي تستخدم مخرجات هذه الوصفات.

### ج) الراوتر والصلاحيات وعزل الفروع (`server/routers/productionRouter.ts`):
- تسجيل 4 إجراءات محمية بـ `inventoryManagerProcedure`:
  - `production.bundles.analyzeRequirements`
  - `production.bundles.produceComponents`
  - `production.recipes.analyzeMultiRecipe`
  - `production.recipes.produceMultiRecipe`
- عزل صارم للفرع عبر `resolveScopedBranch` وقسر فرع المستخدم الموثق لمنع ثغرات IDOR.

### د) واجهات المستخدم الأمامية (`client/src/`):
- مكونات البكج المعيارية في `client/src/components/production/bundle-kit/`:
  - `BundleKitProductionDialog.tsx`
  - `BundleKitParametersBar.tsx`
  - `BundleKitComponentsStep.tsx`
  - `BundleKitMaterialsStep.tsx`
  - `BundleKitReviewStep.tsx`
  - `BundleKitSuccessStep.tsx`
- مكونات الإنتاج المتعدد في `client/src/components/production/multi-recipe/`:
  - `MultiRecipeProductionDialog.tsx`
  - `MultiRecipeItemsStep.tsx`
  - `MultiRecipeMaterialsSummary.tsx`
  - `MultiRecipeSuccessStep.tsx`
- نقاط الربط والتكامل:
  - `client/src/pages/ProductionRecipes.tsx`: تفعيل التحديد المتعدد عبر Checkbox، والشريط العائم، وزر إنتاج البكج.
  - `client/src/components/product/BundleRecipeCard.tsx`: زر إطلاق مباشر من بطاقة تعديل البكج مع تمرير المعرف.
  - `client/src/pages/ProductionNew.tsx`: زر في رأس الشاشة لإنتاج مكونات البكج.

---

## ٣. البراهين الهندسية واليقين القطعي (Guarantees & Verification)
1. **انعدام التعليق الدوري (Deadlock-Free by Strict Linear Total Order):**
   - قفل تصاعدي حتمي كلي:
     $$\text{products.id ASC} \implies \text{productVariants.id ASC} \implies \text{(variantId ASC, branchId ASC)}$$
   - تأسيس صفوف الرصيد المفقودة مسبقاً عبر `ensureBranchStockRows` لضمان صحة `FOR UPDATE`.
2. **الذرية المحاسبية والمخزنية التامة (ACID All-or-Nothing):**
   - حزمة الأوامر مجمعة بالكامل داخل `withTx`؛ نقص أي مادة في الدفعة الأخيرة يعيد قاعدة البيانات للحالة الصفرية دون أي تسريب لحركات أو وثائق.
3. **حفظ القيمة (Value Conservation Law):**
   - فحص انحراف التكلفة في `create.ts` (`drift <= 0.01`).
   - فصل الهدر الطبيعي (الممتص في كلفة السليم) عن غير الطبيعي (قيد `WASTAGE` دون خصم مخزني مزدوج).
4. **منع تكرار الإرسال وتطابق البصمة (Idempotency):**
   - توليد مراجع جماعية عبر SHA-256 (`BND-...` / `MULTI-...`) وتشعيب مفاتيح الطلبات الفرعية ضمن سقف `varchar(120)`.

---

## ٤. نتائج بوابات الجودة والفحص
- **`pnpm check`:** `Exit Code: 0` (صفر أخطاء نوعية في TypeScript).
- **`pnpm check:guards`:** `Exit Code: 0` (اجتياز كامل للـ 45 حارساً).
- **الاختبارات التكاملية (Vitest):**
  - `bundleProduction.test.ts`: 12/12 ناجح (100%).
  - `multiRecipeProduction.test.ts`: 13/13 ناجح (100%).
  - `production.test.ts`: 48/48 ناجح (100%).
- **GitGuardian Security Checks:** `SUCCESS`.
- **النشر الإنتاجي المدار (`pnpm prod:deploy`):** تم في 201.4 ثانية وثبات PM2 على الالتزام `d7188d05`.
- **فحص الصحة الحي:** `GET https://srv1548487.hstgr.cloud/healthz` أرجع `200 OK`.
