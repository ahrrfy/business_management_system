# تشغيل تخزين صور المنتجات في Cloudflare R2

هذه الشريحة تضيف سائق `R2ImageStore` خلف عقد `ImageStore` فقط. لا تنقل صوراً قديمة ولا تغيّر
مسارات الرفع أو واجهات المنتج؛ تبقى خطوة القراءة المزدوجة والترحيل والكنس في شرائح مستقلة.

## ثوابت الأمان

- الـBucket **خاص**: لا Public Access ولا ACL عام ولا رابط كائن مباشر في المتجر.
- مرحلة الانتقال الحالية تبقي `IMAGE_STORE_DRIVER` غير مضبوط فتستمر الصور القديمة من MySQL ولا
  تستدعي السائق الجديد. عند ضبط السائق صراحةً يفشل الإقلاع إذا كان `fs` في الإنتاج أو كان اعتماد
  R2 ناقصاً؛ لا يوجد سقوط إلى قرص الـVPS.
- المفتاح خادمي ومقيد بالحروف الآمنة، والبايتات تقبل صور JPEG/PNG/WebP/GIF/AVIF فقط حتى 25 MiB.
- PUT متعادِل: يفحص السائق المفتاح المعنون بالمحتوى قبل الكتابة. GC **تدقيقي افتراضياً**؛ أول
  إثبات لغياب آخر مرجع يبدأ نافذة 90 يوماً ولا يرسل `DeleteObject`. الحذف يحتاج معاً إقراراً
  صريحاً، وmanifest مرآة حديثة مثبتة بالبصمة، وتمرين DR حديثاً.
- اتصالات R2 محدودة زمنياً: 5 ثوانٍ للاتصال، 20 ثانية للطلب، و15 ثانية لخمول المقبس، مع ثلاث
  محاولات كحد أقصى؛ لا يبقى worker أو طلب HTTP معلّقاً بلا حد عند تعثّر المزوّد.
- لكل worker حدّ 4 عمليات R2 متزامنة وطابور 8 لمدة ثانيتين. لا نمو غير محدود للذاكرة؛ عند الامتلاء
  يفشل الطلب سريعاً. القاطع يفتح بعد 5 أعطال عابرة متتالية لمدة 30 ثانية ثم يسمح بمسبار واحد.
  404 وAccessDenied وأخطاء الإدخال لا تفتح القاطع؛ وحدها الشبكة/المهلة/429/5xx تُحتسب.
- عند عطل عابر فقط، يمكن لنقطة المنتج **العامة المعتمدة** خدمة `thumbDataUrl` من الصف نفسه.
  الرد `no-store` كي لا تثبت المصغرة مكان المشتق، ولا يحدث ذلك لمسار الكشك الخاص، أو الأصل، أو
  pending/rejected، أو 404، أو AccessDenied، أو بصمة/مستأجر غير صحيح.
- المتصفح يعيد ترميز الناتج النهائي إلى WebP بخلفية بيضاء وأطول ضلع 320px. الخادم يفك base64
  ويتحقق من RIFF/chunk وإطار VP8/VP8L والحجم ≤128KiB والأبعاد المطابقة للمرشح، ويحفظها مؤقتاً
  في المهمة المقفولة. عند الاعتماد يعيد التحقق، ينقلها إلى `productImages.thumbDataUrl`، ويمسح
  نسخة المهمة كي لا تتراكم. الاستبدال اليدوي للبايتات يمسح المصغرة وكل metadata الخاصة بالكائن.
- الروابط الموقعة اختيارية ومحدودة بين 30 و3600 ثانية، ولا تكون بديلاً عن بوابة صلاحيات التطبيق.

## إعداد الإنتاج

1. أنشئ Bucket R2 باسم DNS صالح و**خاصاً**. لا تعتمد على Object Versioning: عقد الحماية هنا هو
   Bucket Lock + مرآة باردة مستقلة. أضف Bucket Lock مفعّلاً لمسار `single/studio/` بشرط
   `Age >= 7776000` ثانية (90 يوماً). لا تجعل القفل عاماً ولا تغطِّ `canary/r2-image-store/` كي
   يستطيع canary تنظيف كائنه المحجوز.
2. أنشئ API Token أقل صلاحية محصوراً بالـBucket: Object Read/Write/Delete فقط. لا تستخدم مفتاح
   Cloudflare العالمي، ولا تضعه في المتصفح أو Git.
3. لا تضبط `IMAGE_STORE_DRIVER` قبل اكتمال بوابة الرفع والترحيل. عند نافذة الانتقال ضع أسرار
   التشغيل في escrow/مدير الأسرار فقط:

   ```text
   IMAGE_STORE_DRIVER=r2
   R2_ACCOUNT_ID=<account id>
   R2_IMAGE_BUCKET=<private bucket name>
   R2_ACCESS_KEY_ID=<token access key>
   R2_SECRET_ACCESS_KEY=<token secret>
   R2_MAX_CONCURRENCY=4
   R2_MAX_QUEUE=8
   R2_QUEUE_TIMEOUT_MS=2000
   R2_CIRCUIT_FAILURE_THRESHOLD=5
   R2_CIRCUIT_OPEN_MS=30000
   ```

