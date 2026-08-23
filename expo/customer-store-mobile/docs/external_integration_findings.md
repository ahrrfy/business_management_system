# ملاحظات تكامل تطبيق مكتبة العربية

## واجهة متجر العملاء الحالية

يعمل التطبيق الجديد كمستهلك لواجهة العملاء العامة في `https://alarabiya.online/api/trpc`. المسارات المسموح بها تخص `storefront.*` فقط، ولا تكشف تكلفة المنتج أو كمية المخزون أو واجهات الموظفين. تم التحقق بنجاح من استعلامي `storefront.categories` و`storefront.catalog` في 19 أغسطس 2026.

| المسار | الاستخدام في التطبيق | الضوابط القائمة |
|---|---|---|
| `storefront.categories` | عرض تصنيفات المكتبة | قراءة عامة ببيانات تسويقية فقط. |
| `storefront.catalog` | عرض الكتالوج والأسعار والتوفر | صفحات محددة، وحد أقصى للخادم، ولا يعرض كمية المخزون. |
| `storefront.product` | تفاصيل المنتج | بيانات آمنة للعميل مع سعر مفرد وتوفر. |
| `storefront.trackOrder` | تتبع طلب برقم الطلب والهاتف | لا يكفي رقم الطلب وحده للوصول إلى بيانات العميل. |
| `storefront.createOrder` | إنشاء طلب حقيقي | يعيد الخادم تسعير الطلب، ويستخدم معرف طلب idempotent، ويتطلب تحققاً أمنياً. |

## ملاحظة تحقق الطلبات من التطبيق الأصلي

تستخدم خدمة الطلبات الحالية Cloudflare Turnstile. توثق Cloudflare أن Turnstile لا يعمل كمكوّن React Native أصلي؛ يلزم WebView ضيق مخصص للتحقق الأمني، وليس تغليف المتجر كله. سيظل تطبيق مكتبة العربية أصلياً؛ وتكون نافذة التحقق جزءاً محدوداً فقط من إرسال الطلب.

المصدر: [Cloudflare Turnstile Mobile implementation](https://developers.cloudflare.com/turnstile/get-started/mobile-implementation/)، آخر تحديث ظاهر 5 مايو 2026.

## متطلبات النشر التي جُمعت

Google Play يعتمد Android App Bundle ويطلب إعداد محتوى التطبيق وإفصاح Data safety وسياسة خصوصية. Apple تطلب عضوية Apple Developer مدفوعة للنشر العام، وتلزم بإفصاح خصوصية التطبيق قبل الإرسال.

المصادر: [Google Play: إنشاء وإعداد التطبيق](https://support.google.com/googleplay/android-developer/answer/9859152?hl=en)، [Google Play: Data safety](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en)، [Apple: Submitting apps](https://developer.apple.com/app-store/submitting/)، [Apple Developer Program](https://developer.apple.com/programs/).
