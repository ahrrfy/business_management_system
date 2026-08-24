# تدقيق تطبيق «سوبر العربية» — تقرير جنائيّ عميق

## خلاصة تنفيذيّة

الجاهزيّة لـInternal Testing قائمة بلا حاجزٍ صلبٍ يمنع النشر، لكنّ الحالة الأمنيّة/التشغيليّة تحوي **صفر Blockers مؤكَّدة** و**تسع نقاط عالية الخطورة (High)** تتوزّع بين اختطاف تدفّق البصمة عبر deep-link واستدراج المدير إلى شاشة اعتماد، وتعذيب المندوب في كل حقلٍ رقميّ بلوحة أحرف عربية، وحبس المستخدم حتى ٦٥ ثانية عند تسجيل الخروج على شبكةٍ عراقيّة متذبذبة؛ لا تُبطل الميزات الأساسيّة لكنّها تُبقي المنتج «مقبولاً غير احترافيّ» لتطبيقٍ ماليّ يعالج مبيعات وحضوراً ورواتب.

**توسيعٌ في السقف (طلب المالك ٢٤/٨):** الخطّة تنمو من «تصلّبٍ للحالة الحاليّة» إلى «تكافؤٍ كاملٍ مع النظام الأساسيّ + منظومةِ إشعاراتٍ حاكمة». وحدتان جديدتان أُضيفتا: **الموجة ٤** (منظومة الإشعارات — Inbox داخل التطبيق + خمس عائلات: عمليّات/إداريّة/شخصيّة/دخول-خروج للإدارة/إسناد-مهام-اعتمادات — تعتمد على `appNotificationService` القائم خادمياً)، و**الموجة ٥** (شمول ٥٣ راوتراً بلا شاشة أندرويد، مصنَّفةً بثلاث أولويّات تشغيليّة). الجدول الزمنيّ الكلّيّ يمتدّ إلى ٤ أشهر بدلاً من شهرين.

## ١. الحاجزات (BLOCKERS)

