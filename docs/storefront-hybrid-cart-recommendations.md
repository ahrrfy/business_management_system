# توصيات «أكمل تجهيزك» الهجينة

## السلوك

يعمل النظام بترتيب ثابت: تُقرأ العلاقات التي ضبطها المدير من `productRelatedProducts` أولاً، ثم تُملأ الأماكن المتبقية من منتجات تشترك مع أحد منتجات السلة في التصنيف. لا تُستخدم التوصيات الآلية إذا كان المنتج المصدر يحمل `allowAutoCartRecommendations = false`، بينما تبقى العلاقات اليدوية صالحة للعرض. النتيجة النهائية لا تتجاوز أربعة منتجات.

يُستبعد المنتج نفسه، وكل منتج موجود في السلة، وكل هدف يدوي تم اختياره، ثم تُطبَّق بوابات المتجر الحالية: المنتج نشط ومسموح عرضه، ليس خدمة، الفئة نشطة عند وجودها، المتغيّر ووحدة البيع نشطان، يوجد سعر بيع، وتوجد أهلية مخزون للفرع الحالي. لا تغيّر التوصيات السعر أو المخزون.

## استعلام MySQL توضيحي

الاستعلام التالي يوضح جلب المنتجات من التصنيف مع استبعاد محتويات السلة والعلاقات اليدوية. يستمر التطبيق في استعمال خدمة توفر المخزون الحالية بعد هذه المرحلة، لأن رصيد الفرع والحجوزات يحتاجان إلى قواعد النظام نفسها:

```sql
WITH cart_product_ids AS (
  SELECT 101 AS product_id
  UNION ALL SELECT 205
),
manual_recommendation_ids AS (
  SELECT 310 AS product_id
  UNION ALL SELECT 311
),
source_categories AS (
  SELECT DISTINCT p.categoryId
  FROM products p
  JOIN cart_product_ids c ON c.product_id = p.id
  WHERE p.allowAutoCartRecommendations = 1
    AND p.categoryId IS NOT NULL
)
SELECT DISTINCT
  p.id,
  p.name,
  p.categoryId,
  p.isFeatured
FROM products p
JOIN source_categories sc ON sc.categoryId = p.categoryId
JOIN productVariants v ON v.productId = p.id AND v.isActive = 1
JOIN productUnits u ON u.variantId = v.id
  AND u.isActive = 1
  AND u.isStoreSaleUnit = 1
JOIN productPrices price ON price.productUnitId = u.id
  AND price.priceTier = 'RETAIL'
LEFT JOIN categories c ON c.id = p.categoryId
WHERE p.isActive = 1
  AND p.isService = 0
  AND p.showInStore = 1
  AND (p.categoryId IS NULL OR (c.isActive = 1 AND c.showInStore = 1))
  AND price.price IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM cart_product_ids x WHERE x.product_id = p.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM manual_recommendation_ids x WHERE x.product_id = p.id
  )
ORDER BY p.isFeatured DESC, p.name ASC, p.id ASC
LIMIT 4;
```

في التطبيق الحقيقي، لا تُرسل قوائم السلة كسلسلة SQL مُركّبة؛ تُمرَّر كـparameters، ويُفضَّل استخدام Drizzle `inArray` و`not(inArray(...))` لتفادي حقن SQL.

## المكافئ المستخدم في Drizzle

```ts
const excludedIds = [...sourceProductIds, ...manualIds];
const conditions = [
  storefrontPublishableCondition(),
  inArray(products.categoryId, sourceCategoryIds),
];

if (excludedIds.length) {
  conditions.push(not(inArray(products.id, excludedIds)));
}

const candidateRows = await availabilityCandidateSelect(db)
  .where(and(...conditions));

const selectedIds = chooseCandidateProductIds(
  await attachAvailability(db, branchId, candidateRows),
  remainingSlots,
  "IN_STOCK",
);
```

`storefrontCartRecommendations` يطبق هذا المنطق بعد حسم العلاقات اليدوية. لذلك لا يستطيع المنتج التلقائي أن يزيح علاقة يدوية صالحة، ولا يظهر المنتج إذا كان موجوداً في السلة.

## الحقل والهجرة

أُضيف الحقل إلى `products` كما يلي:

```ts
allowAutoCartRecommendations: boolean(
  "allowAutoCartRecommendations",
).default(true).notNull(),
```

الافتراضي `true` يحافظ على سلوك التوصيات الحالي للمنتجات القائمة. الهجرة هي `0249_0249_product_auto_cart_recommendations`، وهي idempotent وتضيف العمود دون تغيير الأسعار أو المخزون.

## الإدارة

يظهر المفتاح باسم **التوصيات الآلية** في كل من نموذج التعديل المتقدم والنموذج المبسط:

- **مسموح**: العلاقات اليدوية أولاً، ثم ملء الفراغ من نفس تصنيف منتجات السلة.
- **متوقف**: العلاقات اليدوية فقط؛ إذا لم توجد علاقة يدوية صالحة فلن يُقترح منتج تلقائياً لهذا المنتج المصدر.

بعد تغيير المفتاح اضغط زر حفظ المنتج. لا تحتاج العلاقات اليدوية إلى إعادة إدخالها، ولا يلزم تشغيل مهمة خلفية؛ القرار يُحسم عند طلب توصيات السلة.

## التحقق

1. أضف منتجاً له تصنيف إلى السلة، وتأكد من ظهور المنتجات المتاحة من التصنيف نفسه.
2. أضف منتجاً يدوياً، وتأكد أنه يظهر قبل التوصيات الآلية.
3. أضف المنتج المقترح نفسه إلى السلة، وتأكد من اختفائه من قسم «أكمل تجهيزك».
4. عطّل المفتاح من تعديل المنتج، ثم أعد فتح السلة؛ يجب أن تختفي التوصيات الآلية ويبقى اليدوي الصالح فقط.
5. اجعل منتجاً غير متاح أو غير منشور، وتأكد أنه لا يظهر حتى لو كان من نفس التصنيف.
