# إصدار تطبيق «سوبر العربية» ورفعه إلى Google Play (المسار الداخليّ)

> **قرار المالك:** التطبيق على Google Play بمسار **Internal testing** فقط — **لا Production ولا مراجعة
> Google** (الحساب شخصيّ). كل خطوةٍ هنا تخدم هذا المسار وحده.

الحزمة (applicationId): `online.alarabiya.store` · التوقيع: **Play App Signing** مُفعَّل (نرفع بمفتاح
الرفع «upload key»، وGoogle يُعيد التوقيع بمفتاح التوزيع). البناء الموقّع يجري في CI حيث تُحفظ الأسرار —
**لا يُبنى الإصدار الموقّع محلياً** (لا مفتاح على الأجهزة).

---

## ١. قبل الإصدار: رفع versionCode

كل تحديثٍ للمختبِرين يلزمه **رفع `versionCode`** (Play يرفض إعادة رفع نفس الرقم). ارفعه في **أربعة
مواضع متزامنة** (يحرس تزامنها `pnpm check:mobile-release`):

1. `android-native/app/build.gradle.kts` → `val productionVersionCode = N`
2. `android-native/app/build.gradle.kts` → تأكيد `verifyProductionReleaseInputs`: `if (productionVersionCode != N …)`
   — ⚠️ **بوّابة الإصدار فقط**؛ إغفالها يُسقط `bundleProdRelease` وحده ولا يظهر في بناء dev (أمسكه Codex على #722).
3. `scripts/verify-mobile-release-env.mjs` → `versionCode: N`
4. `.github/workflows/android-release.yml` → سطر التحقّق `versionCode='N'`

`versionName` (مثل `1.0.0`) يبقى كما هو ما لم تُرِد إصداراً معلَناً جديداً. تحقّق محلياً: `pnpm check:mobile-release`.

> نقطةٌ زمنية (لا تُعمَّم): آخر إصدارٍ مبنيّ حتى ٢٣/٨/٢٠٢٦ = **versionCode 8 · versionName 1.0.0** (#722).
> الرقم التالي = الأعلى المرفوع إلى Play + 1. في بقيّة الدليل `N` = رقم إصدارك الحاليّ.

---

## ٢. بناء الـAAB الموقّع (عبر CI)

البناء الموقّع في workflow **`Native Android release artifacts`** (`.github/workflows/android-release.yml`،
تشغيلٌ يدويّ `workflow_dispatch`). يشترط أوّلاً أن تكون فحوص `main` كلّها خضراء (CI + Security Audit +
Native Android CI) على نفس الـSHA الجاري إصداره.

**التشغيل والمتابعة — التقط رقم الـrun ولا تعتمد على «أحدث run»:**

```bash
git fetch origin main
SHA=$(git rev-parse origin/main)
gh workflow run android-release.yml --ref main
# انتظر ظهور الـrun ثم التقط رقمه بمطابقة SHA الحاليّ لـmain (أحدث run لهذا الـSHA بحدث dispatch):
sleep 8
RUN_ID=$(gh run list --workflow=android-release.yml --event=workflow_dispatch \
  --json databaseId,headSha,createdAt \
  --jq "map(select(.headSha==\"$SHA\")) | sort_by(.createdAt) | last | .databaseId")
echo "RUN_ID=$RUN_ID  SHA=$SHA"
gh run watch "$RUN_ID" --exit-status
```

- **بديلٌ عبر الويب:** GitHub → **Actions** → «Native Android release artifacts» → **Run workflow** → الفرع `main` → Run، ثم افتح الـrun المُنشأ وسجّل رقمه.
- ⚠️ **لا تستعمل `gh run list --limit 1` وحده** لتحديد الـrun: قد يلتقط بناءً سابقاً إن تأخّر ظهور الجديد أو أُطلق إصدارٌ آخر — طابِق `headSha` كما أعلاه.

الـworkflow يبني ويوقّع ويتحقّق (الحزمة + `versionCode` + نقطة النهاية `https://srv1548487.hstgr.cloud`
+ بصمة مفتاح الرفع `ANDROID_UPLOAD_SIGNING_SHA256`)، ثم يمسح بيانات التوقيع. **`release-gate` يشترط أن
يكون SHA الجاري إصداره أخضرَ بالكامل؛ إن دُمج PR آخر أثناء ذلك تحرّك `main` وقد يفشل البابُ ⇒ أعِد
الالتقاط والتشغيل على الـSHA الجديد.**

---

## ٣. تنزيل النواتج

عند اخضرار الـrun، النواتج مرفوعةٌ كأثرٍ باسم **`super-alarabiya-native-<sha>`** (تبقى ١٤ يوماً):

| الملف | الاستعمال |
|---|---|
| `app-prod-release.aab` | **هذا ما يُرفَع إلى Play** |
| `app-prod-release.apk` | تجربةٌ مباشرة على **تثبيتٍ نظيف فقط** (اختياريّ) — انظر التحذير أدناه |
| `mapping.txt` | خرائط R8 لفكّ ترميز تقارير الأعطال — ارفعها لكلّ إصدار |
| `native-android-SHA256SUMS.txt` | بصمات للتحقّق من السلامة |

> ⚠️ **الـAPK المُنتَج موقَّعٌ بمفتاح الرفع**، بينما Play يُعيد توقيع البناء الموزَّع بمفتاح توقيع
> التطبيق (Play App Signing). لذلك **لا يُثبَّت هذا الـAPK فوق بناء Play المثبَّت** (اختلاف الشهادة لنفس
> applicationId يرفضه أندرويد) — صالحٌ للتثبيت النظيف فقط (أو بعد إزالة بناء Play وفقدِ بياناته).
> **اختبار التحديث الطبيعيّ يكون ببناء Play المُوصَّل، لا بهذا الـAPK.**

**التنزيل** (بنفس `RUN_ID` و`SHA` المُلتقطَين في §٢ — لا تعتمد على «أحدث run»):
```bash
gh run download "$RUN_ID" -n "super-alarabiya-native-$SHA" -D ./release-artifacts
```
(أو من صفحة الـrun في Actions → قسم Artifacts.)

---

## ٤. الرفع إلى Play Console (Internal testing)

1. افتح **[Play Console](https://play.google.com/console)** → اختر تطبيق **`online.alarabiya.store`**.
2. من القائمة اليمنى: **Testing → Internal testing**.
3. **Create new release** (أو «Edit release» إن كان مسودّة قائمة).
4. في **App bundles**: **Upload** ثم اختر `app-prod-release.aab`. انتظر معالجة Google.
   - إن ظهر طلبُ تأكيد **Play App Signing** لأوّل مرّة: اقبل الخيار الافتراضي (Google يدير مفتاح التوزيع، وأنت ترفع بمفتاح الرفع). يحدث مرّةً واحدة.
5. **Release name**: يملؤه Play تلقائياً بـ`N (1.0.0)` (رقم إصدارك) — اتركه أو سمِّه بوضوح.
6. **Release notes** (بين وسمَي اللغة): لخّص التغيير للمختبِرين، مثال:
   ```
   <ar-IQ>
   - وسمُ «ماركة مختلفة» للبدائل في قائمة المنتجات (منتجات تُباع تحت اسمٍ واحد بماركات مختلفة).
   - تحسينات ثبات.
   </ar-IQ>
   ```
7. **(موصى به) رفع خرائط فكّ الترميز**: إن لم تُضمَّن تلقائياً، ارفع `mapping.txt` من
   **App bundle explorer → الإصدار → Downloads → Upload deobfuscation file** لتصل تقارير الأعطال مقروءة.
8. **Next / Save** → **Review release** → عالِج أي تحذير (التحذيرات لا تمنع المسار الداخليّ عادةً) →
   **Start rollout to Internal testing** → أكّد.

---

## ٥. توصيل التحديث للمختبِرين

- في **Internal testing → Testers**: تأكّد أنّ قائمة المختبِرين تضمّ الحسابات المطلوبة (بريد Google لكلّ جهاز).
- انسخ **رابط الانضمام (opt-in URL)** من التبويب نفسه وأرسله لمن لم ينضمّ بعد؛ يفتحه المختبِر مرّةً على الجهاز ويقبل.
- التحديث يصل الأجهزة المنضمّة خلال دقائق إلى ساعات عبر متجر Play (أو Play Store → «تحديثاتي»).

---

## ٦. تحقّقٌ بعد الرفع

- **Play Console → Internal testing**: الإصدار بحالة **Available to testers** وبـ`versionCode` الجديد (`N`).
- على جهاز مختبِر: بعد التحديث، افتح **المنتجات** وابحث عن منتجٍ له بديلٌ حقيقيّ ⇒ تظهر شارة **«ماركة مختلفة»** تحت اسم الصنف.

---

## أعطالٌ شائعة

| العطل | السبب / العلاج |
|---|---|
| «Version code N has already been used» | ارفع `versionCode` (§١) وأعد البناء. |
| فشل `release-gate` في الـworkflow | فحوص `main` ليست خضراء بعد على نفس الـSHA — انتظر اكتمالها ثم أعد التشغيل. |
| `Unexpected production version contract` أثناء البناء | تأكيد §١-٢ لا يطابق الرقم الجديد — طابقهما ثم `pnpm check:mobile-release`. |
| الأثر غير موجود للتنزيل | مرّت ١٤ يوماً (انتهت مدّة الاحتفاظ) — أعد تشغيل الـworkflow. |

> **مرجع:** بنية التطبيق في [`docs/mobile-super-app-architecture.md`](mobile-super-app-architecture.md)؛ وعقد تزامن الإصدار في [`scripts/verify-mobile-release-env.mjs`](../scripts/verify-mobile-release-env.mjs).
