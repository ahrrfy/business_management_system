# أرشيف حملة الإغلاق الهندسي والمالي والأمني الشامل للمتجر الإلكتروني وتطبيق الزبائن (الموجات W0–W4) — 2026-10-26

- **خطّ الأساس القياسي (`W0`):** الفرع المعزول `session/w0-measure` عند الالتزام المرجعي `db1e53b83`.
- **طلبات الدمج المدموجة على `main`:** `PR #1569` (`9883dd77d`) · `PR #1570` (`4a5f0f841`) · `PR #1572` (`7c5aeb71f`) · `PR #1574` (`eedf5e43f`) · `PR #1576` (`1b118efcd`) · `PR #1578` (`12eed0656`) · `PR #1579` (`df75c9851`) · `PR #1581` (`ac26c9a72` — رأس الفرع `027c3398a`) · `PR #1580` (`8ec965264` — رأس الفرع `48e3b025f`).
- **الالتزام المنشور في الإنتاج على `main`:** `8ec96526401661834fc82216dc26b9c914086b1b` (خلفاً لـ `df75c98519fbb555bffddd04b3f6611ff70e770f`).
- **إصدار الإنتاج المنشور ذرّياً:** `web-1793020235033-8ec965264016` (`https://alarabiya.online` و`https://srv1548487.hstgr.cloud` — `281.4s` عبر الخطوات `0/12..11/12`، `/healthz` `200 ok:true`، وبوابة `verify-nginx-storefront-readiness.mjs` خضراء `categories=85 products=1 quote=ok` على المضيفَين).

---

## ١. الموجة W0 وW1 — القياس المرجعي، الأمان الحدودي، تحسين محركات البحث، وتحصين المعاملات والجوال

1. **خطّ الأساس القياسي (`W0` — `session/w0-measure` @ `db1e53b83`):** تثبيت مقاييس الحزم المبدئية ومسارات tRPC العامة وحدود الفصل بين الدومين العام (`alarabiya.online`) ومضيف النظام الداخلي (`srv1548487.hstgr.cloud`) قبل بدء موجات التعديل.
2. **تحصين السيو والبيانات المنظّمة وخريطة الموقع (`W1-B` — `PR #1569`، `9883dd77d`):**
   - إزالة التقييمات الوهمية الثابتة (`aggregateRating` بقيم `4.9` / `128`) من حقن JSON-LD في [`server/services/storefrontSeoMetaService.ts`](../server/services/storefrontSeoMetaService.ts) والاكتفاء بالكيانات الموثوقة (`WebSite`، `Store`، `FAQPage`، وبيانات المنتج الفعلية).
   - عزل المضيف الداخلي عن حقن سيو المتجر العام في المسار الجذري (`/`) عبر فحص `isPublicStorefrontHost(req.get("host"))` بحيث لا تُحقن بيانات JSON-LD التسويقية على `srv1548487.hstgr.cloud`.
   - تثبيت الأصل القانوني (`https://alarabiya.online`) في [`server/services/storefrontSitemapService.ts`](../server/services/storefrontSitemapService.ts) و[`server/routes/sitemap.ts`](../server/routes/sitemap.ts) لمنع تسميم `sitemap.xml` عبر ترويسة `X-Forwarded-Host` المزوَّرة.
3. **حراسة الدومين العام ومنع تضخيم الدفعات الحساسة (`W1-A` — `PR #1570`، `4a5f0f841`):**
   - تحصين حدود المضيف العام في [`server/middleware/publicStorefrontHost.ts`](../server/middleware/publicStorefrontHost.ts) لحجب إجراءات النظام الداخلي (`courier.*`، `push.*`، وسائر راوترات ERP) على الدومين العام.
   - استحداث حارس الدفعات الحساسة في [`server/middleware/publicSensitiveBatch.ts`](../server/middleware/publicSensitiveBatch.ts) (`PUBLIC_SENSITIVE_PROCEDURES` و`hasOverfilledPublicSensitiveBatch`) لرفض أي طلب HTTP batch يجمع أكثر من إجراء عام حسّاس أو يخلط ترميز المسارات (`%` أو الفواصل المائلة الإضافية)، وتثبيت متغيرات JWT في [`ecosystem.config.cjs`](../ecosystem.config.cjs).
