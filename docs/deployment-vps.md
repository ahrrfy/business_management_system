# دليل النشر السحابي على VPS — قاعدة مركزية واحدة للفرعين

> هذا الدليل خاصّ بنموذج التشغيل المعتمد: **خادم VPS واحد على السحابة، قاعدة بيانات مركزية واحدة
> تخدم كل الفروع، والوصول عبر المتصفّح بـHTTPS**. للنشر المحلّي على Windows راجع `docs/redeploy.md`
> وللتعافي راجع `docs/disaster-recovery.md`.

## ١. النموذج — لماذا هو أبسط مما يبدو

- **خادم واحد، قاعدة واحدة، مصدر حقيقة واحد.** كل البيانات (مبيعات، مخزون، ذمم، ورديات) على VPS واحد.
- **الفرعان = عميلان في المتصفّح.** الفرع الثاني لا يحتاج خادماً ولا قاعدة ولا VPN ولا مزامنة — يفتح
  `https://erp.<نطاقك>` في المتصفّح فقط. عزل الفروع (branchId) وصلاحيات الأدوار مفروضة في الخادم أصلاً،
  فيرى كلّ كاشير فرعه فقط (إلّا المدير/الأدمن). هذا يحقّق «قاعدة مركزية للكل» تلقائياً بلا تعقيد.
- **القاعدة لا تُكشف للإنترنت.** الحجب الفعلي هو ربط حاوية MySQL على الحلقة المحلية (`127.0.0.1:${DB_PORT}` في compose) — التطبيق وحده يصلها محلياً. (جدار النار طبقة إضافية حيث يمكن تفعيله — انظر §٥.)

## ٢. المتطلّبات

| البند | التوصية |
|---|---|
| VPS | Ubuntu 22.04/24.04 LTS · ٢ vCPU · ٤ GB RAM · ٤٠ GB SSD (كافٍ لمتجر؛ زِد RAM للقاعدة عند نمو البيانات) |
| نطاق | `erp.<نطاقك>` يشير (A record) إلى IP الخادم — لازم لـHTTPS |
| البرمجيات | Node.js 20+ · pnpm 9+ · Docker + compose · nginx · certbot · ufw |

> ⚠️ **خادم مشترك؟ اجرد أولاً ولا ترقِّ أعمى.** `apt -y upgrade` الشامل قد يعيد تشغيل خدمات
> أنظمة أخرى، وسكربت get.docker.com **يرقّي** Docker إن كان مثبّتاً ⇒ إعادة تشغيل dockerd تُسقط
> كل حاويات الخادم. ثبّت **الناقص فقط** (افحص بـ`command -v`)، واترك تحديث النظام لنافذة صيانة.

```bash
# 0) جرد للقراءة أولاً: ماذا يعمل على الخادم؟ (لا تغيير قبل فهم الخريطة)
ss -tlnp ; docker ps ; ls /etc/nginx/sites-enabled/ ; systemctl list-units --type=service --state=running

# 1) مستخدم النشر غير الجذري (PM2 معزول تحته بدايمون مستقل — لا يلمس عمليات غيره)
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy        # ExecStartPre يستدعي docker inspect بهوية deploy

# 2) ثبّت الناقص فقط (تخطَّ كل ما هو موجود):
command -v node    || (curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt -y install nodejs)
command -v pnpm    || sudo npm i -g pnpm
command -v pm2     || sudo npm i -g pm2
command -v nginx   || sudo apt -y install nginx
command -v certbot || sudo apt -y install certbot python3-certbot-nginx
command -v docker  || (curl -fsSL https://get.docker.com | sh)   # فقط إن لم يوجد إطلاقاً
command -v gpg     || sudo apt -y install gnupg
```

## ٣. النشر — خطوة بخطوة

```bash
# 1) المستودع
git clone <REPO_URL> erp && cd erp
pnpm install

# 2) البيئة (إنتاج)
cp .env.production.example .env    # قالب الإنتاج الجاهز، ثم: chmod 600 .env
```

حرّر `.env` بقيم الإنتاج (الحدّ الأدنى الإلزامي):

