# خطة Cloudflare + طبقة limit_req في nginx — دليل التنفيذ الكامل

> **الهدف:** سدّ الفراغ الأمامي الوحيد المتبقّي في حماية المتجر: امتصاص هجمات الإغراق
> الموزَّعة (DDoS) قبل وصولها للـVPS، وإضافة جدار معدّل رخيص في nginx يصدّ الفيضان قبل
> أن يستهلك عملية Node — مع بقاء حدود التطبيق الدقيقة (express-rate-limit) كما هي.
>
> **المعمارية بعد التنفيذ:**
> `الزائر ← Cloudflare (يمتصّ DDoS + يخفي IP الخادم + يخدم الأصول من حافته) ← nginx
> (limit_req/limit_conn لكل IP حقيقي) ← Node (حدود لكل إجراء + مصادقة/CSRF/CSP)`
>
> **نطاق القرار:** Cloudflare للدومين العام `alarabiya.online` فقط. دومين الشركة
> `srv1548487.hstgr.cloud` تابع لمضيف Hostinger ولا يمكن (ولا يلزم) إدخاله في CF —
> دخول الفريق لا يتأثر إطلاقاً. طبقة nginx تُطبَّق على **كلا** الموقعَين.

## الحالة — ✅ الخطة مكتملة التنفيذ حيّاً (٢٠/٧/٢٠٢٦)

- [x] ملفات nginx جاهزة في المستودع (`deploy/nginx-ratelimit.conf` + `deploy/nginx-cloudflare-realip.conf` + تحديث `deploy/nginx-erp.conf`) — ٢٠/٧/٢٠٢٦
- [x] الجزء ب: طبقة nginx مطبَّقة على الخادم (الأنطقة + realip + كتلتا 443 للموقعين، نسخ احتياطية `*.bak-20260720`) — **429 مُثبَتة بالقياس: ١٠٦ رفض من دفعة ٢٠٠**
- [x] الجزء أ: Cloudflare فعّال على `alarabiya.online` (حساب المالك، خطة Free): A@+www مستوردان Proxied، nameservers بُدّلت في hPanel إلى `lara`+`seamus.ns.cloudflare.com`، SSL **Full (strict)** + Always Use HTTPS + Bot Fight Mode + HTTP/3، **Rocket Loader مطفأ** (CSP)
- [x] الجزء ج: التحقق الثلاثي نجح — `CF-RAY ...-BGW` (حافة بغداد) + store/login/team=200 + **realip مُثبَت**: طلب عبر CF ظهر في access.log بالـIP الحقيقي لا بعناوين الحافة
- [ ] المرحلة ٢ الاختيارية (انظر أدناه) — مجدولة كتذكير آلي في ٣/٨/٢٠٢٦

> **الترتيب المرن (توثيق تاريخي):** الجزء ب مستقل ويمكن تطبيقه فوراً قبل الجزء أ (ملف
> realip بلا أثر حتى يمرّ الترافيك عبر CF). لكن **لا تفعّل CF قبل تطبيق الجزء ب** — بدون
> realip ستنقفل حدود المعدّل على عناوين حافة CF فيتشارك كل الزوّار ميزانية واحدة.

---

## الجزء أ — تفعيل Cloudflare (المالك، ~١٥ دقيقة على cloudflare.com)

١. أنشئ حساباً مجانياً على <https://dash.cloudflare.com/sign-up> (الخطة Free تكفي تماماً).

٢. **Add a domain** ← `alarabiya.online` ← الخطة Free. سيمسح CF سجلّات DNS الحالية
   ويستوردها تلقائياً.

٣. **راجع السجلّات المستوردة** قبل المتابعة (القائمة الحالية عند مزوّد DNS الحالي —
   لوحة Hostinger hPanel ← Domains ← alarabiya.online ← DNS):
   - سجلّ `A @` وسجلّ `www` يجب أن يشيرا إلى IP الـVPS الحالي، وحالتهما
     **Proxied (سحابة برتقالية)** — هذان فقط.
   - أي سجلّات أخرى (MX بريد، TXT تحقّق…) أبقِها **DNS only (سحابة رمادية)** كما هي.
   - إن غاب سجلّ من الاستيراد أضفه يدوياً قبل تبديل النطاقات — قارن بقائمة hPanel.