4. **عزل حزمة المتجر وتجربة الواجهة والجوال والمعاملات (`PR #1572` @ `7c5aeb71f`، `W1-UI-Mobile` `PR #1574` @ `eedf5e43f`، `W1-Backend-Tx` `PR #1576` @ `1b118efcd`):**
   - فصل قشرة إقلاع المتجر في [`client/src/BootstrapApp.tsx`](../client/src/BootstrapApp.tsx) و[`client/src/lib/siteHosts.ts`](../client/src/lib/siteHosts.ts) وتقليص قائمة PWA المسبقة وفق عقد [`scripts/storefront-pwa-contract.mjs`](../scripts/storefront-pwa-contract.mjs).
   - ضبط نقرات عدّاد السلة السريعة، وحراسة قنوات SSE العامة في [`client/src/lib/realtime/realtimeManager.ts`](../client/src/lib/realtime/realtimeManager.ts)، وتوحيد دورة حياة القسائم وفلاتر العروض والبحث في تطبيق الزبائن [`expo/customer-store-mobile/`](../expo/customer-store-mobile/).
   - إغلاق تعارضات الأقفال المتبادلة (`Deadlocks`) عند مطابقة هوية الزبون في [`server/services/storefrontCustomerIdentityService.ts`](../server/services/storefrontCustomerIdentityService.ts)، وصون ملاحظات الطلب ومناطق التوصيل المخصّصة عند التعديل الإداري في [`server/services/storeAdmin/orderFulfillmentService.ts`](../server/services/storeAdmin/orderFulfillmentService.ts) و[`client/src/components/store/EditOnlineOrderDialog.tsx`](../client/src/components/store/EditOnlineOrderDialog.tsx).

---

## ٢. الموجة W3 — فصل أنماط CSS العامة عن ERP وقفل ميزانية الحزمة (`PR #1578`، `12eed0656`)

1. **فصل شجرة الأنماط إلى مسارين مستقلّين:** تقسيم الأنماط بين [`client/src/index.css`](../client/src/index.css) (القشرة العامة للمتجر فقط) و[`client/src/erp.css`](../client/src/erp.css) + [`client/src/styles/erp-variants.css`](../client/src/styles/erp-variants.css) (تُحمَّل كسولاً مع شجرة ERP)، مع الحفاظ على طبقة الأدوات الدلالية في [`client/src/lib/theme/semantic-utilities.css`](../client/src/lib/theme/semantic-utilities.css) وإعادة ضبط الطباعة العامة.
2. **إلغاء استعلام الهوية غير الضروري على الجذر العام:** إزالة رحلة `auth.me` الشبكية التلقائية عند فتح المسار العام للمتجر لخفض زمن التفاعل الأولي.
3. **قفل ميزانية CSS وحزمة PWA بحرّاس آليين:** فرض سقف صارم لحجم ملف CSS العام (`< 300 KB` غير مضغوط؛ الناتج الفعلي المنشور `202,257` بايت = `197.52 KiB`، و`31.90 kB` مضغوطاً بـ gzip) عبر [`scripts/audit-build-budgets.mjs`](../scripts/audit-build-budgets.mjs) و[`scripts/verify-storefront-pwa-build.mjs`](../scripts/verify-storefront-pwa-build.mjs) (`42` مدخلاً في precache بحجم `1,661.43 KiB`).

---

## ٣. الموجة W2 — خصوصية حذف الحساب، أصول التخصيص المحمية، وطلبات عروض أسعار الشركات B2B