| المتغيّر | قيمة الإنتاج | ملاحظة |
|---|---|---|
| `NODE_ENV` | `production` | يُفعّل CSP المُحكَم ويُخفّف ضوضاء السجلّ |
| `HOST` | `127.0.0.1` | خلف nginx: لا يُكشف منفذ التطبيق للإنترنت إطلاقاً (للمتجر المحلي/LAN اتركه فارغاً) |
| `PORT` | `3000` | يستمع داخلياً؛ nginx يُمرّر إليه |
| `DATABASE_URL` | `mysql://root:<قوية>@127.0.0.1:3307/erp` | **القاعدة المركزية** على نفس الخادم — منفذ مميّز `DB_PORT=3307` (خادم مشترك: لا تصادم) |
| `DB_ROOT_PW` / `DB_NAME` / `DB_CONTAINER` | `<قوية>` / `erp` / `erp-mysql` | تُستعمل في النسخ الاحتياطي + compose |
| `JWT_SECRET` | `openssl rand -hex 32` | **بدّله؛ لا تترك القيمة الافتراضية أبداً** |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | بريدك / كلمة قويّة | يُنشئ أوّل مدير عند البذرة |
| `ALLOWED_ORIGINS` | **اتركه فارغاً** | التطبيق أحادي الأصل (نفس النطاق) فلا يحتاج CORS. املأه فقط لو فصلت الواجهة على نطاق آخر |
| `BACKUP_KEEP_DAILY/WEEKLY/MONTHLY` | `7` / `4` / `3` | سياسة تدوير النسخ الليلية (احتفاظ متدرّج) |

```bash
# 3) القاعدة المركزية (تخزين دائم عبر docker-compose)
docker compose up -d
docker compose ps                 # انتظر "healthy"

# 4) المخطط + بذرة الإنتاج (مدير + فرعان + فئات أساس — بلا عيّنات)
ALLOW_BARE_PUSH=1 pnpm db:push   # أوّل مرة فقط (قاعدة فارغة) — التحديثات اللاحقة عبر بوّابة الهجرة (§٧)
pnpm seed:prod                   # يرفض ADMIN_PASSWORD ضعيفة/افتراضية/قيمة القالب

# 5) البناء + تشغيل تلقائي عند الإقلاع (PM2 تحت deploy + systemd) — كل أوامر pm2 كمستخدم deploy
pnpm check && pnpm build
pm2 start ecosystem.config.cjs
pm2 install pm2-logrotate                          # تدوير سجلات التطبيق (logs/erp-*.log) — لا نموّ بلا حدّ
pm2 set pm2-logrotate:max_size 10M && pm2 set pm2-logrotate:retain 14
pm2 save
pm2 startup systemd -u deploy --hp /home/deploy    # نفّذ سطر sudo الذي يطبعه ⇒ وحدة pm2-deploy.service

# 6) درع ترتيب الإقلاع (G10): لا يقلع التطبيق قبل صحّة قاعدة MySQL — وإلا سباق إقلاع بعد كل انقطاع
sudo mkdir -p /etc/systemd/system/pm2-deploy.service.d
sudo cp deploy/systemd/pm2-deploy.service.d/wait-mysql.conf /etc/systemd/system/pm2-deploy.service.d/
chmod +x deploy/wait-mysql-healthy.sh              # دفاع ثانٍ (الـdrop-in يستدعيه عبر /bin/bash أصلاً)
sudo systemctl daemon-reload
systemctl cat pm2-deploy.service | grep -A2 wait-mysql   # تحقّق: الدرع ظاهر في الوحدة
```

> ⚠️ لا تنفّذ `pm2 startup`/`pm2 save` كـroot على خادم مشترك: إن وُجد دايمون PM2 جذري لنظام آخر
> فإن `pm2 save` يكتب فوق قائمة إحيائه ويُسقط تطبيق غيرك من الإقلاع. دايموننا معزول تحت deploy.

## ٤. nginx + HTTPS (إلزامي)