٤. **بدّل خوادم الأسماء (nameservers)** عند مسجّل الدومين (hPanel ← Domains ←
   alarabiya.online ← Nameservers) إلى الاثنين اللذين يعرضهما CF. الانتشار عادة دقائق
   إلى ساعات؛ يصلك بريد «Your site is active on Cloudflare».

٥. بعد التفعيل، اضبط في لوحة CF (كلها في الخطة المجانية):

   | الإعداد | القيمة | لماذا |
   |---|---|---|
   | SSL/TLS ← Overview | **Full (strict)** | الخادم يحمل شهادة Let's Encrypt صالحة — لا تقبل أقل من ذلك (Flexible يفتح ثغرة وسيط) |
   | SSL/TLS ← Edge Certificates ← Always Use HTTPS | **On** | تحويل 80←443 من الحافة |
   | Speed ← Optimization ← **Rocket Loader** | **Off (لا تفعّله)** | يحقن سكربتات inline والـCSP عندنا `script-src 'self'` صارم ⇒ سيكسر الواجهة |
   | Network ← HTTP/3 (with QUIC) | On | أسرع على شبكات الجوال العراقية |
   | Speed ← Optimization ← Brotli | On | ضغط أقوى من gzip |
   | Security ← Bots ← Bot Fight Mode | On | يصدّ البوتات المعروفة مجاناً |
   | Security ← Settings ← Security Level | Medium | التوازن الافتراضي الصحيح |

٦. **تجديد الشهادات لا ينكسر:** certbot يجدّد عبر HTTP-01 وLet's Encrypt يتبع تحويل
   HTTPS عبر حافة CF بلا مشكلة. لا حاجة لأي تغيير في certbot.

> **ملاحظة أمنية:** بعد أسبوعين من الاستقرار يمكن (اختيارياً — «المرحلة ٢» أدناه) حصر
> موقع `alarabiya.online` في nginx بنطاقات CF فقط، فيستحيل ضرب الخادم مباشرة بتجاوز CF.

---

## الجزء ب — طبقة nginx على الخادم (جلسة SSH واحدة، ~١٠ دقائق، كـroot)

> ⚠️ خادم مشترك (سراج خط أحمر): كل الملفات **جديدة باسمنا** (`alroya-*`)، التوجيهات
> السلوكية داخل كتل server **لنا فقط**، و`reload` دائماً — **لا restart**.

```bash
# 0) اجلب آخر main (فيه ملفات deploy الجديدة):
cd ~/erp && git pull --ff-only origin main        # عدّل المسار إن اختلف مجلد المستودع

# 1) الأنطقة (http context — تعريف فقط، صفر أثر حتى تُستعمل):
sudo cp deploy/nginx-ratelimit.conf /etc/nginx/conf.d/alroya-ratelimit-zones.conf

# 2) مقتطف Cloudflare realip (بلا أثر قبل تفعيل CF):
nginx -V 2>&1 | grep -o with-http_realip_module   # يجب أن يطبع اسم الوحدة
sudo mkdir -p /etc/nginx/snippets
sudo cp deploy/nginx-cloudflare-realip.conf /etc/nginx/snippets/alroya-cloudflare-realip.conf

# 3) حدّد ملفَي الموقعَين الحيَّين (اسم ملف موقع المتجر قد يختلف):
grep -rln "srv1548487.hstgr.cloud" /etc/nginx/sites-enabled/
grep -rln "alarabiya.online"       /etc/nginx/sites-enabled/
```

**٤) عدّل كل كتلة `server` تخدم 443 في الملفَين** (كتل التحويل 80←443 لا تحتاج شيئاً)،
وأضف بعد سطر `server_name` مباشرة:

```nginx
    # --- حماية alroya: realip خلف Cloudflare + حدود معدّل (docs/cloudflare-plan.md) ---
    include snippets/alroya-cloudflare-realip.conf;
    limit_req_status  429;
    limit_conn_status 429;
    limit_req_log_level warn;
    limit_conn alroya_conn 80;
    limit_req  zone=alroya_general burst=120 nodelay;
```

**٥) (موصى به) سقف أدنى لسطح الـAPI:** في كل من الكتلتين أضف قبل `location /` كتلة
`location /api/` منسوخة منها حرفياً (proxy_pass وكل ترويساته كما هي) مع سطر واحد إضافي
في أولها:

```nginx
    location /api/ {
        limit_req zone=alroya_api burst=60 nodelay;
        # …بقية توجيهات البروكسي كما في location / تماماً (proxy_pass لا يُورَّث)…
    }
```

