# متابعات ERP لتطبيق مكتبة العربية

> **بنودٌ خرجت من نطاق `expo/customer-store-mobile/**` — تحتاج تعديل الخادم الرئيسيّ (`server/**` في جذر ERP) وتُنفَّذ في جلسةٍ منفصلة بادّعاء coord مختلف.**
>
> الأصل: تدقيق `wf_4c973b32-831` — راجع `scratchpad/expo-store-audit.html`.

## ت-٣ — customerBenefits: query→mutation (✅ نُفِّذ + إبقاء توافق خلفيّ)

**الحالة**: **مُنجَز** في commit `d25da9c4` مع طبقةِ توافقٍ خلفيّ بعد مراجعة Codex.

**ما تمّ**:
- **الخادم**: `customerBenefits` القديم بقي `.query()` (مع علامة `@deprecated`) — البُنى المنشورة سابقاً على أجهزة المختبِرين لا تتعطّل.
- **مسارٌ جديد `customerBenefitsPrivate`** `.mutation()` — البُنى الجديدة تستدعيه ⇒ التوكن في POST body لا `?input=...`.
- **العميل**: `lib/storefront-api.ts` يستدعي المسار الجديد.

**متبقٍّ** (نافذة الرولاوت):
- بعد اكتمال نشر Play Production والتأكّد من تحديث كلّ التركيبات النشطة، **احذف** `customerBenefits` القديم من `storefrontRouter.ts` (اترك `customerBenefitsPrivate` وحده).
- مؤشّر آمن: `grep customerBenefits /var/log/nginx/access.log*` = صفر مطابقات لمدّة أسبوعَين متتاليَين.
- ثمّ commit جديد بتنظيف endpoint القديم + تحديث `authz-inventory`.

**قياس على nginx**: `grep customerSessionToken /var/log/nginx/access.log*` بعد الرولاوت = صفر مطابقات (البُنى الجديدة تستعمل POST body).

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

---

## F-٨ / بند م٣ #٢٤+٣٠ — مسار `storefront.deleteMe` (Play مطلوب)

**الحالة**: زرّ الحذف مبنيٌّ في `app/(tabs)/account.tsx` مع تأكيدٍ مزدوج، وواجهة العميل [`deleteMyStorefrontAccount`](../lib/storefront-api.ts) تستدعي `storefront.deleteMe`. الطرفُ الخادميّ **غير مبنيٍّ بعدُ** — الزرّ يعرض رسالة «قيد التجهيز» عند الضغط.

**Google Play يفرض حذفاً داخل التطبيق منذ مايو ٢٠٢٤** — عدم توفّره حاجزُ نشرٍ على Production.

**الإصلاح المقترح** (على جانب الخادم):

```ts
// server/routers/storefrontRouter.ts
deleteMe: publicProcedure
  .input(z.object({ firebaseIdToken: z.string().min(1) }))
  .mutation(async ({ input, ctx }) => {
    // ١) فكّ الرمز الحيّ (لا اعتماد جلسةٍ قديمة قد تكون مسروقة)
    const decoded = await verifyFirebaseIdToken(input.firebaseIdToken);
    const phone = decoded.phone_number;
    if (!phone) throw new TRPCError({ code: "BAD_REQUEST", message: "الرمز لا يحمل رقم هاتف" });

    // ٢) اعثر على العميل بالهاتف
    const customer = await ctx.db.query.customers.findFirst({ where: eq(customers.phone, phone) });
    if (!customer) return { ok: true, deletedAt: new Date().toISOString() };

    // ٣) تنفيذ الطمس في transaction:
    await ctx.db.transaction(async (tx) => {
      await tx.update(customers).set({
        name: "عميلٌ محذوف",
        phone: `deleted:${crypto.createHash("sha256").update(phone).digest("hex").slice(0, 24)}`,
        addressText: null,
        governorate: null,
        isActive: false,
        deletedAt: new Date(),
        sessionVersion: (customer.sessionVersion ?? 0) + 1, // يبطل كل الجلسات القائمة (يتقاطع مع ت-١١)
      }).where(eq(customers.id, customer.id));

      // ٤) لا نحذف الطلبات — نُبقيها لأغراض المحاسبة (٥ سنوات)
      // ٥) لا نحذف نقاط الولاء — نجعلها في حالةٍ نهائيّة بلا مالك
      await tx.update(loyaltyBalances).set({ status: "OWNER_DELETED", frozenAt: new Date() })
        .where(eq(loyaltyBalances.customerId, customer.id));
    });

    return { ok: true, deletedAt: new Date().toISOString() };
  })
```

**هجرة لازمة**: إضافة `customers.deletedAt TIMESTAMP NULL` + `loyaltyBalances.status ENUM('ACTIVE','OWNER_DELETED','FROZEN')`.

**تحقّق**: بعد الحذف — قراءة `customer.name` من DB = «عميلٌ محذوف» · `phone` مطموس · `orderNumber` القديم لا يزال يفتح تاريخ الطلب بلا اسم/هاتف · محاولة استعمال التوكن القديم = 401 (بفضل sessionVersion).

**Play Console**: بعد النشر، سجّل «Account deletion → In-app path» = مسار داخل التطبيق (شاشة الحساب → «حذف حسابي نهائيّاً»).

---

## F-٣ / بند م٣ #٢٦ — Rate limiting على OTP + منع تعداد الأرقام

**الموقع**: خدمة إرسال OTP في ERP (`server/services/storefrontFirebaseCustomer.ts` أو ما يعادلها).

