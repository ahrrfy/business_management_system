# تثبيت شهادة Android (Certificate Pinning) — سوبر العربية

> **الحالة:** مفعّل لإصدار Play الداخليّ v10 على المضيف الدقيق
> `srv1548487.hstgr.cloud`. الملف الحاكم هو
> [`network_security_config.xml`](../app/src/main/res/xml/network_security_config.xml)، وتاريخ انتهاء
> إنفاذ مجموعة الـpins هو `2027-08-01`.

## ١. النطاق والبصمات المعتمدة

عميل ERP الإنتاجي يتصل داخلياً بنطاق واحد فقط. لذلك يستخدم الإعداد
`includeSubdomains="false"` ولا يوسّع الثقة إلى أي نطاق فرعي. روابط WhatsApp والوثائق تُفتح خارج
عميل ERP، واتصالات FCM تديرها مكتبة Google؛ ليست جزءاً من مجموعة pins هذه.

استُخرجت السلسلة الحيّة مع SNI والتحقق النظامي في `2026-08-29`، ثم حُسبت SPKI بطريقتين مستقلتين:
OpenSSL وNode.js `tls`/`X509Certificate`. تطابقت النتيجتان.

| الدور | الشهادة | صلاحية الشهادة (UTC) | SHA-256 للشهادة | SHA-256 لـSPKI بصيغة Base64 |
|---|---|---|---|---|
| نشط | `CN=srv1548487.hstgr.cloud`، المصدر `Let's Encrypt YE1` | `2026-08-09` → `2026-11-07` | `67:38:D0:9C:BA:0D:21:CC:D3:7A:A4:AC:C7:10:00:6E:DD:8A:7D:05:B2:79:98:BA:75:BE:1E:B9:6D:3B:0D:A4` | `heyx24VzgigLNUK/xrMM4IODY0kLR33mjqjg/b8HUPg=` |
| احتياطي تشغيلي | `Let's Encrypt YE1`، المصدر `Root YE` | `2025-09-03` → `2028-09-02` | `A2:37:2D:06:43:1E:97:16:36:5E:EE:D4:7E:C0:20:35:14:97:D1:82:FC:C0:38:E4:57:E5:81:68:A0:3C:AC:07` | `brzvtCELCIZUo4sD/qPX0ccRtPsd3DY6RfmxpOU9oB4=` |

Android يقبل الاتصال إذا طابق **أي** مفتاح عام في السلسلة أحد الـpins. Pin الوسيط `YE1` يسمح
بتجديد شهادة الورقة وتغيير مفتاحها ما دامت السلسلة الجديدة تمر بالوسيط نفسه. ليس بديلاً عن إصدار
تطبيق مسبق إذا تغيّر الوسيط أو مزوّد الشهادة.

انتهاء `pin-set` لا يقطع الاتصال؛ Android يتوقف بعده عن فرض pinning ويرجع إلى مخزن ثقة النظام.
لذلك هو موعد فقدان طبقة الحماية، ويجب إصدار مجموعة مراجعة جديدة قبل `2027-07-01`.

## ٢. الاستخراج والتحقق المستقل

نفّذ من جهاز موثوق يصل إلى الإنترنت. `-servername` إلزامي حتى تُفحص شهادة المضيف الصحيحة عبر SNI،
و`-verify_return_error` يجعل خطأ السلسلة فشلاً صريحاً:

```bash
set -euo pipefail
host='srv1548487.hstgr.cloud'
openssl s_client -connect "${host}:443" -servername "$host" \
  -verify_hostname "$host" -verify_return_error -showcerts </dev/null
```

استخراج pin الورقة الحيّة:

```bash
host='srv1548487.hstgr.cloud'
openssl s_client -connect "${host}:443" -servername "$host" \
  -verify_hostname "$host" -verify_return_error </dev/null 2>/dev/null \
  | openssl x509 -pubkey -noout \
  | openssl pkey -pubin -outform DER \
  | openssl dgst -sha256 -binary \
  | openssl base64 -A
printf '\n'
```

