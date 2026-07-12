# تغليف المتجر كتطبيق أندرويد على Google Play (TWA)

> **الهدف:** نشر متجر الرؤية العربية (`alarabiya.online`) كتطبيق أندرويد أصيل على متجر Play عبر
> **TWA (Trusted Web Activity)** — غلافٌ رقيق يعرض الـPWA ملء الشاشة بلا شريط عنوان (لا يبدو متصفّحاً)،
> بنفس الكود والتحديثات الحيّة (أي تحديث للموقع يظهر فوراً في التطبيق بلا إعادة نشر على Play).
>
> **لماذا TWA لا تطبيق أصيل:** الكود واحد (الـPWA القائم)، التحديث فوريّ، والصيانة صفر — نفس فلسفة
> «منصّة واحدة، ثلاثة أدوار» (الزبون=المتجر، الموظف=النظام، المندوب=توصيلاتي). التطبيق يغلّف الأصل كلّه،
> فالزبون يهبط على `/store` والموظف/المندوب يدخلان بحساباتهما لشاشاتهما — تطبيقٌ واحد.

---

## ما جُهِّز في المستودع (جاهز)

| العنصر | المكان | الوظيفة |
|---|---|---|
| مسار Digital Asset Links | `server/wellKnown.ts` (مُسجَّل في `server/index.ts` قبل catch-all الـSPA) | يخدم `/.well-known/assetlinks.json` من متغيّرات البيئة — يربط التطبيق بالأصل فيُزال شريط العنوان |
| إعداد Bubblewrap | `twa/twa-manifest.json` | يولّد مشروع أندرويد + الحزمة AAB بمقاسٍ واحد أمر |
| هذا الدليل | `docs/twa-android-setup.md` | الخطوات + الأفعال المطلوبة منك |

الـPWA نفسه مُعدٌّ مسبقاً (`vite.config.ts` → VitePWA: manifest بـ`display:standalone` + أيقونات 192/512/maskable + `theme_color` + service worker autoUpdate).

## ما يحتاج فعلك (المالك)

توقيعُ التطبيق (keystore)، أسرار البيئة، تشغيل بناء Bubblewrap على جهازك، ورفع الحزمة إلى Play Console — لا يمكن أتمتتها من داخل المستودع (تتطلّب حسابك وأدواتك المحلّية).

---

## المتطلّبات (على جهازك، مرّة واحدة)

- **Node 18+** و**JDK 17** (Temurin/OpenJDK) — Bubblewrap يحتاج Java.
- **Bubblewrap CLI:** `npm i -g @bubblewrap/cli` (يُنزّل Android SDK تلقائياً عند أوّل تشغيل).
- حساب **Google Play Console** (رسم تسجيل مطوّر ٢٥$ لمرّة واحدة).
- التأكّد أنّ `https://alarabiya.online` يعمل بـTLS ويخدم الـPWA (DNS + nginx — راجع `docs/store-domain-setup.md`).

---

## الخطوات بالترتيب

### ١) أنشئ مفتاح التوقيع (keystore)

```bash
keytool -genkeypair -v -keystore twa/android-keystore.jks \
  -alias upload -keyalg RSA -keysize 2048 -validity 9125 \
  -storepass <كلمة-مرور-قوية> -keypass <كلمة-مرور-قوية>
```
> ⛔ **احفظ الـkeystore وكلمتَي المرور في مكانٍ آمن (escrow) — فقدانها يمنع تحديث التطبيق لاحقاً.**
> لا تلتزم الـkeystore في git (مُدرَج في `.gitignore`). يُفضَّل تفعيل **Play App Signing** (خطوة ٥) فتحتفظ
> Google بمفتاح التوقيع النهائيّ وتبقى أنت بمفتاح الرفع فقط.

### ٢) استخرج بصمة SHA-256

```bash
keytool -list -v -keystore twa/android-keystore.jks -alias upload -storepass <كلمة-المرور> \
  | grep -i "SHA256"
```
انسخ القيمة (مثل `AB:CD:12:...:EF`). **إن فعّلت Play App Signing (مستحسَن):** خذ أيضاً بصمة SHA-256
لمفتاح توقيع Play من: Play Console → تطبيقك → **Setup → App signing** → «App signing key certificate».
**أضِف كلتا البصمتين** في الخطوة التالية (وإلّا فشل التحقّق للنسخة الموزَّعة من Play).

