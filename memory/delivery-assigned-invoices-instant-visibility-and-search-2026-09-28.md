# ذاكرة الظهور الفوري لفواتير جهات التوصيل وفك ارتهان البحث التنبؤي (28-09-2026)

**التاريخ:** 28 سبتمبر 2026  
**النطاق:** منظومة التوصيل والتحصيل (`/delivery` و`/reception`)، استعلام الإرساليات المفتوحة (`listOpenConsignments`)، حقل البحث التنبؤي الذكي (`PredictiveConsignmentSearchInput`)، وجدول ذمة الطرود والإرساليات المسندة  
**البروتوكولات المفعلة:** Sub-Agents Network, V.E.R.I.F.Y Protocols, Zero-Hallucination & Fact-Check, Closed-Loop Auto-Correction  

---

## ١. المطلب الجوهري وتوصيف الخلل

أبلغ المالك عن خلل تشغيلي ظهر خلال اليومين الأخيرين:
> «عدم ظهور الفواتير المسندة لجهة التوصيل في جدول فواتيره التي هي في ذمته حتى يتم البحث عليها أو كتابة رقم الفاتورة فتظهر أنها لهذه الجهة ويطلب إثبات ذلك وهذا غير منطقي.  
> ففي الأصل يجب أن تظهر الفواتير المسندة إلى جهة التوصيل فور إسنادها وتظهر بالبحث ودون البحث ومرتبطة بالجهة المسندة إليها وبذمتها وجدولها.»

---

## ٢. التحقيق الجنائي والأسباب الجذرية

أظهر التحقيق الجنائي الشامل المطابق لبروتوكول V.E.R.I.F.Y المكون من ١٢ مرحلة سبباً مزدوجاً:

### أ) الانقطاع الخادمي في استعلام الإرساليات المفتوحة (`server/services/delivery/queries.ts`):
1. في 24 سبتمبر 2026 (PR #1236)، تم تعديل دورة الإسناد الذري بحيث تنشأ الإرساليات مباشرة بحالة `parcelStatus: 'OUT_FOR_DELIVERY'` بدلاً من `ASSIGNED`.
2. استعلام `listOpenConsignments` كان يقيد شمول الطرود بالطريق (`ACCEPTED`, `PICKED_UP`, `OUT_FOR_DELIVERY`) لشركات التوصيل فقط عبر شرط `deliveryParties.partyType = 'COMPANY'`، بينما للمندوب الفردي (`INDIVIDUAL`) كان يشترط `parcelStatus IN ('ASSIGNED', 'FAILED')` أو `DELIVERED`.
3. وبسبب هذا القيد، سقطت جميع الفواتير المسندة حديثاً للمناديب الأفراد من استعلام `listOpenConsignments`، فكانت تظهر في بطاقة الملخص الرأسي التراكمية («طرود في الطريق: 152,000 د.ع» المشتقة من `computePartyExposure`)، بينما يفرغ الجدول التشغيلي أدناه منها («الطرود والإرساليات المسندة (0)»).

### ب) الارتهان غير المنطقي في البحث التنبؤي الذكي (`client/src/components/reception/ReceptionCollectSection.tsx`):
1. عند بحث المستخدم عن الفاتورة المخفية واختيارها من القائمة التنبؤية، كان المعالج `handleSelectPredictiveParcel` يطلق تلقائياً نافذة تأكيد قسرية: `confirm("إثبات تسليم الطرد وقبض المبلغ")`.
2. هذا السلوك فرض على المستخدم إثبات تسليم طرد لا يزال في الطريق مع المندوب لمجرد البحث عنه واستعراضه.

---

## ٣. المعالجات الهندسية المنفذة

### ١. تحرير استعلام الإرساليات المفتوحة (`server/services/delivery/queries.ts`):
- توحيد شرط الإرساليات المفتوحة (`openCandidate`) لكافة جهات التوصيل (شركات ومناديب أفراد على حد سواء):
  ```typescript
  const openCandidate = and(
    inArray(deliveryConsignments.status, ["DISPATCHED", "PARTIAL"]),
    sql`${deliveryConsignments.parcelStatus} NOT IN ('CANCELLED','RETURNED')`,
    sql`${deliveryConsignments.moneyStatus} IN ('UNSETTLED','PARTIAL','NOT_APPLICABLE')`,
  );
  ```
- ظهور الفاتورة فور إسنادها للمندوب في جدول ذمته المفتوحة بحالة `OUT_FOR_DELIVERY` مع شارة «في الطريق» وزر «تأكيد التسليم».

### ٢. إصلاح تفاعل البحث التنبؤي الذكي (`client/src/components/reception/ReceptionCollectSection.tsx`):
- عند اختيار إرسالية من البحث التنبؤي:
  - التحويل التلقائي للجهة المسند إليها (`switchCollectParty`).
  - تفعيل فلترة الجدول على رقم الفاتورة أو الإرسالية المحددة (`setParcelFilter`).
  - إلغاء ظهور نافذة التأكيد القسرية عند مجرد البحث أو الاختيار.
  - إبقاء زر «تأكيد التسليم» متاحاً داخل سطر الجدول لاستخدامه عند عودة المندوب الفعلي والتسليم الميداني.

### ٣. توسيع أهلية الإرجاع المباشر في جدول التسوية (`client/src/components/delivery/DeliveryConsignmentsTable.tsx`):
- شمول حالات `OUT_FOR_DELIVERY` و`ACCEPTED` و`PICKED_UP` في `isReturnable` لمطابقة محرك الإرجاع الخادمي `returns.ts`.

---

## ٤. التحقق والاختبارات الآلية

- **اختبارات وحدة الانحدار:**
  - إضافة اختبار `listOpenConsignments — ظهور الفواتير المسندة للمندوب فورياً وبذمته` في `deliveryBoardSettlement.test.ts` (اجتاز بنجاح تام).
  - تحديث وتمرير `deliveryInTransitVisibility.test.ts` و`deliveryPagination.test.ts`.
  - تشغيل الحزمة الكاملة لمنظومة التوصيل: **28 ملف اختبار، 218 اختباراً ناجحاً بنسبة 100% (0 فشل)**.
- **الحرّاس وفحص الأنواع:**
  - `pnpm check`: اجتياز كامل بدون أي خطأ في الأنواع (0 errors).
  - `pnpm check:guards`: اجتياز كامل الحرّاس بنجاح تام (100% GREEN).
