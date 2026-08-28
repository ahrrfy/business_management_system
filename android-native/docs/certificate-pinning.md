# تثبيت الشهادة (Certificate Pinning) — سوبر العربية

> **المضيف الإنتاجيّ:** `srv1548487.hstgr.cloud` (Hostinger VPS، شهادة Let's Encrypt).
> **الملف الحاكم:** [`app/src/main/res/xml/network_security_config.xml`](../app/src/main/res/xml/network_security_config.xml).

## ١. لماذا هذا الأمر بالغُ الحساسيّة (bricking risk)

Certificate Pinning يُلزم التطبيقَ برفض أيّ شهادةٍ لا يُطابق SPKI (Subject Public
Key Info) بصمتَها SHA-256 إحدى القيم المُثبَّتة في APK/AAB. هذا يُغلق فئةً كاملة
من هجمات MITM (شهادةٌ خبيثة موقَّعة من CA مضغوط، wifi عامّ يعترض TLS، وكيلٌ
مؤسّسيّ يفكّ التشفير…)، **لكنه يجعل التطبيق هشّاً بنيوياً**:

- **pin واحد فقط ⇒ bricking عند أوّل تدوير.** حين تُجدَّد شهادة الخادم (كلّ ~٦٠
  يوماً مع Let's Encrypt) يتغيّر SPKI في الغالب، فيرفض التطبيقُ الشهادة الجديدة
  ولا يتّصل بالخادم. الحلّ الوحيد: نسخةٌ جديدة من APK — وهي بالنسبة لتطبيقٍ على
  Play قد تستغرق ساعات (Internal testing) أو أياماً (Production).
- **placeholder ⇒ فشل TLS فوريّ.** القيم الحاليّة في XML هي `PLACEHOLDER_…==`،
  لن تُطابق أيّ شهادة. **لا تُطلق أيّ AAB إلى Play قبل استبدالها فعلياً.**
- **حسابات Play الشخصيّة (كما هو حالنا) لا تحتمل الخطأ:** لا مسار Rollback
  فوريّ، والمستعملون في العراق قد لا يُحدّثون تلقائياً.

قاعدة السلامة: **دائماً pinان — نشِط + احتياطيّ**، والاحتياطيّ لشهادة التدوير
التالية (نُصدرها مسبقاً على الخادم كـstaging cert قبل أن تصير حيّة).

## ٢. استخراج قيم SPKI SHA-256 قبل النشر

من أيّ ماكينة تصل إلى الإنترنت (لا تحتاج ssh للـVPS):

```bash
openssl s_client -connect srv1548487.hstgr.cloud:443 -showcerts </dev/null 2>/dev/null \
  | openssl x509 -pubkey -noout \
  | openssl pkey -pubin -outform DER \
  | openssl dgst -sha256 -binary \
  | openssl enc -base64
```

خرج المثال: `abcDEF123…=` (٤٤ حرفاً ينتهي بـ`=`). هذه قيمة **pin النشِط**.

للاحتياطيّ: نفس الأمر على شهادةٍ ثانية (يمكن توليدها مسبقاً بـcertbot بمفتاحٍ
مختلف، أو استعمال بصمة CA intermediate إن قبلت المخاطرة — الأفضل leaf).

استبدل القيمتَين في `network_security_config.xml` (سطرا `<pin digest="SHA-256">…`)،
ثمّ ابنِ AAB جديداً وارفعه.

## ٣. دورة التدوير عند تجديد Let's Encrypt

certbot على الـVPS يُجدّد الشهادة كلّ ~٦٠ يوماً آلياً (راجع
`docs/deployment-vps.md` وذاكرة `certbot-timer-blocked-deploy-2026-08-16.md`).
الإجراء البشريّ عند كلّ تجديد:

1. **قبل** أن تصير الشهادة الجديدة حيّة (window ~٣٠ يوماً): استخرج SPKI SHA-256
   للشهادة القادمة على الخادم مباشرةً من `/etc/letsencrypt/live/<host>/cert.pem`.
2. حرّك القيم في XML: **backup → active**، ثمّ ضع الجديدة في **backup**.
3. ارفع `versionCode` (احرس بـ`pnpm check:mobile-release`) وأطلق AAB جديداً إلى
   Internal testing. تأكّد أنّ ≥٩٥٪ من المستعملين حدّثوا قبل التدوير الفعليّ.
4. حدّث `expiration` في `<pin-set>` إلى تاريخٍ يسبق انتهاء الاحتياطيّ بشهر.
5. عند التدوير الفعليّ على الخادم: راقب Sentry/logs لأيّ `SSLHandshakeException`.