**المشكلة**: بلا حدٍّ per phone/IP/device، Blaze plan تفتح فاتورة SMS مفتوحة. ورسائل الخطأ إن ميّزت بين «رقم موجود» و«رقم غير موجود» = تعداد.

**الإصلاح المقترح**:
- **per phone**: ٣ محاولات في الساعة، رفض الرابعة بـ429 حتى انقضاء الساعة.
- **per IP**: ١٠ محاولات في الساعة (يشترك عدّة أشخاصٍ خلف NAT واحد).
- **cooldown 60 ثانية** بين إعادات الإرسال للرقم نفسه.
- **رسائل خطأ موحّدة**: «تعذّر إرسال الرمز الآن، حاول لاحقاً» — بلا كشفٍ عن سبب الرفض (رقم غير موجود / محظور / حدّ سقف).
- **Redis أو DB counter بـTTL** يحفظ العدّاد.

**اختبار**: `for i in {1..10}; do curl -X POST .../storefront.sendOtp -d '{"phone":"+9647712345678"}'; done` — من الرابعة يجب `429 Too Many Requests`.

---

## F-٧ / بند م٣ #٢٦ — Cloudflare WAF على مسارات storefront

**الموقع**: Cloudflare Dashboard → alarabiya.online → Security → WAF (خارج المستودع).

**قواعد مقترحة**:
1. `/api/trpc/storefront.createOrder` → ١٠ req/min/IP (rate limit rule).
2. `/api/trpc/storefront.sendOtp` → ٣ req/min/IP + ١٠/hour/IP.
3. `/api/trpc/storefront.customerBenefits` → ٦٠ req/min/IP (بعد تحويلها إلى mutation في ت-٣).
4. Block أيّ user-agent بلا `x-alrueya-client: android-native` على مسارات mutation (يتقاطع مع storefrontMutationHeaders الحاليّة).

**تحقّق**: راجع سجلّات WAF أسبوعياً — أيّ IP يجاوز الحدّ يظهر في تقرير Cloudflare Analytics.

**دوران المفاتيح**: TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY كل ٩٠ يوماً (تنبيه cron).

---

## F-٩ / قرار مالك #٩ — Certificate pinning + Network Security Config

**الحالة**: **مؤجَّل** بقرار المالك (توازن بين صلابة MITM على شبكات Wi-Fi العامّة وعبء تدوير الشهادات).

**إن اعتُمِد لاحقاً**، الخطوات:

### Android — `network_security_config.xml`

```xml
<network-security-config>
  <domain-config cleartextTrafficPermitted="false">
    <domain includeSubdomains="true">alarabiya.online</domain>
    <pin-set expiration="2027-01-01">
      <!-- Pin على intermediate CA (لا leaf) — يستمرّ عبر تجديد الشهادة -->
      <pin digest="SHA-256">LEAF_INTERMEDIATE_PUBKEY_HASH</pin>
      <!-- Backup pin على CA بديل (Let's Encrypt / DigiCert) — يمنع bricking عند طوارئ التدوير -->
      <pin digest="SHA-256">BACKUP_CA_PUBKEY_HASH</pin>
    </pin-set>
  </domain-config>
</network-security-config>
```

يُلحق عبر Expo config plugin (`app.config.ts`) أو `expo-build-properties`.

### iOS — `NSPinnedDomains`

```xml
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSPinnedDomains</key>
  <dict>
    <key>alarabiya.online</key>
    <dict>
      <key>NSIncludesSubdomains</key><true/>
      <key>NSPinnedCAIdentities</key>
      <array>
        <dict><key>SPKI-SHA256-BASE64</key><string>INTERMEDIATE_PUBKEY</string></dict>
        <dict><key>SPKI-SHA256-BASE64</key><string>BACKUP_PUBKEY</string></dict>
      </array>
    </dict>
  </dict>
</dict>
```

### الحماية التشغيليّة اللازمة

- **cron تنبيه قبل انتهاء الشهادة بـ٣٠ يوماً** (البصمة الحاليّة تنتهي مع الشهادة).
- **backup pin على CA بديل** — بلاها، تدوير Cloudflare/Let's Encrypt يُقفل التطبيق لكلّ العملاء دفعةً واحدة.
- **مسار عودة سريع**: إصدار OTA (أو Play emergency update) خلال ساعتَين إن انقلبت البصمة قسراً.

---

## ترتيب التنفيذ المقترح

1. **الأولوية الأولى — ك-٢ (assetlinks)**: بلا هذا، Play App Links لا تعمل لأيّ عميل. صريح، لا يحتاج قراراً.
2. **الأولوية الثانية — F-٨ (deleteMe)**: Google Play يفرض حذفاً داخل التطبيق منذ مايو ٢٠٢٤. زرّ الواجهة جاهز، ينتظر endpoint.
3. **الأولوية الثالثة — ت-٣ (customerBenefits query→mutation)**: تسريب توكنات إلى access.log على VPS مشترك — قابل للاستغلال إن فُقد وصول لأودو/سراج.
4. **الأولوية الرابعة — F-٣ + F-٧ (OTP rate limits + Cloudflare WAF)**: بلا هذا، ترقية Blaze تفتح فاتورة SMS مفتوحة. ينفَّذ قبل تفعيل Blaze.
5. **الأولوية الخامسة — ت-١١ + ت-١٧ (session_version + activeCheck)**: يحتاج قرار المالك على TTL (٢٤س بـrefresh أم أسبوع بلا). ينفَّذ بعد قرار.
6. **الأولوية السادسة — ك-٣ (AASA) + F-٩ (cert pinning)**: بلا معنى قبل قرار Apple Developer + قرار مالك على cert pinning.

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
