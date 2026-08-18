# دليل تشغيل ومراقبة R2 لصور المنتجات

## عقد التشغيل

- الـBucket خاص، ولا توجد قراءة مباشرة للمتجر. التطبيق يخدم المشتق المعتمد بعد بوابات الشركة
  والمنتج وحالة المراجعة وبصمة المحتوى.
- لا سقوط من R2 إلى `fs` في الإنتاج. غياب السائق يبقي legacy MySQL read-only ويوقف عمليات
  الاستوديو؛ اعتماد R2 ناقص أو حدود غير صحيحة يفشل عند الإقلاع.
- حدود كل worker افتراضياً: 4 in-flight، 8 queued (hard cap=16)، مهلة طابور 2s. الإجمالي النظري هو
  `WEB_INSTANCES × R2_MAX_CONCURRENCY` (مثلاً 3×4=12)، والطابور الكلي 3×8=24. رفع الحدود يحتاج
  benchmark للذاكرة والـlatency؛ closure رفع واحد قد يحتفظ حتى 25 MiB، أي 200MiB queued افتراضياً
  و400MiB عند hard cap لكل worker. Buffer العرض العام مقيد بعقد submit المنشور 900kB، أي 3.6MB
  كحد أقصى لكل worker عند التوازي الافتراضي.
- القاطع محلي لكل worker: 5 أعطال عابرة متتالية تفتحه 30s، ثم half-open بمسبار واحد. نجاح المسبار
  يغلقه، وفشله يعيد فتحه. 404 لا يُعد فشلاً، و401/403/validation لا تُحوّل إلى fallback.

## فحص ما قبل التفعيل

1. أنشئ اعتماد S3 محدوداً بالـBucket للقراءة/الكتابة/الحذف، وخزّنه في مدير الأسرار فقط. أنشئ
   اعتماداً آخر للمرآة بصلاحية القراءة فقط، وAPI Token مؤقتاً يقرأ إعدادات R2 من Cloudflare API.
2. تأكد من تعطيل Public Access و`r2.dev` وإزالة كل custom domain للـBucket. الـcanary يثبت ذلك من
   [managed-domain API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/domains/subresources/managed/methods/list/)
   و[custom-domain list API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/domains/subresources/custom/methods/list/)؛
   403/404 من S3 وحده ليس دليلاً لأن مسارات النشر مستقلة. كذلك يلزم Bucket Lock مفعّل مدة 90
   يوماً على `single/studio/` و`company-` وصفر lifecycle delete؛ `company-` قاعدة حرفية واسعة
   تغطي كل `company-{id}/studio/` الحالية والمستقبلية لأن Bucket Lock لا يدعم wildcard. يقرأها canary من
   [Lock API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/locks/)
   و[Lifecycle API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/lifecycle/).
   لا تغطِّ `canary/` بالقفل.
3. شغّل المرآة الباردة الأولية من جهاز/قرص مستقل (copy لا sync)، ثم verify وتمرين استعادة فعلي
   لعينة إلى مجلد منفصل. لا تُكمل إذا لم تطابق SHA-256:

   ```bash
   R2_MIRROR_CONFIRM=RUN_CUMULATIVE_PRIVATE_R2_MIRROR \
     R2_COLD_MIRROR_DIR='/external/private-r2-mirror' \
     node scripts/r2-cold-mirror.mjs
   R2_MIRROR_MODE=verify R2_MIRROR_CONFIRM=RUN_CUMULATIVE_PRIVATE_R2_MIRROR \
     R2_COLD_MIRROR_DIR='/external/private-r2-mirror' \
     node scripts/r2-cold-mirror.mjs
   R2_MIRROR_MODE=restore-drill R2_MIRROR_CONFIRM=RUN_CUMULATIVE_PRIVATE_R2_MIRROR \
     R2_COLD_MIRROR_DIR='/external/private-r2-mirror' \
     R2_DR_RESTORE_DIR='/another-device/r2-drills/2026-08-18' \
     R2_DR_SAMPLE_LIMIT=5 \
     node scripts/r2-cold-mirror.mjs
   ```

   الأداة تتحقق من كل ملفات manifest، حتى الملفات التي لم تعد في المصدر، وتحتفظ بها. ثبّت بصمة
   manifest وبصمة `receipt.json` في متغيري إصدار محميين عند فتح نافذة GC. لا تقبل timestamp
   يدوياً: يجب أن يبقى الإيصال وملفات وجهة الاستعادة المستقلة متاحين للقراءة كي يعيد GC إثباتهما.
