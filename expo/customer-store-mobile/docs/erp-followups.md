# متابعات ERP لتطبيق مكتبة العربية

> **بنودٌ خرجت من نطاق `expo/customer-store-mobile/**` — تحتاج تعديل الخادم الرئيسيّ (`server/**` في جذر ERP) وتُنفَّذ في جلسةٍ منفصلة بادّعاء coord مختلف.**
>
> الأصل: تدقيق `wf_4c973b32-831` — راجع `scratchpad/expo-store-audit.html`.

## ت-٣ / بند م٢ #٨ — `customerSessionToken` في query string لطلب GET

**الموقع**: [server/routers/storefrontRouter.ts:97-99](../../../server/routers/storefrontRouter.ts#L97) — إجراء `customerBenefits.query`، و[lib/storefront-api.ts:210-211,392](../lib/storefront-api.ts#L210) (جهة العميل، للتحديث بعد تحديث العقد).

**المشكلة**: JWT بعمر ٧ أيّام يُرسَل في `?input=...` لطلب GET. nginx access.log على VPS Hostinger مشترك مع أودو/سراج يسجّل الـURL كاملاً، والتوكن يظهر مع كل استعلام رصيد.

**الإصلاح المقترح** (على جانب الخادم):
- **الخيار الأصحّ**: حوّل `storefront.customerBenefits` من `.query()` إلى `.mutation()` — الرمز ينتقل إلى body، لا يُسجَّل في access.log.
- **البديل**: أبقِه query لكن أرسل الرمز في header `Authorization: Bearer` — يحتاج تحديث client fetch call ليمرّر header عبر `httpLink.headers`.

**تحقّق**: `grep customerSessionToken /var/log/nginx/access.log*` بعد التحديث = صفر مطابقات.

---

## ت-١١ / بند م٢ #٩ (جزء أ) — Firebase JWT بلا مسار إلغاء خادميّ

**الموقع**: [server/services/storefrontCustomerIdentityService.ts:25,121-161](../../../server/services/storefrontCustomerIdentityService.ts#L25).

**المشكلة**: `CUSTOMER_SESSION_TTL_SECONDS = 604800` (٧ أيّام). `verifyStorefrontCustomerSession` يفكّ التوقيع فقط ولا يقارن بحقلٍ في DB. سرقة التوكن = صلاحيّة أسبوعٍ بلا مسار إبطال.

**الإصلاح المقترح**:
- هجرةٌ جديدة تضيف عموداً: `customers.sessionVersion INT NOT NULL DEFAULT 0`.
- في `claimStorefrontFirebaseCustomer`: احقن `sessionVersion` في claims الـJWT.
- في `verifyStorefrontCustomerSession`: اقرأ `session_version` من DB ورفض إن اختلف.
- أنشئ إجراء `storefront.logout.mutation`: يبمّم `sessionVersion++`.
- خفّض TTL إلى **٢٤ ساعة** مع refresh token (أو أبقِ TTL أسبوعياً واقبل عبء تحقّق DB في كلّ طلب — قرار).

**اختبار**: بعد logout، إعادة استعمال التوكن نفسه = 401.

---

## ت-١٧ / بند م٢ #٩ (جزء ب) — `submitProductReview` لا يفحص `isActive`

**الموقع**: [server/routers/storefrontRouter.ts:135-147](../../../server/routers/storefrontRouter.ts#L135) — يستدعي `verifyStorefrontCustomerSession` فقط بدلاً من التحقّق من `isActive` والهاتف.

**المشكلة**: عميلٌ عُطِّل حسابه أو غيّر هاتفه لا يزال قادراً على إرسال مراجعاتٍ بجلسته القديمة.

**الإصلاح المقترح**:
- أنشئ wrapper: `requireActiveStorefrontCustomer(ctx)` يفعل: `verifyStorefrontCustomerSession` + `SELECT isActive, phone FROM customers WHERE id = ?` + رفض إن غير مفعّل أو الهاتف تغيّر.
- استعمله في `submitProductReview` وأيّ إجراءٍ خادميٍّ يستهلك جلسةَ عميل.

---

## ك-٢ / بند م٢ #١٩ — `assetlinks.json` يعيد بصمة EAS-dev كافتراضيّ في production

**الموقع**: [server/wellKnown.ts:4,31](../../../server/wellKnown.ts#L4) — ثابت `STOREFRONT_EAS_DEVELOPMENT_SHA256` في الكود، وfallback `?? STOREFRONT_EAS_DEVELOPMENT_SHA256` بلا حارس بيئة.

**المشكلة**: `.env.production.example` بلا مدخل `STOREFRONT_ANDROID_SHA256_CERT_FINGERPRINTS`، لا حارس CI. Google يُعيد التوقيع بمفتاح Play App Signing على AAB، فبصمةُ الجهاز ≠ بصمة الخادم. App Links تفشل صامتاً — المختبِرون على Play Internal يرون الرابط يفتح Chrome بدل التطبيق.

**الإصلاح المقترح**:
1. في `wellKnown.ts` ارفض الـfallback إذا `NODE_ENV === "production"` وعُدَّه configuration error يُرجع 500 مع سبب مسجَّل.
2. أضِف حارساً في `scripts/verify-mobile-release-env.mjs` يتأكّد من ضبط `STOREFRONT_ANDROID_SHA256_CERT_FINGERPRINTS`.
3. اقرأ البصمة من Play Console → Setup → App integrity → App signing → SHA-256 وأدرجها في `.env.production` على Hostinger.
4. تحقّق بأداة Google Digital Asset Links Tester أو `adb shell pm verify-app-links --re-verify online.alarabiya.customerstore`.
5. احذف الثابت `STOREFRONT_EAS_DEVELOPMENT_SHA256` من الكود بعد نقله إلى `.env.development.example`.

---

## ك-٣ (متمّم) — Universal Links لـiOS (AASA)

**الموقع**: خادم ERP بحاجة `server/wellKnown.ts` يخدم `/.well-known/apple-app-site-association` بـ`Content-Type: application/json`.

**المشكلة**: التطبيق يحتاج على جانبه `associatedDomains: ["applinks:alarabiya.online"]` في `app.config.ts` iOS — لكن AASA على الخادم مفقود ⇒ iOS لا يفتح التطبيق على `alarabiya.online/s/w/*` أبداً.

**الإصلاح المقترح** (على جانب الخادم):

```ts
app.get("/.well-known/apple-app-site-association", (_req, res) => {
  res.set("Content-Type", "application/json");
  res.json({
    applinks: {
      details: [
        {
          appIDs: [`${APPLE_TEAM_ID}.online.alarabiya.customerstore`],
          components: [{ "/": "/s/w/*" }],
        },
      ],
    },
  });
});
```

- سجّله **قبل** أيّ catch-all كما `assetlinks`.
- `APPLE_TEAM_ID` يُقرأ من Apple Developer Portal بعد اعتماد العضوية (قرار مالك سارٍ).
- تحقّق بـ`swcutil` من Apple.

**تحرير `app.config.ts`** (على جانب التطبيق، متمّم بعد الخادم):

```ts
ios: {
  supportsTablet: true,
  bundleIdentifier: env.iosBundleId,
  googleServicesFile: "./GoogleService-Info.plist",
  associatedDomains: ["applinks:alarabiya.online"],
  infoPlist: {
    ITSAppUsesNonExemptEncryption: false,
  },
},
```

---

## ترتيب التنفيذ المقترح

1. **الأولوية الأولى — ك-٢ (assetlinks)**: بلا هذا، Play App Links لا تعمل لأيّ عميل. صريح، لا يحتاج قراراً.
2. **الأولوية الثانية — ت-٣ (customerBenefits query→mutation)**: تسريب توكنات إلى access.log على VPS مشترك — قابل للاستغلال إن فُقد وصول لأودو/سراج.
3. **الأولوية الثالثة — ت-١١ + ت-١٧ (session_version + activeCheck)**: يحتاج قرار المالك على TTL (٢٤س بـrefresh أم أسبوع بلا). ينفَّذ بعد قرار.
4. **الأولوية الرابعة — ك-٣ (AASA)**: بلا معنى قبل قرار Apple Developer.

---

## بروتوكول التنفيذ في جلسة ERP

```bash
# فرع مستقلّ، ادّعاء coord بنطاق server/ لا expo/
pnpm session:new erp-mobile-followups
pnpm coord:claim erp-mobile-followups --files "server/routers/storefrontRouter.ts,server/services/storefrontCustomerIdentityService.ts,server/wellKnown.ts,scripts/verify-mobile-release-env.mjs"

# بعد كل تعديل: فحص guards + tests (نفس بروتوكول ERP في CLAUDE.md §٣.١)
pnpm check
pnpm check:guards
pnpm test:unit
```

**لا تُشغَّل مراحل م٢ الخادميّة على شجرة `improve-critical-screen-1a6b94` الحاليّة** لأنّها ادّعت `expo/customer-store-mobile/**` فقط — التداخل مع `server/**` يُخلّ ببروتوكول التوازي.
