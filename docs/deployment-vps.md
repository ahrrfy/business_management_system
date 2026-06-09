# دليل النشر السحابي على VPS — قاعدة مركزية واحدة للفرعين

> هذا الدليل خاصّ بنموذج التشغيل المعتمد: **خادم VPS واحد على السحابة، قاعدة بيانات مركزية واحدة
> تخدم كل الفروع، والوصول عبر المتصفّح بـHTTPS**. للنشر المحلّي على Windows راجع `docs/redeploy.md`
> وللتعافي راجع `docs/disaster-recovery.md`.

## ١. النموذج — لماذا هو أبسط مما يبدو

- **خادم واحد، قاعدة واحدة، مصدر حقيقة واحد.** كل البيانات (مبيعات، مخزون، ذمم، ورديات) على VPS واحد.
- **الفرعان = عميلان في المتصفّح.** الفرع الثاني لا يحتاج خادماً ولا قاعدة ولا VPN ولا مزامنة — يفتح
  `https://erp.<نطاقك>` في المتصفّح فقط. عزل الفروع (branchId) وصلاحيات الأدوار مفروضة في الخادم أصلاً،
  فيرى كلّ كاشير فرعه فقط (إلّا المدير/الأدمن). هذا يحقّق «قاعدة مركزية للكل» تلقائياً بلا تعقيد.
- **القاعدة لا تُكشف للإنترنت.** المنفذ 3306 محجوب بجدار النار؛ التطبيق وحده يصلها على `localhost`.

## ٢. المتطلّبات

| البند | التوصية |
|---|---|
| VPS | Ubuntu 22.04/24.04 LTS · ٢ vCPU · ٤ GB RAM · ٤٠ GB SSD (كافٍ لمتجر؛ زِد RAM للقاعدة عند نمو البيانات) |
| نطاق | `erp.<نطاقك>` يشير (A record) إلى IP الخادم — لازم لـHTTPS |
| البرمجيات | Node.js 20+ · pnpm 9+ · Docker + compose · nginx · certbot · ufw |

```bash
# تثبيت الأساسيات على Ubuntu
sudo apt update && sudo apt -y upgrade
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt -y install nodejs
sudo npm i -g pnpm pm2
sudo apt -y install nginx certbot python3-certbot-nginx
curl -fsSL https://get.docker.com | sh        # Docker + compose plugin
sudo usermod -aG docker $USER                  # ثم أعد تسجيل الدخول
```

## ٣. النشر — خطوة بخطوة

```bash
# 1) المستودع
git clone <REPO_URL> erp && cd erp
pnpm install

# 2) البيئة (إنتاج)
cp .env.example .env
```

حرّر `.env` بقيم الإنتاج (الحدّ الأدنى الإلزامي):

| المتغيّر | قيمة الإنتاج | ملاحظة |
|---|---|---|
| `NODE_ENV` | `production` | يُفعّل CSP المُحكَم ويُخفّف ضوضاء السجلّ |
| `PORT` | `3000` | يستمع داخلياً؛ nginx يُمرّر إليه |
| `DATABASE_URL` | `mysql://root:<قوية>@127.0.0.1:3306/erp` | **القاعدة المركزية** على نفس الخادم |
| `DB_ROOT_PW` / `DB_NAME` / `DB_CONTAINER` | `<قوية>` / `erp` / `erp-mysql` | تُستعمل في النسخ الاحتياطي + compose |
| `JWT_SECRET` | `openssl rand -hex 32` | **بدّله؛ لا تترك القيمة الافتراضية أبداً** |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | بريدك / كلمة قويّة | يُنشئ أوّل مدير عند البذرة |
| `ALLOWED_ORIGINS` | **اتركه فارغاً** | التطبيق أحادي الأصل (نفس النطاق) فلا يحتاج CORS. املأه فقط لو فصلت الواجهة على نطاق آخر |
| `BACKUP_KEEP_WEEKLY` | `8` مثلاً | عدد النسخ الأسبوعية المُحتفَظ بها |

```bash
# 3) القاعدة المركزية (تخزين دائم عبر docker-compose)
docker compose up -d
docker compose ps                 # انتظر "healthy"

# 4) المخطط + أوّل بذرة (مدير + فروع)
pnpm db:push
pnpm seed

# 5) البناء + تشغيل تلقائي عند الإقلاع (PM2 + systemd)
pnpm check && pnpm build
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd               # نفّذ السطر الذي يطبعه (بصلاحيات sudo) ⇒ يبدأ تلقائياً بعد إعادة الإقلاع
```

## ٤. nginx + HTTPS (إلزامي)

> الكوكي الأمني (`secure`) لا يُرسَل إلّا على HTTPS، والخادم يكتشف HTTPS عبر `X-Forwarded-Proto`
> (لأنّ `trust proxy` مُفعَّل). لذا **يجب** تمرير هذه الترويسة وإلّا فشل تسجيل الدخول.