4. لا تضبط أي `deleteObjectsTransition` في Lifecycle، مهما كانت مدته. يسمح فقط بإجهاض multipart
   غير المكتمل أو انتقال storage class. Bucket Lock هو مانع الحذف المبكر، وسياسة التطبيق تحسب
   90 يوماً إضافية من أول إثبات لفقد آخر مرجع.
5. أنشئ المرآة الأولية على جهاز/قرص خارج خادم التطبيق، ثم تحقق منها. الأداة تراكمية: تنسخ وتتحقق
   وتحتفظ بما اختفى من المصدر؛ لا تحتوي sync أو حذفاً:

   ```bash
   R2_MIRROR_CONFIRM=RUN_CUMULATIVE_PRIVATE_R2_MIRROR \
     R2_COLD_MIRROR_DIR='/external/private-r2-mirror' \
     R2_MIRROR_PREFIX='single/studio/' \
     node scripts/r2-cold-mirror.mjs

   R2_MIRROR_MODE=verify R2_MIRROR_CONFIRM=RUN_CUMULATIVE_PRIVATE_R2_MIRROR \
     R2_COLD_MIRROR_DIR='/external/private-r2-mirror' \
     node scripts/r2-cold-mirror.mjs
   ```

   استعمل اعتماد S3 منفصلاً للقراءة فقط. تحفظ الأداة `manifest.json` و`manifest.sha256` بصلاحية
   محلية ضيقة، وتطبع الأعداد والبصمة فقط بلا account/bucket/key/path.
6. قبل ضبط `IMAGE_STORE_DRIVER=r2` على أي خادم إنتاج: نفّذ canary المعزول أدناه. يختبر
   `put → head → GET غير مصادق (403/404) → getStream+SHA-256 → delete → head(absent)` ويحذف في
   `finally` حتى عند الفشل. لا يطبع account/bucket/key/URL أو تفاصيل SDK:

   ```bash
   IMAGE_STORE_DRIVER=r2 R2_CANARY_CONFIRM=RUN_PRIVATE_R2_CANARY \
     R2_CANARY_CLOUDFLARE_API_TOKEN='<temporary Workers R2 Storage Read token>' \
     node --import tsx scripts/r2-image-store-canary.mjs
   ```

   يستعلم canary من Cloudflare API عن `r2.dev` وcustom domains وBucket Lock وLifecycle قبل PUT
   وبعده: يلزم `r2.dev=off` وصفر custom domains وقفل `single/studio/` لمدة 90 يوماً وصفر lifecycle
   delete، كما يرفض أي قفل يغطي `canary/`. أي فشل يبقي السائق غير مضبوط؛ يعمل الخادم والمتجر بصور
   MySQL القديمة وتبقى عمليات الاستوديو متوقفة برسالة إعداد واضحة، ولا سقوط إلى قرص الـVPS.

## حذف GC المحكوم

لا يلزم أي متغير للحالة الطبيعية: `R2_GC_MODE=audit` أو غيابه يعني صفر `DeleteObject`. عند أول
مسح بلا مرجع يتحول الصف إلى `PENDING` ويثبت `referencedAt` كبداية للاحتفاظ؛ `touchedAt` يبقى وقت
آخر تدقيق حتى لا يحتكر صف واحد الدفعات الصغيرة. بعد 90 يوماً يبقى Audit فقط.

نافذة الحذف الاستثنائية تحتاج **كل** الآتي، وإلا يفشل العامل مغلقاً:

```text
R2_GC_MODE=delete
R2_GC_DELETE_CONFIRM=DELETE_RETAINED_R2_OBJECTS
R2_GC_MIRROR_MANIFEST=/absolute/external/manifest.json
R2_GC_MIRROR_MANIFEST_SHA256=<sha256 المثبتة في متغير إصدار محمي>
R2_GC_DR_VERIFIED_AT=<UTC ISO timestamp لتمرين استعادة ناجح>
```

يلزم أن يكون manifest مكتمل التحقق خلال 7 أيام، وأن يثبت الكائن نفسه وبصمته المعنونة بالمحتوى،
وأن يكون تمرين DR خلال 90 يوماً. لا تحفظ إقرار delete دائماً؛ أعد الوضع إلى audit بعد النافذة.

تفاصيل المراقبة والتراجع في [دليل تشغيل R2](runbooks/r2-image-storage.md).

## التطوير والاختبار

يستعمل التطوير `IMAGE_STORE_DRIVER=fs` فقط. لا تضع متغيرات R2 محلية بلا حاجة. اختبارات السائق
تستبدل S3 client بمزوّد وهمي ولا تتصل بالشبكة أو تتطلب أي سر. لا تشغّل الـcanary في CI ولا
تضع أسرار R2 في متغيرات CI العامة؛ هو فحص تشغيلي واعٍ بإقرار صريح.

## ما لا تفعله هذه الشريحة

- لا تُفعّل R2 دون الإعدادات أعلاه.
- لا ترحّل الصور القديمة ولا تحذف `url`/بيانات الصور من MySQL.
- لا تجعل endpoint قابلاً للإدخال من الطلبات أو من متغير بيئة حر؛ السائق يشتقه حصراً من Account ID.
- لا تضف Versioning كشرط وهمي غير متحقق؛ الإثبات الآلي هو Bucket Lock والمرآة وDR.