> المرجع الكامل للشكل النهائي: كتلة server في `deploy/nginx-erp.conf` بعد تحديث ٢٠/٧.

```bash
# 6) فحص ثم تحميل (لا restart):
sudo nginx -t && sudo systemctl reload nginx

# 7) تأكيد أن التوجيهات حيّة:
sudo nginx -T | grep -E "alroya_(general|api|conn)|CF-Connecting-IP" | head
```

---

## الجزء ج — التحقق

```bash
# ١) الحدود تعمل (من أي جهاز خارجي): دفعة متوازية ⇒ خليط 200 و429 بعد العتبة:
for i in $(seq 1 200); do curl -s -o /dev/null -w "%{http_code}\n" \
  https://alarabiya.online/healthz & done | sort | uniq -c
# المتوقع: أغلبها 200 وظهور 429 بعد استنفاد burst — ثم تعود 200 خلال ثوانٍ.

# ٢) CF فعّال (بعد الجزء أ): الترويسات تحمل بصمة الحافة:
curl -sI https://alarabiya.online/store | grep -iE "^(server|cf-ray|cf-cache-status)"
# المتوقع: server: cloudflare + cf-ray: …

# ٣) الـIP الحقيقي مسترجَع (الأهم): بعد CF افتح المتجر من هاتفك (بيانات خلوية) ثم:
sudo tail -20 /var/log/nginx/access.log
# المتوقع: يظهر IP هاتفك الحقيقي لا 104.x/172.x (نطاقات CF). إن ظهرت نطاقات CF
# ⇒ realip لا يعمل — راجع الخطوة ب-٤ فوراً (وإلا انقفلت الحدود على الجميع).

# ٤) دخول الفريق سليم: https://srv1548487.hstgr.cloud يعمل كما هو (خارج CF بالكامل).

# ٥) تطبيق المناديب (TWA على alarabiya.online): دخول + «توصيلاتي» يعملان عبر CF.
```

**تراجع سريع عند أي مشكلة:**
- طبقة nginx: احذف الأسطر المضافة من كتل server (أو علّقها) ← `nginx -t && reload`.
  الملفان في conf.d/snippets يبقيان بلا ضرر (تعريفات خاملة).
- Cloudflare: حوّل سجلَّي `@` و`www` إلى **DNS only (رمادي)** في لوحة CF ⇒ يعود
  الترافيك مباشراً للخادم خلال دقائق **بلا** تبديل nameservers من جديد.

---

## المرحلة ٢ (اختيارية، بعد أسبوعَي استقرار)

1. **حصر موقع المتجر بنطاقات CF:** داخل كتلة server لـ`alarabiya.online` فقط:
   `allow` لكل نطاقات CF (نفس قائمة snippet) ثم `deny all;` ⇒ يستحيل ضرب الأصل مباشرة
   بتجاوز CF. لا تُطبّقها على `srv1548487.hstgr.cloud` (يُخدَم مباشرة بلا CF).
2. **قاعدة Rate Limiting في CF** (الخطة المجانية تشمل قاعدة واحدة): على مسار
   `/api/trpc/*storefront.createOrder*` بسقف ~10 طلبات/دقيقة لكل IP — صدّ من الحافة
   قبل الخادم أصلاً.
3. **WAF Custom Rules:** حظر جغرافي أو تحدّي (Managed Challenge) لأي ترافيك خارج
   الأسواق المستهدفة إن ظهر نمط إساءة.

## لماذا لا يتغيّر أي سطر في كود التطبيق؟

- `trust proxy = 1` في `server/index.ts` يبقى صحيحاً: nginx (بعد realip) يكتب IP
  الزائر الحقيقي في نهاية `X-Forwarded-For`، وExpress يثق بقفزة واحدة فيقرأه بدقة —
  كل حدود المعدّل الثمانية في التطبيق تستمر بالعمل لكل زائر على حدة.
- الكوكي `secure` وفحص CSRF: nginx يمرّر `Host` و`X-Forwarded-Proto` كما كان؛ CF
  يمرّر Host الأصلي — لا تغيير.
- لا WebSockets في الإنتاج، وأكبر جسم طلب على الدومين العام صغير — قيود CF المجانية
  (مهلة ~100 ثانية، جسم 100MB) لا تلمسنا. رفع النسخ الاحتياطية الضخم
  (`system.restoreUpload`) على دومين الشركة خارج CF أصلاً.