لا تعتمد على أمر الورقة وحده عند التدوير. افصل **كل** شهادات `-showcerts` واحسب SPKI لكل ملف، ثم
طابق واحدة على الأقل مع XML:

```bash
set -euo pipefail
host='srv1548487.hstgr.cloud'
work_dir="$(mktemp -d)"
case "$work_dir" in /tmp/*) ;; *) exit 1 ;; esac
trap 'rm -rf -- "$work_dir"' EXIT

openssl s_client -connect "${host}:443" -servername "$host" \
  -verify_hostname "$host" -verify_return_error -showcerts </dev/null 2>/dev/null \
  | awk -v dir="$work_dir" '
      /-----BEGIN CERTIFICATE-----/ { n += 1; file = sprintf("%s/cert-%02d.pem", dir, n) }
      file != "" { print > file }
      /-----END CERTIFICATE-----/ { close(file); file = "" }
    '

for cert in "$work_dir"/cert-*.pem; do
  openssl x509 -in "$cert" -noout -subject -issuer -dates -fingerprint -sha256
  openssl x509 -in "$cert" -pubkey -noout \
    | openssl pkey -pubin -outform DER \
    | openssl dgst -sha256 -binary \
    | openssl base64 -A
  printf '\n'
done
```

بوابة المصدر لا تحتاج شبكة وتمنع القيم الوهمية أو الانجراف عن النطاق والبصمتين المراجعتين:

```bash
pnpm check:mobile-release
```

## ٣. بروتوكول التدوير بلا قطع الأجهزة

ابدأ هذا البروتوكول قبل تغيير المفتاح أو الوسيط أو مزود TLS، وقبل انتهاء `pin-set` بثلاثين يوماً:

1. افحص للقراءة فقط `certbot certificates` و`systemctl list-timers | grep certbot`، ثم استخرج
   السلسلة الحيّة والأخرى المرشحة واحسب SPKI لكلتيهما. لا تفعّل شهادة مرشحة لا يطابق مسارها أي pin
   موجود في النسخة المنتشرة.
2. إن بقي الوسيط `YE1`، أبق pin الوسيط وبدّل pin الورقة إلى الشهادة الجديدة في إصدار Android تالٍ.
   إن تغيّر الوسيط، أضف SPKI حقيقية من السلسلة الجديدة مع الإبقاء على pin من السلسلة القديمة.
3. شغّل `pnpm check:mobile-release` وفحوص Android الموثقة في README، ثم ابنِ AAB موقّعاً عبر
   `android-release.yml` وارفعه إلى Internal testing.
4. لا تفعّل السلسلة الجديدة على nginx قبل وصول النسخة الجديدة إلى `95%` على الأقل من المختبرين
   وإثبات اتصالها بالسلسلة القديمة. احتفظ بالتداخل بين القديم والجديد خلال نافذة التوزيع.
5. بعد تفعيل الشهادة: أعد استخراج السلسلة من الإنترنت، أثبت أن واحدة على الأقل من SPKI الحية موجودة
   في XML، نفّذ `curl --fail --silent --show-error "https://srv1548487.hstgr.cloud/healthz"`، ثم
   اختبر من نسخة Play على جهاز حقيقي تسجيل الدخول و2FA وتحميل `superApp.bootstrap`.
6. خلال الاختبار راقب `adb logcat` بحثاً عن `SSLHandshakeException`. سجّل SHA للإصدار و`versionCode`
   وموضوع/مصدر الشهادتين وبصماتهما ونتيجة الجهاز. لا تحذف pin القديم قبل تحقق الانتشار والتدوير.

إذا فشل التطبيق بعد تبديل الخادم، فالرجوع الصحيح هو إعادة السلسلة السابقة التي تطابق أحد pins
الموزعة ثم `nginx -t` وreload وفحص الجهاز؛ لا تعالج الانقطاع بإزالة pinning من نسخة جديدة فقط، لأن
الأجهزة المتعطلة لا تستطيع انتظارها بثقة.