> الكوكي الأمني (`secure`) لا يُرسَل إلّا على HTTPS، والخادم يكتشف HTTPS عبر `X-Forwarded-Proto`
> (لأنّ `trust proxy` مُفعَّل). لذا **يجب** تمرير هذه الترويسة وإلّا فشل تسجيل الدخول.
>
> قالب جاهز مُلتزَم في **`deploy/nginx-erp.conf`** (مضبوط لمضيف Hostinger مع `/healthz` وHSTS عبر
> `certbot --nginx --hsts`). على خادم مشترك: ملف موقع **جديد** + `nginx -t` ثم **reload لا restart**.
>
> **طبقة حدود المعدّل + Cloudflare (٢٠/٧):** القالب صار يتضمّن `limit_req`/`limit_conn`
> (الأنطقة في `deploy/nginx-ratelimit.conf` ← conf.d) واسترجاع الـIP الحقيقي خلف Cloudflare
> (`deploy/nginx-cloudflare-realip.conf` ← snippets) — **ثبّتهما قبل القالب** وإلا فشل
> `nginx -t` على include. دليل التفعيل الكامل (DNS + لوحة CF + التحقق): **`docs/cloudflare-plan.md`**.

```bash
# 0) تحقّق أولاً أن لا موقع قائماً يخدم اسم مضيفنا (لوحات الاستضافة تجهّز vhost افتراضياً أحياناً):
grep -rn "srv1548487.hstgr.cloud" /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ || echo "الاسم حرّ ✓"

# 1) ثبّت القالب الملتزَم (عدّل server_name فيه إن استعملت نطاقاً خاصاً):
sudo cp deploy/nginx-erp.conf /etc/nginx/sites-available/alroya-erp
sudo ln -s /etc/nginx/sites-available/alroya-erp /etc/nginx/sites-enabled/alroya-erp
sudo nginx -t && sudo systemctl reload nginx     # reload لا restart — لا نقطع مواقع الخادم الأخرى

# 2) شهادة TLS + تحويل 80→443 + HSTS (G9 — لا يتحقق بدون --hsts):
sudo certbot --nginx --hsts -d srv1548487.hstgr.cloud

# 3) تحقّق من مؤقّت التجديد التلقائي (G15) — شهادة لا تتجدّد = موقع يسقط بعد ٩٠ يوماً:
systemctl list-timers | grep certbot
```

## ٥. جدار النار (ufw) — احجب القاعدة عن الإنترنت

> ⛔ **اقرأ قبل أي أمر — على خادم مشترك لا تنفّذ هذه الكتلة:** `ufw enable` يفرض default-deny
> فيحجب فوراً كل منفذ لم تسمح به — أي إسقاط أنظمة الخادم الأخرى (Odoo على 8069، تطبيقات أخرى…)
> عن مستخدميها. لا تُفعّل ufw إلا على **خادم مخصّص لنا وحدنا**، أو بعد جردٍ كاملٍ لمنافذ كل
> الأنظمة والسماح لها صراحةً وبموافقة المالك.
>
> ⚠️ **علّة Docker+UFW:** حتى مع ufw، نشرُ منفذ Docker على كل الواجهات **يثقبه** — `ufw deny` لا
> يحجب منافذ Docker المنشورة. **الحجب الحقيقي للقاعدة هو ربط الحلقة المحلية في compose**
> (`"127.0.0.1:${DB_PORT}:3306"` — مُطبَّق عندنا)، وهو لا يحتاج ufw أصلاً. تحقّق منه:
> `ss -tlnp | grep ${DB_PORT:-3307}` ⇒ يجب أن يُظهر `127.0.0.1:3307` لا `0.0.0.0`.

```bash
# (خادم مخصّص فقط — انظر التحذير أعلاه)
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'      # 80 + 443
sudo ufw deny ${DB_PORT:-3307}   # طبقة إضافية فوق ربط الحلقة المحلية (المنفذ الفعلي من .env)
sudo ufw enable
sudo ufw status
```

## ٦. النسخ الاحتياطي — ليلي على الخادم + نسخة خارجية مشفّرة

النموذج المعتمد: **نسخة ليلية تلقائية** (`backup.mjs`: بثّ mysqldump متّسق `--single-transaction` إلى
ملف — يصمد لأي حجم — + تدوير 7/4/3 + ملف مرافق مشفّر `.sql.gpg` عند ضبط `BACKUP_GPG_PASSPHRASE`)،
و**سحب خارجي للملف المشفّر** (من جهاز المتجر). binlog باحتفاظ ٣ أيام يسدّ الفجوة بين النسخ
(استعادة نقطة-زمنية). كرون أسبوعي = خطر فقد ٧ أيام مبيعات — لذلك ليلي.