4. شغّل canary في shell آمنة بلا تسجيل أو `set -x`:

   ```bash
   IMAGE_STORE_DRIVER=r2 R2_CANARY_CONFIRM=RUN_PRIVATE_R2_CANARY \
     R2_CANARY_CLOUDFLARE_API_TOKEN='<temporary-read-token>' \
     node --import tsx scripts/r2-image-store-canary.mjs
   ```

5. النجاح الوحيد المقبول:

   ```text
   R2 canary: OK bytes=<n> privacy=403|404 cleanup=verified
   ```

   الفشل يطبع code عاماً فقط. راجع سجلات Cloudflare/الشبكة خارج الطرفية، ولا تنسخ سرّاً إلى تذكرة.
   الأداة تستعمل مفتاحاً عشوائياً تحت `canary/r2-image-store/` وتحذف في `finally` ثم تؤكد غيابه.
   cleanup يستعمل عميلاً قصير المهلة خاصاً بالـCLI خارج circuit/queue التطبيق، كي لا يمنع قاطع فُتح
   بعد PUT غير محسوم حذف المفتاح؛ هذه البوابة غير مصدرة إلى runtime التطبيق.
6. بعد النجاح، فعّل متغيرات R2 في نافذة نشر عادية وشغّل `pnpm prod:deploy`. لا تشغل canary عبر
   endpoint HTTP ولا تجعل تأكيده متغيراً دائماً في خدمة PM2.

## المقاييس والسجلات

`getImageStoreResilienceSnapshot()` يعيد لقطة محلية بلا bucket/key/اعتماد:

- `state`, `inFlight`, `queued`, `consecutiveFailures`؛
- `started`, `succeeded`, `transientFailures`, `permanentFailures`, `notFound`, `cancelled`؛
- `opened`, `circuitRejected`, `queueRejected`, `queueTimeouts`, `publicFallbacks`, `lastTransitionAt`.

الانتقالات ورفض الطابور تسجل بنيوياً تحت `component=r2_image_store` بلا مفتاح كائن. المقاييس
per-worker وليست تجميعاً عالمياً. التنبيه المقترح: أي `state=open`، أو زيادة `queueRejected`، أو
نسبة `transientFailures / started > 2%` لخمس دقائق. `notFound` مؤشر سلامة مراجع، لا outage.

رد fallback يحمل `X-Image-Fallback: thumbnail` و`Cache-Control: no-store`. ارتفاعه يعني degraded
mode: المتجر بقي قابلاً للعرض لكنه لا يثبت المصغرة في الكاش. لا fallback بلا `thumbDataUrl` آمنة؛
حينها 503. مسار الكشك الخاص لا يستعمل fallback، ولا يُخدم `originalKey` مطلقاً.

المصغرة ليست نسخة أصل ثانية: تُولّد في المتصفح من الناتج النهائي بحد 320px/128KiB WebP، وتُربط
بأبعاد المرشح داخل نفس قفل submit/approve. pending يحتفظ بها مؤقتاً للمراجعة فقط، ثم تُمسح من job
بعد النسخ إلى صف الصورة المعتمدة. أي malformed/oversize/mismatch أو عبث بين submit وapprove يرفض
الاعتماد؛ لا معالجة صور ثقيلة ولا مكتبة codec جديدة على الـVPS.

## الاستجابة للحوادث والتراجع

1. إذا فتح القاطع: لا ترفع الحدود. تحقق من Cloudflare status، DNS، egress، صلاحية Token وحصة R2.
2. AccessDenied ليس outage عابراً ولن يفتح القاطع؛ صحح الاعتماد/Policy ثم أعد canary.
3. كثرة 404 تعني مرجع DB بلا كائن: ثبّت `R2_GC_MODE=audit`، افحص سجل approve/GC ومرآة النسخ،
   ولا تخفها بالمصغرة.
4. للتراجع أثناء انتقال legacy فقط: أزل `IMAGE_STORE_DRIVER` وأعد النشر؛ تبقى المنصة online بصور
   MySQL القديمة والاستوديو fail-closed. بعد اعتماد صور object-only، لا تفعل ذلك بلا خطة بيانات.
5. لا تحوّل إلى `fs` ولا تنسخ originals إلى VPS. لا تحذف يدوياً من الـBucket. GC audit-only
   افتراضياً؛ delete يحتاج 90 يوماً من فقد المرجع + manifest حديثة وبصمتها + إيصال restore-drill
   حديث وبصمته وملفات وجهته السليمة + الإقرار
   الصريح. الـcanary وحده يحذف مفتاحه المحجوز خارج Bucket Lock.
