# D2 — FULLTEXT/searchNorm — مُؤجَّل بقَرار CI workflow (٣٠/٦/٢٦)

## الجذر التَقني

كل بحث منتج في الكاشير يَحسب ARABIC_FOLD_PAIRS عبر REPLACE متَداخل (~٩ REPLACE × ٤ أعمدة = ٣٦ REPLACE) **وقت الاستعلام** على كل صفّ ⇒ مَسحٌ مُكلِّف عند الملايين. الحلّ الأمثل: عمود مولَّد STORED بتطبيع عربي مُسبَق + فهرس B-tree (وأفضل: FULLTEXT WITH PARSER ngram لـ`%term%` بـO(log n)).

## لماذا مُؤجَّل

CI الحالي (`.github/workflows/ci.yml`) يَستعمل **`pnpm db:push`** (drizzle-kit) لتَهيئة `erp_test`. drizzle-kit:
1. لا يَفهم `GENERATED ALWAYS AS (...) STORED` ⇒ يُحاول كتابة العمود كَعمود عادي
2. لو الـDB يَحتوي العمود كَ-GENERATED وschema.ts بلا، يُحاول الحذف ⇒ كَسر مَوسَّع

⇒ تَطبيق D2 يَتطلّب أولاً **تَحويل CI من db:push إلى migrator API** (`db-migrate-apply.mjs` يَعمل، بَخلاف drizzle-kit migrate الذي يَفشل صامتاً). هذا تَعديل CI كَامل بَخارج نِطاق حملة الأداء.

## خطوات التَفعيل (لجلسة لاحقة بأمر المالك)

1. **تَعديل CI workflow** ليَستعمل `node scripts/ci-migrate-fresh.mjs` (سكريبت جديد يُسجِّل كل الهجرات منذ snapshot 0019 يَدوياً في `__drizzle_migrations` ثمَ يُطبّق الجديدة):
   ```yaml
   - name: تَهيئة مخطّط القاعدة (migrator بدل push)
     run: node scripts/ci-migrate-fresh.mjs
   ```
2. **إنشاء هَجرة 0034 يَدوية** (نمط 0030-0033) بـ:
   ```sql
   ALTER TABLE products ADD COLUMN searchNorm VARCHAR(512)
   GENERATED ALWAYS AS (
     LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
       COALESCE(name, ''),
       'أ', 'ا'), 'إ', 'ا'), 'آ', 'ا'), 'ٱ', 'ا'),
       'ة', 'ه'), 'ى', 'ي'), 'ؤ', 'و'), 'ئ', 'ي'), 'ـ', ''))
   ) STORED;
   CREATE INDEX idx_product_search_norm ON products(searchNorm);
   -- اختياري لاحقاً (يَحتاج إعدادات خادم — خط أحمر على VPS مشترك):
   -- ALTER TABLE products ADD FULLTEXT INDEX ft_product_search_norm (searchNorm) WITH PARSER ngram;
   ```
3. **تَحديث catalogService.ts** لاستعمال `products.searchNorm` بدل `foldedCol(products.name)`:
   ```ts
   sql`coalesce(products.searchNorm, '')`
   ```
4. **اختبار تَكافؤ**: catalogSearch.test.ts الحالي يَكشف أيّ انحراف دلالي (نَفس قواعد ARABIC_FOLD_PAIRS الجهتين).
5. **توسيع لـcustomers/suppliers**: نَفس النمط على الجداول الأخرى في hot search paths.

## أثر مَتوقَّع عند التَفعيل

- LIKE 'prefix%' على searchNorm: B-tree فهرس ⇒ آلاف المرّات أسرع من المسح الكَامل
- LIKE '%term%' على searchNorm: مَسح، لكن **بلا ٣٦ REPLACE** ⇒ ٥-١٠× أسرع
- مع FULLTEXT ngram (لو فُعِّل عبر إعدادات الخادم): `%term%` يَصبح O(log n)

## بَدائل مَتاحة الآن (بلا تَفعيل D2)

البَدائل المُنفَّذة في حملة الأداء كافية للحَدّ الأَدنى من «ثقل البحث» عند ١٠٠×:
- **searchNormalize.ts**: tokenizer يَحدّ الاستعلام لخَمس كَلمات ⇒ يُسرّع AND-clauses
- **idx_variant_sku / idx_product_name** (B-tree): تَطابق تامّ سَريع
- **smartSearch** بحدّ ٢٠ نَتيجة + debounce: لا «كل النتائج» في الواجهة

التَحويل لـD2 يَكون قيمته الكُبرى عند **ملايين** المنتجات (نَطاق غَير مَتوقَّع للمتجر — حالياً ~٤٠٠، عند ١٠٠× = ٤٠٬٠٠٠). عند ذلك الحَدّ، تَفعيل D2 خطوةٌ مُستحقَّةٌ.