### ٣.١ البنية الخلفية والمخطط (`W2-A` — `PR #1579`، `df75c9851`)
1. **الهجرة الإضافية الخالية من التوقف [`drizzle/migrations/0406_storefront_w2_privacy_customization.sql`](../drizzle/migrations/0406_storefront_w2_privacy_customization.sql):**
   - إضافة أعمدة الحذف المتوافق مع متطلبات المتاجر والاحتفاظ المحاسبي لمدة سنة واحدة في `customers`: `deletedAt` (`timestamp NULL`)، `retentionUntil` (`timestamp NULL`)، و`sessionVersion` (`int NOT NULL DEFAULT 0`)، مع الفهرس المركّب `idx_customers_deleted_retention (deletedAt, retentionUntil)`.
   - إضافة عمود `onlineOrders.customerNotes` (`text NULL`) لحفظ ملاحظات الزبون عند الدفع بشكل منفصل وواضح.
   - إنشاء جدول `storefrontAccountDeletionRequests` (`uq_sf_acct_del_req_num`، `idx_sf_acct_del_phone_hash`، `idx_sf_acct_del_status`، `idx_sf_acct_del_customer`، والمفتاح الأجنبي `fk_sf_acct_del_customer` بـ `ON DELETE SET NULL`).
   - إنشاء جدول `storefrontCustomizationAssets` (`uq_sf_custom_asset_key`، `idx_sf_custom_asset_sha_kind`، `idx_sf_custom_asset_expires`، بأنواع MIME محصورة في `image/png` و`image/jpeg` و`image/webp` ونوعَي `LOGO` و`PREVIEW`).
2. **التحصين الأمني للرفع والخصوصية:**
   - إغلاق سباق MVCC المتزامن في حذف الحساب وإبطال الجلسات النشطة فوراً عبر رفع `customers.sessionVersion` في [`server/services/storefrontAccountDeletionService.ts`](../server/services/storefrontAccountDeletionService.ts).
   - فحص التوقيع الثنائي الحقيقي للصور (منع ملفات Polyglot)، وتحديد سقف حجم الطلب عند `3 MB` في [`server/middleware/bodyParsers.ts`](../server/middleware/bodyParsers.ts)، وتقييد عدد الأصول غير المربوطة في [`server/services/storefrontCustomizationAssetService.ts`](../server/services/storefrontCustomizationAssetService.ts).
   - تقييد مسار قراءة صور التخصيص `/api/img/order-customization/*` في [`server/imageRoute.ts`](../server/imageRoute.ts) بمصادقة الموظف وعزل الفروع (`401` لغير المصادقين)، ومنع استهلاك رموز Turnstile عند إيقاف الطلبات مؤقتاً في [`server/services/storefrontTurnstile.ts`](../server/services/storefrontTurnstile.ts).

### ٣.٢ ربط واجهات الويب والجوال والطباعة (`W2-UI` — `PR #1580`، `8ec965264`، رأس الفرع `48e3b025f`)
1. **استوديو التخصيص ومرفقات عروض أسعار الجملة والشركات (B2B):**
   - ربط رفع الشعار والمعاينة المولّدة إلى تخزين R2 في [`client/src/components/storefront/StorefrontCustomizerStudio.tsx`](../client/src/components/storefront/StorefrontCustomizerStudio.tsx) مع إبطال المعاينة تلقائياً عند تعديل أي حقل نصّي أو قالب ومنع الإضافة للسلة قبل اكتمال التوليد.
   - ترميز مرفقات التصميم المخصّصة داخل العمود الفعلي `storefrontQuoteRequests.customerNote` (`TEXT`) عبر [`server/lib/quoteRequestCustomizationMeta.ts`](../server/lib/quoteRequestCustomizationMeta.ts) و[`server/services/storefrontQuoteRequestService.ts`](../server/services/storefrontQuoteRequestService.ts) بالفاصل الصريح `QUOTE_CUSTOMIZATION_TRAILER_MARKER = "\n---SRQ_CUSTOM_ASSETS_V1---\n"`، مع فرض سقف صارم لعدد المرفقات `MAX_QUOTE_CUSTOMIZATION_ATTACHMENTS = 30` وسقف بايتات UTF-8 الكلّي `MAX_QUOTE_CUSTOMER_NOTE_UTF8_BYTES = 65_535` بايت لمنع اقتطاع MySQL `TEXT` أو فقدان المقطورة المرفقة، ورفع طبقة حوار [`client/src/components/storefront/StorefrontQuoteRequestDialog.tsx`](../client/src/components/storefront/StorefrontQuoteRequestDialog.tsx) فوق قشرة السلة مع حفظ كميات كل تصميم.