```bash
# جدولة ليلية (٢:٠٠ ص بغداد = ٢٣:٠٠ UTC — لا نغيّر توقيت خادمٍ مشترك) عبر cron
crontab -e
# أضِف السطر (عدّل المسار):
0 23 * * *  cd /home/deploy/erp && /usr/bin/pnpm db:backup >> /home/deploy/erp/logs/backup.log 2>&1
```

```powershell
# السحب الخارجي (من جهاز المتجر، يومياً): سكربت جاهز يسأل ssh عن أحدث ملف ثم ينسخه بالاسم
# الصريح (scp الحديث/SFTP لا ينفّذ $() على الطرف البعيد) + يفحص طزاجته + يدوّر محلياً:
pnpm backup:pull-vps
# الجدولة اليومية (مرة واحدة، كمدير): انظر رأس scripts/pull-vps-backup.ps1 (schtasks جاهز)
```
```bash
# فكّ التشفير عند الحاجة (يطلب BACKUP_GPG_PASSPHRASE):
gpg -d -o erp-restore.sql erp-2026-06-10T23-00-00.sql.gpg
```

```powershell
# المراقبة المحلية اليومية (جهاز المتجر): فحص حيوية الموقع (/healthz) + طزاجة أحدث نسخة
# مسحوبة (<26 ساعة — يلتقط عطل النسخ الليلي على الخادم *أو* عطل السحب المحلي، كلاهما
# يجعل أحدث ملف محلي قديماً). فشل أي فحص = إشعار toast + سطر FAIL في health-check.log:
pnpm health:check
# الجدولة: الفحص = الإجراء [١] داخل مهمة السحب نفسها (يعمل بعد السحب مباشرةً) لا مهمة
# مستقلّة — انظر رأس scripts/pull-vps-backup.ps1 لأمر Register-ScheduledTask الجامع.
```

> ⚠️ **مهمة واحدة بإجراءين — لا مهمّتان متسابقتان:** اجعل السحب (الإجراء ٠) والفحص (الإجراء ١)
> **إجراءين متتاليين في مهمة schtasks واحدة**، لا مهمّتين على مؤقّتين منفصلين. حين يكون الجهاز
> نائماً وقت الجدولة تنطلق تشغيلتا التعويض (StartWhenAvailable) في اللحظة نفسها عند الإيقاظ،
> فيقرأ الفحص مجلّد النسخ **قبل** أن يُتمّ السحب التنزيل ⇒ إشعار «النسخة قديمة» كاذب (أُثبت
> ١٥/٧/٢٦). المهمة الواحدة بإجراءين تشغّلهما بالتسلسل (كلٌّ في عمليّته) ⇒ يزول السباق بنيوياً.
>
> ⚠️ **إعدادات schtasks الافتراضية تخذلك صامتةً:** «لا تشغيل على البطارية» + عدم تعويض التشغيلات
> الفائتة أوقفا السحب اليومي ٣ أيام كاملة (٣–٦/٧/٢٦، Last Result `0x800710E0`) دون أن يلحظه أحد.
> عالِجها بـ`StartWhenAvailable=true` + `DisallowStartIfOnBatteries=false` + **`WakeToRun=true`**
> (يوقظ الجهاز من النوم فيتمّ السحب في ٧:٣٠ لا متأخّراً ساعات) — كلّها مخبوزة في أمر
> Register-ScheduledTask بالرأس؛ طبّقها على أي مهمة مجدولة جديدة.

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
pnpm db:backup && pnpm db:migrate:safe   # بوّابة الهجرة: ترفض تطبيق المخطّط بلا نسخة طازجة (<١٠د)
pnpm check && pnpm build
pm2 reload erp-server  # إعادة تحميل بلا انقطاع تقريباً
```

## ٨. قائمة تحقّق ما بعد النشر

- [ ] `https://erp.<نطاقك>` يفتح بقفل TLS صحيح ويقبل تسجيل الدخول (الكوكي secure يعمل ⇒ X-Forwarded-Proto مضبوط).
- [ ] فتح الموقع عبر `http://` يُحوَّل تلقائياً إلى `https://` (certbot).
- [ ] `docker compose ps` تُظهر `healthy`، و`pm2 status` تُظهر `online`.
- [ ] `ss -tlnp | grep 3307` يُظهر `127.0.0.1:3307` فقط (لا `0.0.0.0`) — القاعدة محجوبة بالربط المحلي. (بند ufw فقط على خادم مخصّص.)
- [ ] `systemctl cat pm2-deploy.service | grep wait-mysql` يُظهر درع ترتيب الإقلاع (G10) مثبَّتاً.
- [ ] `pnpm db:backup` يُنتج ملفاً > 2KB في `backups/` (+ مرافق `.sql.gpg` إن ضُبط التشفير)، ومهمّة cron الليلية مُسجَّلة (`crontab -l`).
- [ ] أُجريت نسخة خارجية أولى (`pnpm backup:pull-vps` من جهاز المتجر) **وفُكَّ تشفيرها هناك بنجاح** بالعبارة المحفوظة خارج الخادم — عبارة خاطئة تُكتشف اليوم لا يوم الكارثة.
- [ ] اختبار التعافي: `docker restart erp-mysql` ثم `pm2 restart erp-server` ثم قتل العملية (`pm2 pid` + `kill`) ⇒ كلّها تعود تلقائياً و`/healthz` يردّ 200. (⚠️ `sudo reboot` يُسقط كل أنظمة الخادم المشترك — فقط في نافذة صيانة يقرّها المالك؛ عندها يثبت الإقلاع الكامل.)
- [ ] الفرع الثاني يفتح التطبيق من المتصفّح ويسجّل دخول مستخدمه (يرى فرعه فقط).
- [ ] غُيّرت `JWT_SECRET` و`ADMIN_PASSWORD` و`DB_ROOT_PW` عن القيم الافتراضية.