### ٣) اضبط أسرار البيئة على الخادم ثمّ انشر

على VPS في `.env` الخاصّ بالنشر (لا يُلتزم):
```
TWA_ANDROID_PACKAGE=online.alarabiya.store
TWA_SHA256_CERT_FINGERPRINTS=AB:CD:...:EF,11:22:...:99
```
(اسم الحزمة يطابق `packageId` في `twa/twa-manifest.json`؛ البصمات مفصولة بفاصلة — مفتاحك + مفتاح Play.)
ثمّ: `pnpm prod:deploy`. **تحقّق** أنّ الرابط يعيد JSON صحيحاً:
```bash
curl -s https://alarabiya.online/.well-known/assetlinks.json
# يجب أن يعيد مصفوفة فيها package_name والبصمات (لا HTML، ونوع application/json).
```

### ٤) ولّد وابنِ التطبيق (Bubblewrap)

```bash
cd twa
bubblewrap init --manifest ./twa-manifest.json    # أوّل مرّة فقط (يقرأ الإعداد الجاهز)
bubblewrap build                                   # يولّد app-release-signed.aab + .apk
```
> إن سُئلت عن الـkeystore، أشِر إلى `./android-keystore.jks` وaliais `upload`. الناتج AAB للرفع، وAPK للتجربة.

### ٥) جرّب محلّياً قبل الرفع

ثبّت الـAPK على هاتف أندرويد موصول:
```bash
adb install -r app-release-signed.apk
```
افتح التطبيق: **يجب أن يظهر ملء الشاشة بلا شريط عنوان**. إن ظهر شريط العنوان ⇒ فشل التحقّق:
راجع أنّ `assetlinks.json` يُخدَم صحيحاً (خطوة ٣) وأنّ البصمة تطابق مفتاح التوقيع الفعليّ للـAPK.

### ٦) ارفع إلى Play Console

1. Play Console → **Create app** (الاسم «الرؤية العربية»، لغة عربية، تطبيق، مجّاني).
2. **App signing:** فعّل Play App Signing (مستحسَن) — وحينها تأكّد من إضافة بصمة مفتاح Play في الخطوة ٢/٣.
3. **Production → Create release → رفع** `app-release-signed.aab`.
4. أكمِل بطاقة المتجر: أيقونة ٥١٢، صورة رأس، ٢–٨ لقطات شاشة، وصف، **سياسة خصوصية** (إلزامية)، تصنيف المحتوى، الجمهور المستهدف.
5. أرسِل للمراجعة (تستغرق عادةً ساعات إلى أيام).

---

## ملاحظات وفخاخ

- **البصمة المزدوجة (أهمّها):** مع Play App Signing تُعيد Google توقيع التطبيق بمفتاحها ⇒ البصمة الموزَّعة
  ≠ بصمة مفتاح رفعك. **يجب أن يحوي `assetlinks.json` بصمة مفتاح توقيع Play** (وإلّا ظهر شريط العنوان
  لمستخدمي المتجر رغم نجاح تجربتك المحلّية). أضِف الاثنتين معاً في `TWA_SHA256_CERT_FINGERPRINTS`.
- **النطاق:** التحقّق مربوطٌ بالأصل `alarabiya.online` (المُغلَّف). لو غيّرت النطاق، حدّث `host`/`webManifestUrl`
  في `twa-manifest.json` + قدّم assetlinks على النطاق الجديد + أعِد البناء.
- **الإشعارات:** `enableNotifications:false` حالياً لأنّ Web Push معطَّل حتى ضبط مفاتيح VAPID (راجع push).
  فعّلها (`true`) وأعِد البناء بعد تجهيز VAPID، ليصل إشعار «طلب جديد» للمندوب/إشعارات الزبون.
- **التحديثات:** تحديث الموقع = تحديث التطبيق فوراً (لا رفع جديد على Play). ارفع AAB جديداً فقط عند تغيير
  إعداد التطبيق نفسه (الاسم/الأيقونة/الحزمة/`appVersionCode`).
- **الأمان:** الـkeystore + أسرار البيئة لا تُلتزم في git. النطاق مشترك على VPS (خطّ سراج/أودو الأحمر) —
  أيّ تعديل nginx/DNS بموافقتك فقط.