2. **مسار حذف الحساب الذاتي للويب وتطبيق الجوال:**
   - تفعيل صفحة [`client/src/pages/LegalDocument.tsx`](../client/src/pages/LegalDocument.tsx) على المسار العام `/legal/delete-account`، وتجربة حذف الحساب المحمية بـ OTP في [`expo/customer-store-mobile/app/(tabs)/account.tsx`](../expo/customer-store-mobile/app/(tabs)/account.tsx) و[`expo/customer-store-mobile/lib/account-deletion.ts`](../expo/customer-store-mobile/lib/account-deletion.ts).
3. **ظهور ملاحظات الزبون وأصول التخصيص في التجهيز والطباعة، وعزل استبدال النقاط:**
   - عرض `customerNotes` ومعاينات التخصيص في [`client/src/pages/OrderFulfillment.tsx`](../client/src/pages/OrderFulfillment.tsx) و[`client/src/pages/store/StoreQuoteRequests.tsx`](../client/src/pages/store/StoreQuoteRequests.tsx) وقوالب الطباعة الحرارية وملصقات الشحن [`client/src/lib/printing/onlineOrder.ts`](../client/src/lib/printing/onlineOrder.ts) و[`client/src/lib/printing/shippingLabel.ts`](../client/src/lib/printing/shippingLabel.ts).
   - إدراج `storefront.redeemLoyaltyPoints` في `PUBLIC_SENSITIVE_PROCEDURES` ([`server/middleware/publicSensitiveBatch.ts`](../server/middleware/publicSensitiveBatch.ts)) وفي `NON_BATCHED_STOREFRONT_PROCEDURES` عبر رابط التقسيم الشبكي في [`client/src/lib/trpcClient.ts`](../client/src/lib/trpcClient.ts) لضمان إرساله بطلبٍ منفرد لا يُحجب بحارس الدفعات.

---

## ٤. الموجة W4 — الحقيقة المالية الصافية بعد المرتجعات، مزامنة الإيداع، ودفتر الولاء الكامل (`PR #1581`، `ac26c9a72`، رأس الفرع `027c3398a`)

1. **الهجرة الآمنة لدفتر نقاط الولاء [`drizzle/migrations/0407_loyalty_ledger_multi_reverse.sql`](../drizzle/migrations/0407_loyalty_ledger_multi_reverse.sql):**
   - إضافة العمود `idempotencyKey varchar(100) NULL` والفهرس الفريد `uq_loyalty_ledger_idempotency (idempotencyKey)` على جدول `loyaltyLedgerEntries`.
   - إنشاء الفهرس غير الفريد `idx_loyalty_ledger_order (onlineOrderId)` **قبل** حذف الفهرس الفريد القديم `uq_loyalty_order_earn` كي يحتفظ المفتاح الأجنبي `fk_loyalty_ledger_order` بفهرسٍ داعم على MySQL 8.4 دون كسر القيد المرجعي.
   - تعبئة المفاتيح التاريخية لقيود الاكتساب القائمة عبر `UPDATE loyaltyLedgerEntries SET idempotencyKey = CONCAT('earn:order:', onlineOrderId) WHERE entryType = 'ORDER_EARN' AND onlineOrderId IS NOT NULL AND idempotencyKey IS NULL`.
