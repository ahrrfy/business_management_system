# ذاكرة المشروع: بروتوكول مزامنة تكلفة المنتجات المصنعة والبكجات ونشرها إنتاجياً (2026-09-23)

## ١. ملخص الشريحة والهدف
معالجة جذرية لانفصال تكلفة البكجات والمنتجات المصنعة عن بطاقة المنتج:
1. **المنتجات المصنعة من أوامر الإنتاج**: ضمان تحديث المتوسط المرجح للتكلفة (WAVG) في `productVariants.costPrice` فورياً، وإطلاق شلال المزامنة الذري لجميع البكجات التي تحتوي على هذه المخرجات.
2. **البكجات (Bundles)**: حساب التكلفة كحاصل مجموع تكاليف مكوّناتها وكتابتها تلقائياً في `productVariants.costPrice` عند حفظ وصفة البكج أو عند تعديل تكلفة أي مكوّن.
3. **واجهات المستخدم**: قفل حقل التكلفة في بطاقة البكج لمنع التعديل اليدوي العشوائي مع إضافة تلميح تفسيري، وعرض تفاصيل كلفة الوحدة وإجمالي الكلفة وبطاقة الملخص المحسوبة في `BundleRecipeCard`.

---

## ٢. تفاصيل التغييرات البرمجية
- `server/services/bundleService.ts`:
  - إضافة `syncBundleVariantCost(tx, bundleVariantId)` لتحديث التكلفة لمتغير البكج.
  - إضافة `syncBundlesContainingComponents(tx, componentVariantIds)` لمزامنة البكجات المتأثرة بتغير تكلفة أي مكوّن.
  - دمج الاستدعاء داخل `replaceBundleComponents`.
- `server/services/production/create.ts`:
  - ربط استدعاء `syncBundlesContainingComponents(tx, outLines.map(l => l.variantId))` في دالة `produceOutputs` بعد حساب WAVG وتخزين تكلفة المخرجات.
- `client/src/components/form/product/ProductFormFields.tsx`:
  - تعطيل حقل التكلفة لمنتجات البكج (`facts?.isBundle`) مع placeholder وتلميح توضيحي.
- `client/src/components/product/BundleRecipeCard.tsx`:
  - إضافة أعمدة كلفة الوحدة وإجمالي الكلفة وبطاقة الملخص المحسوبة (`formatIqd`) وإبطال كاش `getForVariantEdit` عند الحفظ.

---

## ٣. مصفوفة التحقق والاختبارات
1. **فحص الأنواع (`pnpm check`)**: اجتاز بـ 0 أخطاء.
2. **الحرّاس العشرة والمِسنَنات (`pnpm check:guards`)**: اجتازت كافة الحرّاس الـ 42 بنجاح 100%.
3. **الاختبارات الأحادية (`pnpm test:unit`)**: اجتاز 3014 من أصل 3014 اختباراً عبر 353 ملف اختبار.
4. **تنسيق العمليات (`coord`)**: التزام الشريحة `recipe-cost-snapshot-history`، ثم تحرير القفل بنجاح بعد الدمج.

---

## ٤. مسار الدمج والنشر السحابي (CI/CD Rollout)
1. **GitHub PR**: فتح طلب السحب PR #1209 (`recipe_cost_snapshot_history -> main`).
2. **GitHub Actions CI**: اجتياز 14 فحصاً بنجاح تام (Security Audit, Authz, Scope, Quality Build, 8 Test Shards, Check-Test-Build).
3. **الدمج في `main`**: دمج الـ PR بنجاح برقم الالتزام `3eb32237cab9c7c40723dcadc01e53ca6d09e8a2`.
4. **النشر الإنتاجي على Hostinger VPS (`alroya-prod`)**:
   - تنفيذ `pnpm prod:deploy` واكتمال المراحل الـ 12 الذرية بنجاح في **280.2 ثانية**.
   - خوادم PM2 العنقودية (`erp-server` 3 instances) وجسر الحضور (`erp-hr-bridge`) مستقرة وتعمل بوضعية Zero-Downtime.
   - التحقق من فحص الصحة الحيّ (`/healthz`): استجابة `200 OK` على `srv1548487.hstgr.cloud` و `alarabiya.online`.
