# سياسة الدومينَين: العام للناس على alarabiya.online، والخاص بالشركة على دومين الخادم

**القاعدة (قرار المالك ١٤/٧/٢٦):**

| | الدومين | ماذا يعيش عليه |
|---|---|---|
| **عام — للناس** | `https://alarabiya.online` | متجر الزبون `/store` + صفحة الوظائف `/apply` (والجذر `/` يفتح المتجر) |
| **خاص — للشركة** | `https://srv1548487.hstgr.cloud` | كل ما عداه: الدخول، لوحة الموظف، الكاشير، التقارير، المخزون، **لوحة المتجر `/store-admin`**، الكشك، بوّابة الجرد… |

التطبيق واحد يُخدَم على المضيفَين (نفس عملية PM2 عبر كتلتَي nginx)، والفصل **مفروضٌ في الواجهة**
عبر `client/src/lib/siteHosts.ts` + الحارس `HostPolicy` في `client/src/App.tsx`:

- مسار داخليّ فُتح على الدومين العام ⇒ يُنقَل تلقائياً لدومين الشركة (بحفظ المسار والاستعلام).
- صفحة عامة فُتحت على دومين الشركة (`/store`، `/apply`) ⇒ تُنقَل للدومين العام.
- الجذر `/` **لا يُحوَّل** — معناه يختلف بالمضيف (العام ⇒ المتجر، الشركة ⇒ لوحة الموظف).
- **استثناء مقصود وضيّق — `/login` و`/my-deliveries` مشتركان على المضيفَين ولا يُحوَّلان:**
  تطبيق المناديب على Play (TWA) مبنيٌّ على `alarabiya.online` ويحوي اختصار «توصيلاتي»
  (`twa/twa-manifest.json`) ⇒ المندوب يسجّل دخوله ويعمل **داخل** التطبيق على الدومين العام؛
  تحويلهما كان سيقذفه خارج نطاق التطبيق. لا يُوسَّع الاستثناء لأي شاشة موظفين أخرى.
- على مضيف تطوير (localhost) ⇒ **لا سياسة إطلاقاً** (كل شيء يعمل محلياً كما هو).
- الروابط القديمة لا تنكسر: تُحوَّل. وتغيير الدومين مستقبلاً = متغيّرا بناء
  `VITE_PUBLIC_SITE_ORIGIN` / `VITE_INTERNAL_SITE_ORIGIN` (بلا مسّ الكود).

نتائج عملية: زرّ **«فتح المتجر»** في لوحة المتجر يفتح `alarabiya.online/store` (ما يراه الزبون فعلاً)؛
«دخول الفريق» مخفيّ على الدومين العام (وداخل تطبيق الجوال) فلا يقفز الزبون خارج دومين المتجر؛
وتذييل المتجر يربط صفحة الوظائف، وصفحة الوظائف تربط المتجر.

## البنية التحتية (منفَّذة ١٢/٧ — للمرجع)
جذر `alarabiya.online` يُوجّه الزائر إلى `/store`، وحارس CSRF يشتقّ المضيف من الطلب نفسه ⇒ لا تعديل خادمي مطلوب.

> ⚠️ **الخادم مشترك (سراج/أودو خطّ أحمر).** الخطوات أدناه تخصّك أنت (أو بموافقتك الصريحة):
> DNS في حساب Hostinger، وnginx/الشهادة على الـVPS. لا تلمس vhosts الآخرين.

## ١) DNS (في hPanel → Domains → alarabiya.online → DNS / Nameservers)
الدومين حالياً على nameservers الإيقاف (`lunar/solar.dns-parking.com`). أبقِ nameservers Hostinger
وعدّل منطقة DNS، أو استعملها كما هي وأضِف سجلّي A يشيران لـ**IP خادمك**:

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | `@` | `<IP الخادم>` | 3600 |
| A | `www` | `<IP الخادم>` | 3600 |

للحصول على IP الخادم: hPanel → VPS، أو من جهازك:
```
nslookup srv1548487.hstgr.cloud
```
انتظر انتشار DNS (دقائق–ساعة). تحقّق: `nslookup alarabiya.online` يعيد IP الخادم.

## ٢) nginx (على الـVPS، بموافقتك)
أضِف الدومين إلى كتلة خادم التطبيق. الأبسط: كتلة جديدة تُمرّر لنفس منفذ التطبيق (PM2):
```nginx
server {
    listen 80;
    server_name alarabiya.online www.alarabiya.online;
    location / {
        proxy_pass http://127.0.0.1:<منفذ التطبيق>;   # نفس منفذ خادم hstgr.cloud
        proxy_set_header Host $host;                    # مهم: يمرّر alarabiya.online للتطبيق
        proxy_set_header X-Forwarded-Proto $scheme;     # مهم: ليعرف التطبيق أنه https (trust proxy)
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```
`nginx -t && systemctl reload nginx`

## ٣) TLS (Let's Encrypt)
```
certbot --nginx -d alarabiya.online -d www.alarabiya.online
```
يضيف الشهادة ويحوّل 80→443 تلقائياً.

## ٤) التحقّق
- `https://alarabiya.online` ⇒ يظهر المتجر (تحويل الجذر إلى `/store`).
- `https://alarabiya.online/store` ⇒ المتجر مباشرةً.
- `https://alarabiya.online/apply` ⇒ صفحة الوظائف العامة.
- `https://alarabiya.online/store-admin` أو `/login` ⇒ **يُحوَّل تلقائياً** إلى `srv1548487.hstgr.cloud` (سياسة الدومينَين).
- `https://srv1548487.hstgr.cloud/apply` ⇒ **يُحوَّل** إلى `alarabiya.online/apply`.
- أنشئ طلباً تجريبياً ⇒ يُقبل (CSRF يمرّ لأن Origin=host=alarabiya.online).

## ٥) تطبيق Play Store (لاحقاً — شريحة التغليف)
عند تغليف TWA: `start_url = https://alarabiya.online/store`، و**Digital Asset Links**
(`https://alarabiya.online/.well-known/assetlinks.json`) بـSHA-256 لمفتاح توقيعك، وبيان PWA
باسم/أيقونات المتجر. أُجهّزها في شريحة النشر بالدومين المعتمد.