2. **ترتيب الأقفال القانوني ومنع الاسترداد الزائد عند المرتجعات الجزئية المتعددة:**
   - توحيد ترتيب الأقفال التشاؤمية (`SELECT ... FOR UPDATE`) في [`server/services/storeAdmin/loyaltyService.ts`](../server/services/storeAdmin/loyaltyService.ts) بالترتيب الصارم `customers -> loyaltyPrograms -> loyaltyAccounts` لمنع الأقفال المتبادلة تحت الضغط المتزامن.
   - استخدام قراءة قافلة حالية (`FOR UPDATE`) لمجموع قيود العكس السابقة (`entryType = 'ORDER_REVERSE'`) الخاصة بالطلب لتجاوز لقطة `REPEATABLE READ` القديمة عند تداخل مرتجعَين جزئيَّين متزامنَين، مع دعم قيود `ORDER_REVERSE` المتعددة لكل طلب عبر `idempotencyKey` مستقلّ لكل مرتجع أو إلغاء.
3. **سلامة التقارير الصافية ومزامنة التسويات ودورة حياة البيع والقسائم:**
   - احتساب صافي المبيعات وقيمة العميل بعد خصم المرتجعات في [`server/services/storeAdmin/storeAnalyticsService.ts`](../server/services/storeAdmin/storeAnalyticsService.ts) و[`server/services/storeAdmin/storeCustomerService.ts`](../server/services/storeAdmin/storeCustomerService.ts).
   - مزامنة حالة طلبات المتجر عند تسوية الإيداع في [`server/services/reconcileService.ts`](../server/services/reconcileService.ts)، واسترداد نقاط الولاء المكتسبة عند المرتجع أو إلغاء الفاتورة في [`server/services/returnService.ts`](../server/services/returnService.ts) و[`server/services/sale/cancel.ts`](../server/services/sale/cancel.ts)، وصون حالة الطلب الإلكتروني عند تصحيح الفاتورة في [`server/services/sale/correct.ts`](../server/services/sale/correct.ts).
   - تصفية `isAutoBounceBack` داخل استعلام SQL قبل `LIMIT 10` في `issueBounceBackCouponTx` ضمن [`server/services/couponService.ts`](../server/services/couponService.ts)، ومواءمة معاينة استبدال النقاط في [`expo/customer-store-mobile/app/loyalty.tsx`](../expo/customer-store-mobile/app/loyalty.tsx).

---

## ٥. سجلّ النشر الإنتاجي الذري والتحقق الميداني والأمني الحي (٢٦/١٠/٢٠٢٦)

1. **بوابات ما قبل النشر على `8ec96526401661834fc82216dc26b9c914086b1b`:**
   - اخضرار `CI` (`Run 40320718150` — `12/12` وظيفة ناجحة)، و`Security Audit` (`Run 40320718166` / Check `121564649882`)، و`Expo Mobile Check` (`Run 40320717997` — `2/2` وظيفة ناجحة)، وإرجاع `assertRemoteCiGreenForDeploy("8ec96526401661834fc82216dc26b9c914086b1b")` للنتيجة `{"ok":true,"code":"OK","source":"head"}`.
   - فحص جاهزية خادم الإنتاج `alroya-erp` كمستخدم `deploy` حصراً (دون لمس خدمات `siraaj` أو `odoo` المشتركة): مساحة قرص حرة `143 GB` (`27%` مستخدم)، ذاكرة متاحة `9,318 MB`، وتشغيل محرك Node `v24.22.1`.