`/etc/nginx/sites-available/erp`:
```nginx
server {
    server_name erp.example.com;            # ← نطاقك
    client_max_body_size 25m;               # صور أوامر الشغل/الإيصالات تُرسَل كـdata URLs كبيرة
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;             # لفحص CSRF (مطابقة الأصل بالمضيف)
        proxy_set_header X-Forwarded-Proto $scheme;          # ← حرج: ليُضبَط الكوكي secure
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;  # IP الحقيقي (rate-limit + تدقيق)
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header Upgrade           $http_upgrade;     # WebSocket (إن لزم)
        proxy_set_header Connection        "upgrade";
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/erp /etc/nginx/sites-enabled/erp
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d erp.example.com      # يُصدر TLS ويُحوّل 80→443 تلقائياً
```

## ٥. جدار النار (ufw) — احجب القاعدة عن الإنترنت

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'      # 80 + 443
sudo ufw deny 3306               # القاعدة المركزية تُصان داخلياً فقط
sudo ufw enable
sudo ufw status
```

## ٦. النسخ الاحتياطي — أسبوعي على الخادم + نسخة خارجية يدوية

النموذج المعتمد: **نسخة أسبوعية تلقائية على الخادم** (`backup.mjs`: mysqldump متّسق `--single-transaction`
+ تدوير حسب `BACKUP_KEEP_WEEKLY`)، **ثم تنزيل ملف خارجي يدوياً** دورياً.

```bash
# جدولة أسبوعية (الأحد ٢:٠٠ ص) عبر cron
crontab -e
# أضِف السطر (عدّل المسار):
0 2 * * 0  cd /home/<user>/erp && /usr/bin/pnpm db:backup >> /home/<user>/erp/logs/backup.log 2>&1
```

```bash
# النسخة الخارجية اليدوية (من جهازك، دوريّاً): نزّل أحدث ملف
scp <user>@<vps-ip>:/home/<user>/erp/backups/$(ssh <user>@<vps-ip> 'ls -t /home/<user>/erp/backups | head -1') ~/erp-backups/
```

> ⚠️ **النسخة على نفس الخادم لا تحمي من تلف الخادم.** النسخة الخارجية اليدوية هي شبكة الأمان الفعلية —
> اجعلها عادة منتظمة (أسبوعياً بعد النسخة المجدولة)، واحفظها في مكانين مختلفين.

**الاستعادة** (راجع `docs/disaster-recovery.md` §٢؛ على Linux نفس الأوامر):
```bash
docker exec -i erp-mysql mysql -uroot -p<pw> < backups/<ملف-النسخة>.sql
```
نفّذ **اختبار استعادة ربع سنوي** (DR §٣) — نسخة لا تُختبَر = نسخة وهمية.

## ٧. التحديثات اللاحقة (نشر إصدار جديد)

```bash
cd erp && git pull
pnpm install
pnpm db:push          # إن تغيّر المخطّط (خذ نسخة احتياطية أوّلاً: pnpm db:backup)
pnpm check && pnpm build
pm2 reload erp-server  # إعادة تحميل بلا انقطاع تقريباً
```

## ٨. قائمة تحقّق ما بعد النشر

- [ ] `https://erp.<نطاقك>` يفتح بقفل TLS صحيح ويقبل تسجيل الدخول (الكوكي secure يعمل ⇒ X-Forwarded-Proto مضبوط).
- [ ] فتح الموقع عبر `http://` يُحوَّل تلقائياً إلى `https://` (certbot).
- [ ] `docker compose ps` تُظهر `healthy`، و`pm2 status` تُظهر `online`.
- [ ] `sudo ufw status` تُظهر `3306 DENY` و`Nginx Full ALLOW`.
- [ ] `pnpm db:backup` يُنتج ملفاً > 2KB في `backups/`، ومهمّة cron الأسبوعية مُسجَّلة (`crontab -l`).
- [ ] أُجريت نسخة خارجية يدوية أولى وحُفِظت بعيداً عن الخادم.
- [ ] بعد `sudo reboot`: التطبيق + القاعدة يعودان تلقائياً (PM2 startup + compose restart policy).
- [ ] الفرع الثاني يفتح التطبيق من المتصفّح ويسجّل دخول مستخدمه (يرى فرعه فقط).
- [ ] غُيّرت `JWT_SECRET` و`ADMIN_PASSWORD` و`DB_ROOT_PW` عن القيم الافتراضية.

## ٩. ملاحظات أمنية موجزة (مضمّنة في الكود — للتذكير)

- الكوكي: `httpOnly + sameSite:strict + secure` (على HTTPS) — `server/cookies.ts`.
- خلف البروكسي: `app.set("trust proxy", 1)` مضبوط — `server/index.ts`؛ لذا تمرير `X-Forwarded-*` إلزامي.
- دفاعات مفعّلة: helmet/CSP، فحص Origin (CSRF)، حدّ معدّل عام + حدّ أشدّ للدخول، قفل الحساب بعد محاولات فاشلة.
- لا تفتح 3306 للإنترنت إطلاقاً؛ القاعدة المركزية تُصان على `localhost` خلف جدار النار.