## ٩. ملاحظات أمنية موجزة (مضمّنة في الكود — للتذكير)

- الكوكي: `httpOnly + sameSite:strict + secure` (على HTTPS) — `server/cookies.ts`.
- خلف البروكسي: `app.set("trust proxy", 1)` مضبوط — `server/index.ts`؛ لذا تمرير `X-Forwarded-*` إلزامي.
- دفاعات مفعّلة: helmet/CSP، فحص Origin (CSRF)، حدّ معدّل عام + حدّ أشدّ للدخول، قفل الحساب بعد محاولات فاشلة.
- لا تفتح 3306 للإنترنت إطلاقاً؛ القاعدة المركزية تُصان على `localhost` خلف جدار النار.

## ١٠. تعدّد الشركات (اختياري — معطَّل افتراضياً)

هذا النشر (قاعدة واحدة `erp` على 3307) يبقى **بلا أي تغيير سلوكي** ما لم تُفعِّل هذا القسم عمداً.
لدعم شركات شقيقة بعزل قاعدة MySQL فعلي (لا مجرّد عمود مشترك) على نفس خادم MySQL الحالي:

```bash
# في .env الإنتاج: اضبط القيمتين التاليتين (راجع .env.production.example للتفصيل)
CONTROL_DATABASE_URL=mysql://root:<كلمة-مرور-القاعدة>@127.0.0.1:3307/erp_control
INTEGRATIONS_ENCRYPTION_KEY=$(openssl rand -hex 32)

pnpm control:bootstrap                     # مرّة واحدة: يُنشئ مخطّط erp_control
pnpm company:new <رمز> "<اسم الشركة>" \
  --admin-email admin@company.example --admin-password '<قوية>'   # لكل شركة: قاعدة+مستخدم DB مخصّص+seed
pnpm platform-admin:new                    # حساب تشغيلي واحد يدير الشركات عبر /platform-admin
```

لا حاجة لتعديل كود إضافي — أسطح `/api/trpc` و`/api/print` و`/api/backups` و`/api/webhooks/company/:code`
جاهزة لعزل الشركات فور ضبط `CONTROL_DATABASE_URL`. الاستثناء المتعمَّد: استعادة/تصفير القاعدة من
داخل واجهة النظام تبقى معطَّلة لأي شركة في هذا الوضع (مرّ عبر `pnpm db:backup:all-companies` +
استعادة يدوية موجَّهة بدلاً منها). التفصيل الكامل: ذاكرة `multi-company-tenancy-2026-07-01`.