2. **النشر الذري (`pnpm prod:deploy` — `281.4s`) والنسخ الاحتياطي والتحقق من المخطط:**
   - **النسخة الاحتياطية قبل الهجرة (الخطوة `4/12`):** إنشاء `/home/deploy/erp/backups/erp-2026-10-26T13-10-37-449Z-1e61b632.sql` (`366,858,929` بايت / `350 MB`) والنسخة المشفّرة `/home/deploy/erp/backups/erp-2026-10-26T13-10-37-449Z-1e61b632.sql.gpg` (`76,666,352` بايت / `73.1 MB`)، وسحب النسخة المشفّرة خارج الخادم إلى محطة Windows عبر `pnpm backup:pull-vps` (`C:\Users\alara\erp-vps-backups\erp-2026-10-26T13-10-37-449Z-1e61b632.sql.gpg` — `76,666,352` بايت).
   - **تطبيق الهجرة والتحقق من القاعدة (الخطوتان `5/12` و`6/12`):** تطبيق `0407_loyalty_ledger_multi_reverse.sql` بنجاح (`__drizzle_migrations` المعرّف `id=369`، البصمة `d5ef9d54dfab45e59ca427d552b703b93674a2376e16c07caf0c577392f8d56a`)، واجتياز `pnpm db:verify` (`138` جدولاً مطابقاً للقطة `0118`، `47` فهرساً حرجاً، و`39` جدولاً + `126` عموداً بعد `0034`)، مع التثبّت المباشر على MySQL الإنتاجي من وجود `idempotencyKey` و`uq_loyalty_ledger_idempotency` و`idx_loyalty_ledger_order` وحذف `uq_loyalty_order_earn` وبقاء قيد `fk_loyalty_ledger_order` سليماً.
   - **تبديل الإصدار واستقرار العمليات (الخطوات `8/12..11/12`):** نجاح مسبار التوافق العكسي وتفعيل الإصدار `web-1793020235033-8ec965264016` عبر `.runtime/web-current`، واستقرار عمّال `erp-server` (`1, 2, 3`) وخدمة `erp-hr-bridge` (`pm_id=26`، `restarts=0`، `unstable=0`) مع خلوّ سجلات الأخطاء من أي استثناءات تشغيلية.
3. **الفحوص الميدانية والأمنية الحيّة بعد النشر:**
   - **الصحة وجاهزية المضيفَين:** `https://alarabiya.online/healthz` و`https://srv1548487.hstgr.cloud/healthz` يُرجعان `200 OK` (`{"ok":true}`), واجتياز `verify-nginx-storefront-readiness.mjs` على المضيفَين (`categories=85 products=1 quote=ok`)، بينما يُحجب `/api/health` على `alarabiya.online` بـ `404` وفق قائمة سماح Nginx الصارمة لـ `/api/`.
   - **العزل والحجم والبيانات المنظّمة:** `https://alarabiya.online/` و`https://alarabiya.online/store` يُرجعان `200 OK` بملف أنماط واحد `/assets/index-CLbtthWj.css` (`202,257` بايت `< 300 KB`) وصفر مقاطع ERP في HTML الأولي (`hasErp=false`) وثلاث كتل JSON-LD خالية تماماً من التقييم الوهمي (`hasFakeRating=false`)، مع خلوّ `https://srv1548487.hstgr.cloud/` من حقن JSON-LD الخاص بالمتجر العام (`srvRootHasJsonLd=false`).
   - **الخصوصية وخريطة الموقع وحماية الترويسات:** `/legal/delete-account` (`200 OK`)، و`/robots.txt` (`200 OK`)، و`/sitemap.xml` (`200 OK` بـ `5,816` رابطاً قانونياً يبدأ جميعها بـ `https://alarabiya.online` مع ثبات الأصل الكامل ورفض التسميم عند إرسال `X-Forwarded-Host: evil.example`).
   - **حرّاس tRPC والدفعات والصور الخاصة:** إرجاع `404` لكلٍّ من `/api/trpc/courier.myDeliveries` و`/api/trpc/push.publicKey` على الدومين العام، ورفض الطلب المجمّع `POST /api/trpc/storefront.settings,storefront.redeemLoyaltyPoints?batch=1` بـ `400 BAD_REQUEST`، ورفض الوصول غير المصادق إلى `/api/img/order-customization/nonexistent.png` بـ `401`.
