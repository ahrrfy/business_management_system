# ربط المتجر بدومين alarabiya.online

الهدف: `https://alarabiya.online` يفتح **متجر الزبون** مباشرةً، ويبقى نظام الموظفين على
`srv1548487.hstgr.cloud` (أو على نفس الدومين عبر `/store-admin` و`/login`). التطبيق جاهز:
جذر `alarabiya.online` يُوجّه الزائر تلقائياً إلى `/store` (RootRoute في `client/src/App.tsx`)،
وحارس CSRF يشتقّ المضيف من الطلب نفسه ⇒ لا تعديل خادمي مطلوب.

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
- `https://alarabiya.online/store-admin` ⇒ لوحة الموظف (بعد الدخول).
- أنشئ طلباً تجريبياً ⇒ يُقبل (CSRF يمرّ لأن Origin=host=alarabiya.online).

## ٥) تطبيق Play Store (لاحقاً — شريحة التغليف)
عند تغليف TWA: `start_url = https://alarabiya.online/store`، و**Digital Asset Links**
(`https://alarabiya.online/.well-known/assetlinks.json`) بـSHA-256 لمفتاح توقيعك، وبيان PWA
باسم/أيقونات المتجر. أُجهّزها في شريحة النشر بالدومين المعتمد.