**لا يوجد حاجزٌ مؤكَّدٌ يمنع الشحن على Internal Testing.** جميع النتائج المصنَّفة «critical» في المرحلة الأولى نزلت بعد التحقّق الجنائيّ إلى high/medium/low لأسبابٍ معماريّة (البصمة محميّة بـsetUserAuthenticationRequired، ذمّة الجلسة محميّة بـHMAC device-proof، user-installed CAs مقفلة بـsrc=\"system\"). القرار المُعلَن للمالك بحصر التوزيع في Internal Testing (§٦ CLAUDE.md) يقصّ سقف المخاطر — لذلك لا Blockers، لكنّ ثلاث نقاطٍ عالية سترتقي فوراً إلى Blockers إن انفتح التوزيع لـClosed/Open Testing (تحديداً #24 logout و#26 429 و#15 deep-link).

## ٢. الحرجات (CRITICAL)

**لا نتائج مؤكَّدة بشدّة critical.** الملاحظات المُقدَّمة كـcritical سقطت جميعها في التحقّق:
- «لا cert pinning» (3 ملاحظات مختلفة #1/#6/#21/#23/#39) — صحيحةٌ حرفياً لكن `<certificates src=\"system\"/>` + minSdk=26 يقصّان ناقلَي MITM الشائعَين (user CA وMDM على أجهزة غير مروَّضة)، والأثر الحقيقيّ محصورٌ بـCA نظاميّة مخترقة (تاريخياً نادرة وتُبطل بسرعة). تبقى فرصة defense-in-depth مشروعة.
- «لا خطّ عربيّ مشحون» (#30) — Noto Naskh Arabic يشحن مع AOSP على Android 8+، فلا حروفٌ مقطَّعة ولا شاشةٌ فارغة، الأثر تفاوتٌ بصريّ بين موزّعي الأجهزة.
- «لا Dark Mode» (#31) — تفضيليّ UX لا وظيفيّ.
- «catch-all يبتلع SSL errors» (#25) — TLS يعمل، والكاش المعروض بيانات المستخدم لا حمولةٌ مسمومة.

## ٣. تحسينات (HIGH/MEDIUM)

### HIGH (يجب إغلاقها قبل توسيع التوزيع)

**H1 — قفل البصمة يُبطَل بلا مهلة عند طلب POST_NOTIFICATIONS**
`NotificationPermissionLifecycleGuard.kt:11` + `MainActivity.kt:381`
`requestInFlight = true` بلا مهلة انتهاء. على Xiaomi/Vivo/Huawei قد لا يُطلق النظام `onRequestPermissionsResult` ⇒ العَلَم يبقى مرفوعاً إلى أجل غير مسمّى، وكل دورة background/resume تُنتج تخطياً جديداً لفرع `sessionStore.lock() + requestSessionUnlock()`. **failure_scenario**: مهاجمٌ يلتقط جهازاً بعد أن ضغط الموظّف Home أثناء ديالوغ الإشعارات، يفتح التطبيق ⇒ الجلسة Ready تظهر بلا بصمة تكشف بيانات مالية/HR. **الإصلاح**: مهلة قصوى 30ث + مسح `requestInFlight` عند `consumeResumeBypass`.

**H2 — الرابط الخارجي يتخطّى قائمة السماح (kind)**
`NativeNotificationNavigationInbox.kt:26` + `AndroidManifest.xml:34`
`if (kind != null && !allowsDestination(...))` يقفز عند null. Intent خارجيّ عبر BROWSABLE لا يحمل EXTRA_NOTIFICATION_KIND فيمرّ إلى Feature.APPROVE/EDIT لأيّ وحدة يملك المستخدم غرانتها. **failure_scenario**: مديرٌ بـ`EXPENSES=FULL` يستقبل رسالة تصيّد `alrueya://app/module/expenses/approve/12345`، النقر يفتح شاشة اعتماد المصروف رقم 12345 (اختاره المهاجم)، ضغطة زرّ خاطئة = صرفٌ ماليّ للمهاجم. **الإصلاح**: حذف `<category android:name=\"android.intent.category.BROWSABLE\"/>` من intent-filter (السطر 37) — الإشعارات الداخلية تعمل بـexplicit Intent بلا حاجةٍ له.

**H3 — logout يحبس المستعمل حتى ٦٥ ثانية**
`SuperAppRepository.kt:241-248`
`api.mutate(\"auth.logout\")` بلا timeout يعبر `mutationMutex` + `connectTimeout=15s` + `readTimeout=25s`. **failure_scenario**: أمين صندوق ينهي الوردية على شبكة بطيئة، يضغط «خروج»، الشاشة عالقة، يقتل التطبيق force-close ⇒ `finally { api.clearSession() }` لا ينفَّذ ⇒ الجلسة تبقى محلياً + الكوكي الخادمي صالح؛ إن سُرق الجهاز بعدها، بابٌ مفتوح. **الإصلاح**: `withTimeoutOrNull(3_000) { api.mutate(\"auth.logout\") }` + مسحٌ محلّيٌّ فوريّ + WorkManager يرسل revoke لاحقاً.

**H4 — 429 غير قابلٍ للإعادة + لا Retry-After**
`IdempotentRequestRetryPolicy.kt:9-10`
`retryableStatuses = setOf(408, 502, 503, 504)` — بلا 429. `NativePushCoordinator` يميّزه لكن السياسة العامّة لا. **failure_scenario**: افتتاح موسم مدرسيّ، ٦ موظّفين × ٣ شاشات × 20 استعلاماً/دقيقة ⇒ الخادم يُصدر 429، الشاشة تعرض «تعذّر إكمال الطلب»، الموظّف يضغط تحديثاً فوراً ⇒ 429 ثانية ⇒ يبلّغ المالك «التطبيق معطَّل» (كما في ذاكرة `rate-limit-peak-stoppage-2026-08-08`). **الإصلاح**: أضِف 429 + اقرأ `Retry-After` من `connection.getHeaderField(...)` + backoff exponential مع jitter (`250 * 2^n + random(0..250)`) + سقف 15ث إجماليّة.

**H5 — الحقول الرقمية تفتح لوحة أحرف عربية**
`QuotationScreens.kt:315-487` + `CustomerScreens.kt` + `PurchasingScreen.kt:399`
19 من 33 ملفاً (57.6٪) بلا `KeyboardType.` مطلقاً. **failure_scenario**: مندوب البيع يبني عرض سعر لعميلٍ حكوميّ يشتري 150 صنفاً، كل حقلٍ يفتح لوحة أحرف، ٤٥٠ ضغطة زائدة لكل عرض؛ الأسوأ: صالح حتى `2026-8-3` (شكل غير صحيح) يفلت من `.take(10)` ويرفضه الخادم بعد الحفظ. **الإصلاح**: `keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal, imeAction = ImeAction.Next)` + مكوّنَي `MoneyTextField`/`QuantityTextField` موحّدَين + حارس `scripts/check-android-numeric-inputs.mjs`.

**H6 — Repositories يُعاد بناؤها عند كل دوران — البصمة تنفتح ثانية**
`AndroidManifest.xml` (MainActivity بلا `configChanges`)
`onCreate` يبني ~٢٤+ Repository يدوياً + `SecureSessionStore` جديد، ثمّ `onResume` يستدعي `sessionStore.lock()`. الحارس `!isChangingConfigurations` موجود في `onStop` وحده. **failure_scenario**: موظّف الكاشير صدّق بالبصمة، يميل الجهاز على المسند فينقلب إلى landscape ⇒ Activity يُبنى من الصفر ⇒ BiometricPrompt يظهر مجدَّداً، عشرات المرّات يومياً. **الإصلاح**: `android:configChanges=\"orientation|screenSize|keyboardHidden|screenLayout|smallestScreenSize|density|uiMode|locale|layoutDirection\"` + `ProcessLifecycleOwner` مع threshold زمنيّ (30ث background) قبل استدعاء `lock()`.

### MEDIUM (تصلّبٌ دفاعيٌّ يستحقّ ما قبل توسيع التوزيع)

**M1 — `setUnlockedDeviceRequired(true)` غائب على `GENERAL_KEY_ALIAS`**
`SecureSessionStore.kt:329-345`
`BIOMETRIC_KEY_ALIAS` محميٌّ بـ`setUserAuthenticationRequired(true) + AUTH_BIOMETRIC_STRONG` (أقوى من setUnlockedDeviceRequired). لكن `GENERAL_KEY_ALIAS` يلفّ لقطات user/bootstrap/workspace/queryCache بلا ضابط مصادقة. **الإصلاح**: بوّابة `Build.VERSION.SDK_INT >= P` + alias جديد `_v3` + إبطالٌ نظيف. مغيّرة كسر ⇒ تسجيل خروج قسريّ.

**M2 — persistSessionCookie يحفظ Set-Cookie من أيّ حالة HTTP**
`TrpcClient.kt:205,276`
حفظ الكوكي قبل فحص 200-299، وبلا `try/catch` حول `saveCookie`. **الإصلاح**: نقل `persistSessionCookie` إلى داخل فرع `status in 200..299` + `runCatching { sessionStore.saveCookie(pair) }` لمعالجة رمي القفل البيومتري.

**M3 — لا Certificate Pinning**
`network_security_config.xml` (٩ أسطر، بلا `<pin-set>`) + `TrpcClient.kt:186` (HttpURLConnection خامّ)
`srv1548487.hstgr.cloud` ثابتٌ ومهيَّأ للـpinning. Defense-in-depth مشروع لتطبيقٍ ماليّ. **الإصلاح**: `<pin-set expiration=\"2027-08-01\">` بـSHA-256 SPKI لشهادتين (نشطة + احتياطيّة) + توثيق دورة التدوير في `docs/deployment-vps.md` (متزامنة مع certbot — تحذير ذاكرة `certbot-timer-blocked-deploy-2026-08-16`).

**M4 — Play Integrity + Firebase App Check غير مُنفَّذَين**
`build.gradle.kts:285` + `AlrueyaApplication.kt`
grep على `PlayIntegrity|AppCheck|IntegrityManager` = صفر. `nativePush.register` يقبل تسجيلاً من نسخةٍ مستنسخةٍ مُعاد توقيعها. **الإصلاح**: `firebase-appcheck-playintegrity` في debug/release + `IntegrityManagerFactory.create(context).requestIntegrityToken(...)` مع أوّل تسجيل + Firebase Console → App Check → FCM → Enforce.

**M5 — revokeBeforeLogout بلا مسار استرداد مستديم**
`NativePushCoordinator.kt:102`
`withTimeoutOrNull(1_000..5_000)` بلا خطّة استرداد؛ فشلٌ واحد يُفقَد نهائياً. `SuperAppRepository.logout` يمسح الكوكي مهما كانت النتيجة. **الإصلاح**: طابور استردادٍ محليّ في EncryptedSharedPreferences يُعاد تنفيذه عبر WorkManager عند رجوع الشبكة (يوازي M15).

**M6 — handleUnauthorized لا يُلغي ربط FCM**
`SuperAppViewModel.kt:439`
401 على `admin.terminateSessions` يمسح الكوكي محلياً فقط؛ بصمة `nativePushDevices` تبقى `revokedAt IS NULL` فتُبثّ لها إشعارات (عناوين حسّاسة). **الإصلاح**: استدعاء `NativePushCoordinator.revokeBeforeLogout(applicationContext)` قبل `clearLocalSession()` + على الخادم: `revokeUserSessions` يستدعي `revokeNativePushDevice` أيضاً.

**M7 — MainActivity بلا `taskAffinity=\"\"`**
`AndroidManifest.xml:25`
عرضةٌ لـStrandHogg 1 (نشاطٌ خبيثٌ يعلن نفس affinity ⇒ يُعاد لصقه في مهمّتنا) على أجهزة Android 8/9/10 غير المُحدَّثة (يشملها minSdk=26). **الإصلاح**: سطرٌ واحد `android:taskAffinity=\"\"`.

**M8 — proguard-rules فارغة + لا Crashlytics**
`proguard-rules.pro:1` (سطران فقط) + `build.gradle.kts:312-313` (بلا firebase-crashlytics)
`R8` لا يُبقي SourceFile/LineNumberTable ⇒ stack traces من Play Vitals بلا أرقام أسطر ولا mapping مرفوع تلقائياً. **الإصلاح**: `-keepattributes SourceFile,LineNumberTable,InnerClasses,Signature,EnclosingMethod,*Annotation*` + `-renamesourcefileattribute SourceFile` + `firebase-crashlytics` مع auto-init off + `com.github.triplet.play` لرفع mapping.txt.

**M9 — التاريخ يُدخَل نصّاً حرّاً `YYYY-MM-DD`**
`PurchasingScreen.kt:399-400` + `QuotationScreens.kt:313` + ~٢٥ شاشة أخرى
regex الشكل يقبل `2026-13-01` وسنةً خاطئة `2027 → 2026`. **الإصلاح**: `DatePickerDialog` من `androidx.compose.material3` + `Locale(\"ar\", \"IQ\")`.

**M10 — ١٣١ لون خامّ في ٢٦ ملف feature**
`android-native/app/src/main/java/online/alarabiya/superapp/ui/**`
`HrAdminScreen.kt:98-100` يُعيد تعريف Emerald/Ink/Mint حرفياً محلياً. `ExecutiveHomeScreen` يستعمل `0xFF5C36D8` وهو **منحرفٌ فعلاً** عن التوكن الرسميّ `0xFF5B36D2` ⇒ الانحراف واقعٌ الآن. **الإصلاح**: ratchet `scripts/check-android-raw-colors.mjs` بخطّ أساسٍ مجمَّد (١٣١، لا يزيد) + تنظيفٌ تدريجيّ عند لمس كل شاشة.

## ٤. مقارنة بتدقيق «مكتبة العربية» (`expo/customer-store-mobile`)

### حيث «سوبر العربية» أفضل
- **مصادقةٌ ذاتيّة صلبة**: device-proof HMAC بمفتاح EC P-256 غير قابلٍ للتصدير من AndroidKeyStore/StrongBox، مع `sessionsValidFrom` + CAS counter على `userSessions.userAgent` (session.ts:294-305) يجعل replay مستحيلاً. تطبيق العميل يعتمد على JWT/OAuth تقليديّ.
- **حماية بيومتريّة داخل التطبيق** بمفتاح مربوطٍ ببيومتري قوي (`AUTH_BIOMETRIC_STRONG`) — غائبٌ في التطبيق العميليّ.
- **حرّاس منشأ (`NativeEndpointPolicy`)** يفرضان HTTPS + endpoint المعتمد + package match قبل أيّ bundleProdRelease — بنيةُ CI أنضج.
- **`FLAG_SECURE` في release** — التطبيق العميليّ لا يفرضها.
- **`network_security_config.xml` يقصر الثقة على `system` وحده** — يقصي user-installed CAs (تطبيق العميل قد يقبلها افتراضياً).

### حيث «سوبر العربية» أسوأ
- **لا مسار حذف حساب داخل التطبيق** (نتيجة #38) بينما تطبيق العميل ينفّذه (`account.tsx:119-124` + `deleteMyStorefrontAccount`). في «سوبر العربية» موظّفٌ يترك الشركة لا يستطيع طلب حذف بياناته من التطبيق نفسه. مبرَّرٌ جزئياً بأنّه تطبيق مؤسّسيّ + Internal Testing، لكنّه دَينٌ عند التوسيع.
- **الحقول الرقمية بلا KeyboardType** (H5) — تطبيق العميل يستعمل `<TextInput keyboardType=\"numeric\">` بالفطرة في React Native.
- **لا Dark Mode / Dynamic Color** — تطبيق العميل (Expo + NativeWind) يدعم themes بسهولة.
- **لا Certificate Pinning** — تطبيق العميل قد لا يحتاجها بنفس الحدّة (حمولاته أقلّ حساسيّة)، لكنّ «سوبر العربية» يعالج رواتب وذمم.
- **لا Crashlytics** — تطبيق العميل يمرّ عبر Sentry-for-Expo.

### حيث الاثنان متشابهان (فجوةٌ في المستودع كاملاً)
- بيانات العملاء في URL query (`customers.search` GET) تخرج على كلا العميلَين (نتيجة #28) — إصلاحه خادميّ لا Android-only.

## ٥. الفجوات المكتشفَة

**G1 — Auto Backup / dataExtractionRules**: AndroidManifest بلا `android:allowBackup=\"false\"` صريحاً ⇒ `secure_session.xml` (ciphertext) يُنسَخ إلى Google Drive الشخصيّ للموظّف. المفتاح يبقى في Keystore غير المنسوخ، لكن أيّ ثغرةٍ مستقبلية تجعل النسخة قابلةً للاستعادة. **الحل**: `android:allowBackup=\"false\"` + `<data-extraction-rules>` صريحة تستثني SharedPreferences الحسّاسة.

**G2 — Observability**: صفر Crashlytics/Sentry/Bugsnag، صفر `CoroutineExceptionHandler` عالميّ، صفر ANR watchdog. `viewModelScope.launch{}` المنتشرة عبر 24+ Repository تبتلع الاستثناءات صامتاً. مطبعة عراقيّة على Samsung/Xiaomi/Huawei بأعطالٍ صامتة يستحيل تشخيصها من Play Vitals وحدها.

**G3 — In-App Updates**: `com.google.android.play:app-update` غائب. موظّفٌ على نسخةٍ فيها ثغرةٌ ماليّة أُصلحت في v9 قد يبقى شهوراً على v7. **الحل**: `AppUpdateManagerFactory` + IMMEDIATE لتحديثاتٍ أمنيّة، FLEXIBLE للمزايا + حقل خادميّ `minSupportedVersionCode`.

**G4 — التعايش مع تطبيق العميل على نفس الجهاز**: خطر تصادم `FileProvider` authority، Firebase installation، deep-link scheme squatting داخليّ. غير مفحوص.

**G5 — قيود API keys في GCP Console**: `google-services.json` داخل APK يحمل Firebase Android API key. إن لم تُقيَّد بـSHA-256 لتوقيع النشر + `applicationId`، تطبيقٌ خبيثٌ ينسخ الملف يستنزف حصّة أو ينتحل Firebase Installations.

**G6 — سياسة خصوصية داخل التطبيق + Play Data Safety declaration**: `grep 'privacy\\|policy\\|شروط\\|خصوصية'` في strings.xml = صفر. يوقف أوّل انتقالٍ إلى Closed/Open Testing.

**G7 — Locale/Timezone (Asia/Baghdad)**: العميل يعرض/يحسب بـ`TimeZone.getDefault()`، لا `ZoneId.of(\"Asia/Baghdad\")` صريح. موظّفٌ سافر أو غيّر إعدادات وقت جهازه قد يرى فاتورةً «تعود» يوماً، أو يحسب انتهاء ورديّة بلا مراعاة Asia/Baghdad. **الحل**: `shared/BusinessTime.kt` يوازي `businessDay` الخادميّ.

**G8 — Runtime permissions inventory**: جردٌ شاملٌ لكل إذنٍ (USE_BIOMETRIC، CAMERA لحملة barcode، FOREGROUND_SERVICE_DATA_SYNC على Android 14) مع rationale UI عربية لكل واحد + مطابقة Play Data Safety.

**G9 — StrictMode + LeakCanary**: مع 24+ Repository تُبنى في `onCreate` بلا DI (H6)، تسريب `Context` كلاسيكيّ. **الحل**: `debugImplementation 'com.squareup.leakcanary:leakcanary-android:2.14'` + `StrictMode` في `AlrueyaApplication.onCreate` عند `BuildConfig.DEBUG`.

**G10 — WorkManager**: `grep` = صفر. عمليات تحتاج ضمان تسليمٍ عبر إعادة التشغيل (revoke، تسليم أثر تدقيق، مزامنة كاش أوفلاين) بلا بنية طوابير خلفيّة. يحلّ M5 وM6 معاً.

**G11 — Root/Tamper detection ما وراء App Check**: لا RootBeer، لا `Debug.isDebuggerConnected`، لا كشفُ Frida. جهازٌ يُروَّض بعد التسجيل يبقى مسموحاً به دائماً.

**G12 — FLAG_SECURE مضبوطة على مستوى النافذة كاملة**: لا شاشاتٍ حسّاسة بعينها. أيضاً `FLAG_SECURE` يمنع screenshot لا Accessibility. **الحل**: `Modifier.semantics { invisibleToUser() }` على الأرقام الحسّاسة (رواتب، ذمم) في release.

## ٦. خطّة العمل المقترحة

### الموجة ١ (قبل توسيع التوزيع خارج Internal — أسبوعان)
1. H2 (deep-link BROWSABLE): حذف سطرٍ واحد من MainActivity — يُغلق باب استدراج المدير كلّياً.
2. H1 (قفل البصمة): مهلة 30ث + مسح `requestInFlight` عند consumeResumeBypass.
3. H3 (logout timeout): `withTimeoutOrNull(3_000)` + WorkManager للـrevoke المؤجَّل.
4. H4 (429 + Retry-After): إضافةٌ صريحةٌ لسياسة الإعادة + jitter.
5. H6 (configChanges): سطر مانيفست واحد يُنقذ 20-40 استدعاء بصمةٍ يومياً لكل موظّف.
6. M7 (taskAffinity=""): سطر مانيفست يُغلق StrandHogg 1.
7. M2 (persistSessionCookie): نقلٌ داخل فرع 2xx + try/catch.
8. G1 (allowBackup=false): سطران مانيفست + ملف xml.
9. G6 (سياسة خصوصية): صفحة `SettingsScreen` تعرض روابط + إعلان Play Data Safety.

### الموجة ٢ (تصلّبٌ دفاعيّ — شهر)
1. M3 (Certificate Pinning): بصمتان + وثيقة تدوير متزامنة مع certbot.
2. M4 (Play Integrity + App Check): على أوّل تسجيلٍ وعلى كل mutation حرِج.
3. M8 (ProGuard + Crashlytics + mapping.txt رفع تلقائيّ): triplet play plugin.
4. M6 (401 يفكّ FCM binding): استدعاء + كتابةٌ خادميّة تربط nativePush بـsessionId.
5. G2 (Observability): CoroutineExceptionHandler عالميّ + ANR watchdog + user context في Crashlytics.
6. G3 (In-App Updates): AppUpdateManager + `minSupportedVersionCode` خادميّ.
7. G10 (WorkManager): RevokeDeviceWorker + LogoutRetryWorker.

### الموجة ٣ (UX/الجودة — شهرين)
1. H5 (KeyboardType على 19 ملف): مكوّنَي MoneyTextField/QuantityTextField موحّدَين + حارس ratchet.
2. M9 (DatePicker على 25 شاشة): استبدال تدريجيّ.
3. M10 (تنظيف الألوان الخام): ratchet + baseline مجمَّدة.
4. #30 (خطّ Cairo مشحون): 750KB لثلاثة أوزان — هويّةٌ موحَّدة عبر OEMs.
5. G7 (Asia/Baghdad): shared/BusinessTime.kt.
6. G4 (تعايش مع تطبيق العميل): جردُ authorities + سياسة تسمية.

### الموجة ٤ (منظومة الإشعارات الكاملة — أسبوعان-٣) — **طلب المالك ٢٤/٨**

> **المبدأ:** كل حدثٍ ذي معنًى في الشركة يُنتج إشعاراً موجَّهاً للفاعل المعنيّ، ولا يضيع منه شيءٌ في السجلّ. الأساس الخادميّ قائم (`appNotificationService.ts` + `nativePushService.ts` + جدول `appNotifications` + `nativePushOutboxWorker`)، لكنّ التطبيق **يستهلك دفعاً موحَّداً فقط ولا يعرض علبة وارد ولا سجلّاً**.

**ن-١ — شاشة «الإشعارات» (Inbox) الأصيلة داخل التطبيق**
مسارٌ ثابتٌ في `NativeNavGraph` + شارة عدد الجديد على قائمة سفليّة/رأس. جدول `appNotifications` جاهزٌ خادمياً بحقول (kind, subjectType, subjectId, requiresAction, readAt, deepLink, actorUserId, branchId). التطبيق يفتقد Repository + ViewModel + Screen. **العقد**: `superApp.notifications.list({unreadOnly?, kind?, cursor?})` + `.markRead({id})` + `.markAllRead({})` + `.count({unreadOnly:true})`. **UX**: قائمةٌ رأسها فلترٌ (الكل/غير مقروء/يتطلّب إجراء)، كلّ صفٍّ: أيقونة النوع + عنوانٌ عربيّ + مسندٌ إليه + وقت نسبيّ («قبل ٣ دقائق») + شارة «يتطلّب إجراء» + نقرة تفتح deep-link. سحبٌ لأسفل يُحدّث، تمريرٌ يُعلِّم مقروءاً. **قسمُ الإدارة**: تبويبٌ إضافيّ «إدارة» يظهر للأدوار الإداريّة (admin/isOwner/الفرع) يعرض الإشعارات الإداريّة معاً.

**ن-٢ — أنواع الإشعارات المطلوبة (خمس عائلات)**
كلّ نوعٍ يُكتب في `appNotifications` (سجلّ) **و**يُرسَل عبر FCM كـpush (تنبيه لحظيّ) — مصدرٌ واحد لا مصدران.
- **ن-٢-أ عمليّات (OPERATIONS)**: كل mutation ذات معنًى تجاريّ ينتج إشعاراً موجَّهاً للفاعل والمعنيّين. أمثلة: `sale.created` (للبائع + المدير الفرعيّ للسقف)، `receipt.approved` (للطالب)، `purchase.received` (لمُصدر الأمر)، `stocktake.completed`، `priceWave.applied`، `deliveredAndSettled`، `workOrder.startedProduction`. المصادر خادميّة داخل `withTx` نفسها (لا مسار جانبيّ صامت).
- **ن-٢-ب إشعارات إداريّة (ADMIN)**: تجميعات ووَقفات يوميّة موجَّهة للمدير/المالك. أمثلة: «ورديّة أنهيت بفارقٍ نقديّ 12,000»، «٣ فواتير تجاوزت سقف التسعير المتنازَل»، «متوسّط زمن الاستجابة تجاوز 800ms»، «موظّف تجاوز حدّ الغياب المسموح». تُنشأ من `morningPushScheduler.ts` + مُشغِّلاتٍ حدثية.
- **ن-٢-ج لكلّ موظّف (PER-EMPLOYEE)**: توجيهٌ صريح: «طلبك للإجازة اعتُمد»، «سلفتك جاهزة للاستلام»، «راتب شهر ٨ أُعتمد وسيُصرَف»، «تعديلٌ على بطاقتك الرقمية». يعتمد `userId` من `appNotifications`.
- **ن-٢-د تسجيل دخول/خروج الموظفين (LOGIN/LOGOUT)**: كل نجاح تسجيل دخول (`authRouter.login`) وكل خروج (`authRouter.logout` أو `revokeUserSessions`) يُنشئ إشعاراً موجَّهاً للإدارة (admin/isOwner + مدير الفرع) بحقول (userId, deviceLabel, ip, geo, timestamp). **الغرض التنظيميّ**: انكشافٌ لحظيٌّ لنشاطٍ خارج الدوام أو من جهازٍ جديد. المصدر خادميّ محضٌ ⇒ لا يعتمد على التطبيق ليعمل.
- **ن-٢-هـ الإسناد والمهام والاعتماد (ASSIGN/TASK/APPROVE)**: 
  - **إسناد**: تحويلُ مهمّة أو أمر شغل أو تسليمة إلى موظّف ⇒ إشعارٌ للمُسنَد إليه + للمُسنِد. المصادر: `tasksRouter.assign`، `workOrderRouter.assign`، `deliveryRouter.assignCourier`، `approvalsRouter.route`.
  - **مهمّة**: إنشاء/بدء/إنجاز/تأخّرٌ في `tasksRouter`. صاحب المهمّة يرى دورة الحياة كاملةً.
  - **اعتماد**: كل طلبٍ ينتظر اعتماد Maker-Checker (صرفٌ فوق العتبة، تعديل تكلفة، سلطة تسعير يدويّ، إبطال فاتورة) ⇒ إشعارٌ للمعتَمِد + إشعارُ نتيجةٍ للطالب. المصادر: `creditApprovalRouter`، `voucherRouter` (اعتماد الصرف)، `costRevaluationRequests`، `manualPricingAuthority`.

**ن-٣ — التوصيل والموثوقيّة**
- الطابور `nativePushOutbox` (قائم) + retry مع backoff قائم. **الإضافة**: منح الإشعار **معرِّف deduplication** خادميّاً (`kind + subjectId + eventOccurredAt`) — يمنع تكرار إشعار «دخل الموظّف س» عند إعادة إرسال مؤجَّلة.
- **قناة Foreground**: `AlrueyaFirebaseMessagingService` يوجّه إلى `appNotifications.markSeenLocally` عند فتح التطبيق للحفاظ على تناسق العدّاد بين الأجهزة (موظّفٌ عنده موبايل + تابلت).
- **قنوات Android**: قناةٌ لكل عائلة (عمليات · إدارة · شخصيّ · دخول-خروج · اعتمادات) بأهميّةٍ منفصلة يستطيع المستخدم كتمها فرديّاً بلا تعطيل الحرِج.

**ن-٤ — الخصوصية والحدود**
- إشعارات الدخول/الخروج للإدارة **بلا كلمة سرّ ولا توكن** — عناوين فقط (اسم + جهاز + وقت). الجسم الحسّاس يبقى داخل التطبيق بعد فتحه.
- على الشاشة القفليّة (Android 5+): عرض العنوان فقط (لا الجسم) للإشعارات المصنَّفة حسّاسة (رواتب، ذمم، اعتمادات فوق العتبة).
- عزل الفرع في القراءة: `superApp.notifications.list` يفلتر بـ`branchId` لكل ما ليس موجَّهاً لـ`userId` مباشرةً.

### الموجة ٥ (شمول الوحدات — parity مع النظام الأساسيّ — ٦-٨ أسابيع) — **طلب المالك ٢٤/٨**

> **الحالة الآن:** ٢٩ feature في التطبيق مقابل **٨٢ router + ٢٢٥ صفحة** في الـERP. جوهر الأعمال مغطًّى (بيع/شراء/عملاء/موردون/مخزون/HR/ورديات/دفتر) لكنّ **٥٣ راوتراً** بلا شاشة أندرويد. **المبدأ:** كل ما في الويب متاحٌ للموظف الذي يملك صلاحيّته على جواله، بلا استثناء.

**فجواتٌ محدَّدة (مصنَّفة بالأولويّة التشغيلية):**

**م-١ ذات أولوية عاجلة (تشتغل بها الشركة يومياً):**
| الوحدة | المطلوب | الراوتر |
|---|---|---|
| **قسائم/سندات القبض والصرف** | إنشاء + قائمة + اعتماد + طباعة | [voucherRouter](server/routers/voucherRouter.ts) |
| **الأقساط** | خطط + استحقاقات + جدول التذكيرات | [installmentRouter](server/routers/installmentRouter.ts) |
| **العروض والحجوزات** | إنشاء + تحويل لفاتورة | [quotationRouter](server/routers/quotationRouter.ts), [reservationsRouter](server/routers/reservationsRouter.ts) |
| **المرتجعات (بيع/شراء)** | كامل الدورة | [returnRouter](server/routers/returnRouter.ts), [purchaseReturns](server/routers/purchaseReturns.ts) |
| **الجرد الدوري + عدّ الباركود** | العدّ الجزئيّ + المسح | [stocktakeRouter](server/routers/stocktakeRouter.ts), [countPortalRouter](server/routers/countPortalRouter.ts) |
| **العهدة النقديّة + التحويل بين الفروع** | صرف + إرجاع + تحويل | [cashTransfersRouter](server/routers/cashTransfersRouter.ts) |
| **التوصيل + الجابي** | طلباتي + تسليم + قبض ميدانيّ | [deliveryRouter](server/routers/deliveryRouter.ts), [courierRouter](server/routers/courierRouter.ts) |
| **البطاقات الرقميّة** | إصدار + بيع + سجلّ الحركة | [digitalCardsRouter](server/routers/digitalCardsRouter.ts), [cardAccountRouter](server/routers/cardAccountRouter.ts) |
| **بضاعة الأمانة** | استلام + بيع + تسوية المودِع | [consignmentRouter](server/routers/consignmentRouter.ts) |
| **العمولات + الأهداف** | لوحة البائع + مصفوفة الأهداف | [commissionsRouter](server/routers/commissionsRouter.ts) |

**م-٢ ذات أولوية عملياتية:**
| الوحدة | المطلوب | الراوتر |
|---|---|---|
| **موجات الأسعار** | معاينة + اعتماد + تراجع | [priceWavesRouter](server/routers/priceWavesRouter.ts) |
| **العروض/الترقيات V2** | إنشاء + جدولة | [promotionsV2Router](server/routers/promotionsV2Router.ts) |
| **البحث العامّ** | حقل أعلى الشاشة عبر كل الوحدات | [globalSearchRouter](server/routers/globalSearchRouter.ts) |
| **الأصول والصيانة** | قائمة + إسناد + جدول صيانة | [assetsRouter](server/routers/assetsRouter.ts) |
| **الطلبات (Tasks)** | إنشاء + إسناد + متابعة | [tasksRouter](server/routers/tasksRouter.ts) — يتكامل مع ن-٢-هـ |
| **الاعتمادات (Approvals)** | طابور الاعتمادات الموحَّد | [creditApprovalRouter](server/routers/creditApprovalRouter.ts) |
| **مذكرات العميل** | إضافة + عرض ضمن ملفّه | [customerNoteRouter](server/routers/customerNoteRouter.ts) |
| **التوظيف (Recruitment)** | مرشّحون + مقابلات + قرار | [recruitmentRouter](server/routers/recruitmentRouter.ts) |
| **الإجازات** | طلب + اعتماد + رصيد | [leaveRouter](server/routers/leaveRouter.ts) |
| **الاستيرادات (Excel)** | استيراد كتالوج/عملاء/موردين | [imports](server/routers/imports.ts) |

**م-٣ ذات أولوية إداريّة/محاسبيّة:**
| الوحدة | المطلوب | الراوتر |
|---|---|---|
| **إقفال الفترة** | جدولٌ زمنيّ + تجميد الشهر | [periodLockRouter](server/routers/periodLockRouter.ts), [yearEndRouter](server/routers/yearEndRouter.ts) |
| **الخزينة (Treasury)** | لوحة السيولة + التنبّؤ | [treasuryRouter](server/routers/treasuryRouter.ts) |
| **إدارة الأدوار** | صلاحيّات + بوّابات الوحدات | [roleRouter](server/routers/roleRouter.ts) |
| **الصرفيّات (Expense)** | إنشاء + اعتماد فوق العتبة | [expenseRouter](server/routers/expenseRouter.ts) |
| **الهدايا** | قائمة الهدايا + الوعاء | [giftsRouter](server/routers/giftsRouter.ts) |
| **الاستوديو (product + image)** | جلساتٌ محمولة | [productStudioRouter](server/routers/productStudioRouter.ts), [imageStudioRouter](server/routers/imageStudioRouter.ts) |
| **تدقيق النشاط (Audit)** | سجلّ إداريّ متصفَّح | [auditRouter](server/routers/auditRouter.ts) |
| **الطباعة (PoS/Pricing/Audit)** | إعادة الطباعة + سجلٌّ | [printPosRouter](server/routers/printPosRouter.ts), [printPricingRouter](server/routers/printPricingRouter.ts), [printAuditRouter](server/routers/printAuditRouter.ts) |
| **الشذوذ في الكتالوج** | لوحة الأصناف المشكوك بها | [catalogAnomaliesRouter](server/routers/catalogAnomaliesRouter.ts) |

**النمط التقنيّ الحاكم لكل شريحة (لا استثناء):**
1. Repository + ViewModel + Screen (Compose) + Route + بند قائمة سفليّة عند اللزوم.
2. حالات Loading/Error/Empty صريحة + RTL كامل + KeyboardType على كل حقل رقميّ (H5).
3. اعتماد كامل على toke ns التصميم + بلا لون خامّ (M10).
4. تكامل مع الإشعارات (كل إنشاء يُنشئ appNotification موافقاً — ن-٢).
5. اختبار androidTest واحدٌ على الأقلّ للتدفّق الرئيسيّ.
6. تحديث `nativePush.register.moduleAccess` ليعكس الوحدة الجديدة بحيث تصل إليها إشعاراتها.

**ترتيب البناء المقترح (يُخلط مع الموجتَين ٤ و١ لا يستبدلهما):**
- شهر ١: أساس الإشعارات (الموجة ٤) + م-١ (١-٥) — القسائم/الأقساط/المرتجعات/الجرد/التحويل.
- شهر ٢: م-١ (٦-١٠) — التوصيل/البطاقات/الأمانة/العمولات + م-٢ (١-٤).
- شهر ٣: م-٢ (٥-١٠) + م-٣ (١-٤).
- شهر ٤: م-٣ (٥-٩) + تنظيف الديون التقنيّة المتراكمة (الموجة ٣).

**ما يخرج من الشمول عمداً:** بعض الوحدات ذات الأجهزة الطرفيّة الحصريّة (الطباعة الحراريّة WebUSB، جسر الحضور USB) تبقى محصورة بالويب — لا يجدي بناؤها للجوّال.

### مؤجّلة (اختياريّة أو تنتظر قرار المالك)
- #31 Dark Mode / #32 Dynamic Color: تفضيليّ.
- G11 root detection: يعتمد على تصاعد التهديد.
- #36 TopAppBar: خيار تصميم متعمَّد قائم.

## ٧. قرارات المالك المطلوبة

1. **مسار حذف الحساب داخل التطبيق (#38 + G6)**: هل نبني mutation `auth.requestAccountDeletion` (طلبُ حذفٍ إداريّ يمرّ بمراجعة — يحفظ السجلّ المحاسبيّ) استعداداً لتوسيع التوزيع؟ أم نبقى على Internal مع رابطٍ خارجيّ فقط؟

2. **Certificate Pinning + دورة تدوير الشهادة (M3)**: هل نضيف pinning مقيَّداً بـ`srv1548487.hstgr.cloud` مع دورة تدوير في `pnpm prod:deploy`؟ الخطر: انقطاع كلّ الأجهزة إن انتهت الشهادة بلا تدوير مسبق (ذاكرة `certbot-timer-blocked-deploy-2026-08-16` توثّق سابقاً كيف عطّل certbot الإنتاج).

3. **Play Integrity + App Check (M4)**: هل نُلزم الطلبات الماليّة الحرجة (`sales.correct`، `receipts.approve`، `hr.settleEndOfService`) بـintegrity token؟ التكلفة: زمن استجابة إضافيّ + احتمال رفض جهازٍ مروَّضٍ لموظّفٍ شرعيّ (Custom ROMs في العراق نادرة لكنّها موجودة).

4. **Auto Backup (G1)**: `android:allowBackup=\"false\"` = فقدان استعادة تلقائيّة إذا استبدل الموظّف جهازه. البديل: `dataExtractionRules` صريحة تستثني `secure_session.xml` فقط. أيّهما؟

5. **Dark Mode / Dynamic Color (#31, #32)**: قرار هويّة علامة. التطبيق يحمل قرار «البنفسجي/اللافندري» صراحةً في Theme.kt:17-18. Dynamic Color قد يُضعف تماسك العلامة. مفتاح اختياريّ في Settings؟ أم إبقاء الهويّة موحَّدة؟

6. **Root/Frida detection (G11)**: هل نُشغّل `RootBeer` + `Debug.isDebuggerConnected` في release مع رفض التشغيل؟ الخطر: false positives على أجهزةٍ مروَّضةٍ شرعياً لموظّفين تقنيّين.

7. **In-App Updates IMMEDIATE (G3)**: هل نجبر تحديثاً حاصراً حين يُصلَح عطبٌ ماليّ حرِج (مثلاً #4 revoke FCM)، أم نبقي كل التحديثات FLEXIBLE ليختار الموظّف؟ الجبريّة توقف الكاشير لحظياً لكنّها تسدّ الثغرة فوراً.

8. **إشعارات الدخول/الخروج للإدارة (ن-٢-د)**: هل توصل **لكلّ** دخول (سيلٌ يوميّ)، أم فقط للأحداث غير المعتادة (جهاز جديد، خارج الدوام، من IP جديد)؟ الخيار الأوّل شامل لكنّه مزعج، الثاني نظيف لكنّه يحتاج تعريف «غير معتاد» — واستقصاءُ IP لموظّفٍ يعمل من فرعٍ ثابت أسهل من محاولة اكتشاف Anomaly. **اقتراحي (قابل للتصحيح):** الافتراضي شامل، مع خيارٍ في إعدادات الإدارة لكتم أنواعٍ من الأحداث اليوميّة (كتم = لا تصل push، لكنّها تُخزَّن في الـInbox).

9. **شمول الوحدات — أولويّة قائمة الأسبقيّة (م-١/م-٢/م-٣)**: تصنيفي في الموجة ٥ بنيتُه على الحركة اليوميّة التي أعرفها من `git log`؛ إن كانت للشركة أولويّةٌ مختلفة (مثلاً «الاعتمادات قبل القسائم»)، صحّح الترتيب فأعيد بناء الجدول. وسؤالٌ أدقّ: **هل نبني كلّ وحدةٍ بكامل قدرتها الويبيّة أوّلاً**، أم نبدأ **بالحدّ الأدنى (list + read) لجميعها**، ثمّ نعمِّق حسب الاستعمال؟ الأوّل أعمق لكنّه بطيء، الثاني يفتح الجواب لكلّ سؤال «هل الوحدة موجودة» في التطبيق أوّلاً ثمّ يعمّق. **اقتراحي:** م-١ بعمقٍ كامل (تشتغل بها الشركة يومياً)، م-٢/م-٣ بحدٍّ أدنى ثمّ توسيعٍ عند اللزوم.

10. **قنوات Android للإشعارات (ن-٣)**: هل نُعرِّض لكل موظّف مفاتيح كتم لكل عائلة (عمليات · إدارة · شخصيّ · دخول-خروج · اعتمادات)، أم قناةٌ واحدة موحَّدة أبسط للموظف؟ التعدّد يعطي تحكّماً لكنّه يخلق مخاطر (موظّفٌ يكتم «اعتمادات» فيفوته اعتمادٌ حرِج). **اقتراحي:** خمس قنوات، لكن ثلاثاً منها (**عمليّات · اعتمادات · دخول-خروج للإدارة**) بأهميّة `IMPORTANCE_HIGH` مقفلةٌ لا يستطيع المستعمل تخفيضها.