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

| البند     | التوصية                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------- |
| VPS       | Ubuntu 22.04/24.04 LTS · ٢ vCPU · ٤ GB RAM · ٤٠ GB SSD (كافٍ لمتجر؛ زِد RAM للقاعدة عند نمو البيانات) |
| نطاق      | `erp.<نطاقك>` يشير (A record) إلى IP الخادم — لازم لـHTTPS                                            |
| البرمجيات | Node.js 20+ · pnpm 9+ · Docker + compose · nginx · certbot · ufw                                      |

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
sudo npm install -g pm2@7.0.3                         # ثبّت النسخة المعتمدة حتى لو وُجد إصدار آخر؛ prod:deploy يرفض غيرها
sudo -iu deploy pm2 update                            # يحدّث daemon الموجود في الذاكرة؛ تثبيت npm وحده لا يفعل ذلك
command -v nginx   || sudo apt -y install nginx
command -v certbot || sudo apt -y install certbot python3-certbot-nginx
command -v docker  || (curl -fsSL https://get.docker.com | sh)   # فقط إن لم يوجد إطلاقاً
command -v gpg     || sudo apt -y install gnupg
```

## ٣. النشر — خطوة بخطوة

```bash
# 1) المستودع — كل أوامر repo/pnpm/pm2 بهوية deploy حصراً
sudo -iu deploy bash
cd /home/deploy
git clone <REPO_URL> erp
cd /home/deploy/erp
pnpm install --frozen-lockfile

# 2) البيئة (إنتاج)
cp /home/deploy/erp/.env.production.example /home/deploy/erp/.env
chmod 600 /home/deploy/erp/.env    # إلزامي: لا تترك أسرار الإنتاج مقروءة لغير deploy
```

حرّر `.env` بقيم الإنتاج (الحدّ الأدنى الإلزامي):

| المتغيّر                                  | قيمة الإنتاج                                | ملاحظة                                                                                                         |
| ----------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                | `production`                                | يُفعّل CSP المُحكَم ويُخفّف ضوضاء السجلّ                                                                       |
| `HOST`                                    | `127.0.0.1`                                 | إلزامي في الإنتاج؛ خلف nginx لا يُكشف منفذ التطبيق للإنترنت إطلاقاً                                            |
| `ALLOW_PUBLIC_BIND`                       | `0`                                         | ارفعه إلى `1` فقط إذا كان `HOST` العام/LAN مقصوداً ومعه جدار ناري؛ وإلا يفشل الإقلاع مغلقاً                    |
| `PORT`                                    | `3000`                                      | يستمع داخلياً؛ nginx يُمرّر إليه                                                                               |
| `INTERNAL_PROXY_SECRET`                   | `openssl rand -hex 32`                      | يطابق قيمة ملف nginx المحمي `/etc/nginx/snippets/alroya-proxy-secret.conf` ويمنع تجاوز البروكسي من عملية محلية |
| `INTERNAL_PROXY_SECRET_PREVIOUS`          | فارغ عادةً                                  | نافذة تدوير مؤقتة فقط؛ إن وُجد فهو 64 hex مختلف، ويُحذف بعد `retire` الناجح                                    |
| `DATABASE_URL`                            | `mysql://erp_app:<قوية>@127.0.0.1:3307/erp` | حساب التطبيق محصور بقاعدة `erp`؛ لا تشغّل الويب بـroot                                                         |
| `DB_APP_USER` / `DB_APP_PW`               | `erp_app` / `openssl rand -hex 24`          | حساب الويب الأقل امتيازاً؛ كلمة مختلفة عن root                                                                 |
| `DB_ROOT_PW` / `DB_NAME` / `DB_CONTAINER` | `<قوية>` / `erp` / `erp-mysql`              | root للصيانة/التعافي وcompose فقط، ولا يبقى في بيئة عامل الويب                                                 |
| `JWT_SECRET`                              | `openssl rand -hex 32`                      | **بدّله؛ لا تترك القيمة الافتراضية أبداً**                                                                     |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD`          | بريدك / كلمة قويّة                          | يُنشئ أوّل مدير عند البذرة                                                                                     |
| `ALLOWED_ORIGINS`                         | **اتركه فارغاً**                            | التطبيق أحادي الأصل (نفس النطاق) فلا يحتاج CORS. املأه فقط لو فصلت الواجهة على نطاق آخر                        |
| `BACKUP_KEEP_DAILY/WEEKLY/MONTHLY`        | `7` / `4` / `3`                             | سياسة تدوير النسخ الليلية (احتفاظ متدرّج)                                                                      |

الاستعادة والتصفير عبر الويب معطّلان نهائياً في الإنتاج بلا مفتاح تجاوز. نفّذهما من CLI بعد إيقاف عمال الويب. إذا انقطعت العملية وبقي قفل الصيانة: خذ المسار الدقيق من سجل الخادم (اسم `erp-restore-*.lock` داخل مجلد النظام المؤقت)، واقرأ السطر الأول `PID:owner`. لا تحذفه حتى تتأكد أن PID غير موجود ولا توجد عملية `restore.mjs`/`reset.mjs`/`mysql` تابعة. احذف ذلك الملف المحدد فقط ثم أعد الأمر؛ لا تمسح مجلد temp ولا تستخدم wildcard.

```bash
# 3) القاعدة المركزية (تخزين دائم عبر docker-compose)
docker compose up -d
docker compose ps                 # انتظر "healthy"
pnpm db:ensure-app-user            # لازم أيضاً عند ترقية volume قديم؛ ينشئ/يدوّر حساب التطبيق المحصور

# 4) قاعدة فارغة فقط: إنشاء المخطط ثم تسجيل baseline؛ لا تستعمل هذا المسار على قاعدة قائمة
ALLOW_BARE_PUSH=1 pnpm db:push
pnpm db:migrate:extra
node scripts/baseline-migrations.mjs
pnpm db:verify
pnpm seed:prod                   # يرفض ADMIN_PASSWORD ضعيفة/افتراضية/قيمة القالب

# 5) البناء + تشغيل تلقائي عند الإقلاع (PM2 تحت deploy + systemd) — كل أوامر pm2 كمستخدم deploy
pnpm check && pnpm build
pm2 start ecosystem.config.cjs --only erp-server      # الملف الجذري لا يشغّل جسر الحضور إنتاجياً
pm2 install pm2-logrotate                          # تدوير سجلات التطبيق (logs/erp-*.log) — لا نموّ بلا حدّ
pm2 set pm2-logrotate:max_size 10M && pm2 set pm2-logrotate:retain 14
pm2 save
pnpm prod:deploy                                      # ينشئ أول إصدار immutable للجسر ويفعّله عبر البوابات
pm2 startup systemd -u deploy --hp /home/deploy    # يطبع أمر sudo؛ انسخه كاملاً ولا تنفّذه داخل جلسة deploy
exit                                                # العودة إلى جلسة root

# كـroot: الصق الآن أمر sudo الذي طبعه PM2 أعلاه ونفّذه حرفياً؛ هو الذي ينشئ pm2-deploy.service
# مثال شكلي فقط (لا تنسخه بدل الأمر الفعلي المطبوع): sudo env PATH=... pm2 startup systemd -u deploy --hp /home/deploy

# 6) كـroot: درع ترتيب الإقلاع (G10): لا يقلع التطبيق قبل صحّة قاعدة MySQL — وإلا سباق إقلاع بعد كل انقطاع
sudo mkdir -p /etc/systemd/system/pm2-deploy.service.d
sudo cp /home/deploy/erp/deploy/systemd/pm2-deploy.service.d/wait-mysql.conf /etc/systemd/system/pm2-deploy.service.d/
sudo chmod +x /home/deploy/erp/deploy/wait-mysql-healthy.sh   # دفاع ثانٍ (الـdrop-in يستدعيه عبر /bin/bash أصلاً)
# لا تنفّذ JavaScript من /home/deploy بصلاحية root. ثبّت عقد PID بالكتلة الذرية الموثقة في §٧.
# يجب أخذ القيم الثلاث من summary تشغيل CI الأخضر على push إلى main للإصدار نفسه.
# لا تحسب القيم المتوقعة من الشجرة القابلة للكتابة لـdeploy ثم تعاملها كإثبات.
systemctl cat pm2-deploy.service | grep -A2 wait-mysql   # تحقّق: الدرع ظاهر في الوحدة
systemctl show pm2-deploy.service -p ExecStart --value | grep pm2-systemd-start.mjs
```

> ⚠️ لا تنفّذ `pm2 save` كـroot، ولا تُنشئ startup لمستخدم root. الاستثناء المقصود الوحيد هو تنفيذ
> أمر `sudo ... pm2 startup systemd -u deploy --hp /home/deploy` الذي طبعه PM2؛ فهو يثبّت وحدة systemd
> المستهدفة للمستخدم `deploy`. إن وُجد دايمون PM2 جذري لنظام آخر فإن `pm2 save` كـroot يكتب فوق قائمة
> إحيائه ويُسقط تطبيق غيرك من الإقلاع. دايموننا معزول تحت deploy.
>
> **عقد PID الخاص بـType=forking:** يحذف systemd ملف `PIDFile` القديم قبل `ExecStart`. إذا كان
> daemon ‏PM2 قائماً، فإن `pm2 resurrect` يتصل به ولا يعيد إنشاء `pm2.pid`؛ كانت النتيجة
> `protocol`/وحدة `failed` مع بقاء التطبيقات سليمة لكن خارج إشراف systemd. كما يرفض systemd تبنّي
> PID خارج cgroup إذا كان PIDFile تحت ملكية `deploy`. الـdrop-in يشغّل بعلامة `+` **النسخة المثبّتة
> root:root فقط** من helper ذاتي الاكتفاء؛ فتتحقق من مساراتها وهوية deploy، ثم تُسقط PM2 إلى UID/GID
> الصحيحين عبر `setpriv --clear-groups` وبيئة ثابتة. وبعد resurrect تثبت daemon الوحيد بدلالة
> UID+PPID+عنوان العملية+وقت البدء، وتكتب `/run/erp-pm2/pm2-deploy.pid` ذرياً `root:root 0644`.
> لا يُنفّذ root أي كود من الشجرة القابلة للكتابة لـdeploy، ولا يحدث kill/restart. وعلى إقلاع نظيف
> ينشئ PM2 الـdaemon داخل cgroup الخدمة؛ وعند وجوده تتبناه الوحدة دون تغيير PID. الغموض = فشل مغلق.

## ٤. nginx + HTTPS (إلزامي)

> الكوكي الأمني (`secure`) لا يُرسَل إلّا على HTTPS، والخادم يكتشف HTTPS عبر `X-Forwarded-Proto`
> (لأنّ `trust proxy` مُفعَّل). لذا **يجب** تمرير هذه الترويسة وإلّا فشل تسجيل الدخول.
>
> قالبا المضيفين ملتزمان في **`deploy/nginx-erp.conf`** (النظام الداخلي) و
> **`deploy/nginx-public.conf`** (المتجر العام). يشتركان في عقد proxy وموقع SPA، أمّا مواقع API
> الكاملة فتبقى في المضيف الداخلي فقط؛ العام يملك قائمة سماح مستقلة وحاجب `/api/` صريحاً.
> الملفان يملكان تحويل HTTP وTLS صراحةً؛ لا يُسمح بنسخة عدّلها certbot أو المشغّل خارج المستودع.
>
> **طبقة حدود المعدّل + Cloudflare (٢٠/٧):** القالب صار يتضمّن `limit_req`/`limit_conn`
> (الأنطقة في `deploy/nginx-ratelimit.conf` ← conf.d) واسترجاع الـIP الحقيقي خلف Cloudflare
> (`deploy/nginx-cloudflare-realip.conf` ← snippets) — **ثبّتهما قبل القالب** وإلا فشل
> `nginx -t` على include. دليل التفعيل الكامل (DNS + لوحة CF + التحقق): **`docs/cloudflare-plan.md`**.

**تمهيد السر والشهادات مرة واحدة:** يجب أن توجد شهادتا Let’s Encrypt في المسارات الملتزمة في
القالبين، وأن يكون `/etc/nginx/snippets/alroya-proxy-secret.conf` ملفاً عادياً `root:root/0600`
يحوي توجيه `set` واحداً بسر **64 خانة hex** مطابق لـ`INTERNAL_PROXY_SECRET` في `.env`. أدخل السر عبر
`sudoedit`؛ لا تمرّره وسيطاً ولا تنسخ المثال الوهمي. بعد إصدار الشهادات، التجديد المسموح هو
`certbot renew`؛ لا تشغّل أمراً يعيد كتابة vhost الملتزم.

**ثبّت مُثبّت Nginx الموثوق مرة لكل إصدار تغيّرت فيه ملفاته.** لا تشغّل JavaScript من
`/home/deploy/erp` بصلاحية root. استعمل فقط SHA-256 المنشورين في summary تشغيل
`check-test-build` الأخضر على push إلى `main` للإصدار نفسه. تشمل الحزمة المثبّت والعقد والمدقق
والـmanifest الذي يثبت بصمات كل مدخل إعداد سيُنسخ إلى Nginx:

```bash
cd /home/deploy/erp
release_sha='<CI_GREEN_RELEASE_SHA>'
installer_sha256='<RELEASE_NGINX_INSTALLER_SHA256>'
contract_sha256='<RELEASE_NGINX_CONTRACT_SHA256>'
verifier_sha256='<RELEASE_NGINX_VERIFIER_SHA256>'
manifest_sha256='<RELEASE_NGINX_MANIFEST_SHA256>'
test "$(git rev-parse HEAD)" = "$release_sha"
case "$release_sha$installer_sha256$contract_sha256$verifier_sha256$manifest_sha256" in *'<'*|'') exit 1;; esac
sudo /usr/bin/install -d -o root -g root -m 0755 /usr/local/libexec/erp/nginx
installer_tmp="$(sudo /usr/bin/mktemp /usr/local/libexec/erp/nginx/.install-nginx-contract.mjs.XXXXXX)"
contract_tmp="$(sudo /usr/bin/mktemp /usr/local/libexec/erp/nginx/.nginx-contract.mjs.XXXXXX)"
verifier_tmp="$(sudo /usr/bin/mktemp /usr/local/libexec/erp/nginx/.verify-nginx-abuse-controls.mjs.XXXXXX)"
manifest_tmp="$(sudo /usr/bin/mktemp /usr/local/libexec/erp/nginx/.nginx-release-manifest.json.XXXXXX)"
trap 'sudo /usr/bin/rm -f -- "$installer_tmp" "$contract_tmp" "$verifier_tmp" "$manifest_tmp"' EXIT HUP INT TERM
sudo /usr/bin/install -o root -g root -m 0555 scripts/install-nginx-contract.mjs "$installer_tmp"
sudo /usr/bin/install -o root -g root -m 0555 scripts/nginx-contract.mjs "$contract_tmp"
sudo /usr/bin/install -o root -g root -m 0555 scripts/verify-nginx-abuse-controls.mjs "$verifier_tmp"
sudo /usr/bin/install -o root -g root -m 0444 deploy/nginx-release-manifest.json "$manifest_tmp"
printf '%s  %s\n' "$installer_sha256" "$installer_tmp" | sudo /usr/bin/sha256sum -c -
printf '%s  %s\n' "$contract_sha256" "$contract_tmp" | sudo /usr/bin/sha256sum -c -
printf '%s  %s\n' "$verifier_sha256" "$verifier_tmp" | sudo /usr/bin/sha256sum -c -
printf '%s  %s\n' "$manifest_sha256" "$manifest_tmp" | sudo /usr/bin/sha256sum -c -
sudo /usr/bin/mv -Tf -- "$manifest_tmp" /usr/local/libexec/erp/nginx/nginx-release-manifest.json
sudo /usr/bin/mv -Tf -- "$verifier_tmp" /usr/local/libexec/erp/nginx/verify-nginx-abuse-controls.mjs
sudo /usr/bin/mv -Tf -- "$contract_tmp" /usr/local/libexec/erp/nginx/nginx-contract.mjs
sudo /usr/bin/mv -Tf -- "$installer_tmp" /usr/local/libexec/erp/nginx/install-nginx-contract.mjs
trap - EXIT HUP INT TERM
test "$(stat -c '%U:%G:%a' /usr/local/libexec/erp/nginx/install-nginx-contract.mjs)" = root:root:555
test "$(stat -c '%U:%G:%a' /usr/local/libexec/erp/nginx/verify-nginx-abuse-controls.mjs)" = root:root:555
test "$(stat -c '%U:%G:%a' /usr/local/libexec/erp/nginx/nginx-release-manifest.json)" = root:root:444

# الأمر الوحيد لتثبيت أو إصلاح العقد:
sudo /usr/bin/node /usr/local/libexec/erp/nginx/install-nginx-contract.mjs install
```

هذا المُثبّت root-operated ولا يستعمل `sudo` داخلياً. ينفّذ كل عملية داخل قفل kernel حصري
`/run/erp-nginx-contract.operation.lock` عبر `/usr/bin/flock`؛ فيتحرر القفل تلقائياً عند الانقطاع
ولا توجد معالجة stale قابلة للسباق. يفحص مسبقاً الهوية، وأن مجلدات Nginx
`root:root` وغير قابلة لكتابة المجموعة/العالم، والشهادات، وملكية/وضع ملف السر ومطابقته الصامتة
مع `.env`. ويكتب attestation عامة تحوي بصمة SHA-256 وinode/ctime وmetadata فقط، كي يستطيع نشر
`deploy` إثبات بقاء السرّين متطابقين من دون صلاحية قراءة ملف السر أو طباعة قيمته، بينما يعيد
المثبّت المخوّل نفسه حساب بصمة المحتوى الفعلي. كما يفحص ناتج `nginx -T`: لكل اسم مدار كتلتان
فقط (تحويل 80 + موقع 443)، ويعيد فحص بصمة النسخ المرحلية نفسها بعد النسخ وقبل rename، ثم يشغّل
المدقق المثبّت root-owned على هذه البايتات عينها. لذلك لا يسمح تبديل ملف من checkout بين الفحص
والنسخ بتشغيل أو تركيب محتوى آخر. وأي vhost قديم/متعارض خارج الرابطين المدارين يوقف العملية ولا يُحذف
تلقائياً على الخادم المشترك. ثم يجهّز الملفات السبعة والرابطين بجوار أهدافها، ويحفظ الحالة السابقة
كاملةً في `/var/backups/alroya-nginx/<معرّف>`، ويكتب `pending.json` متيناً قبل أول تبديل، وينفذ
`nginx -t` ثم `systemctl reload nginx` ثم `/healthz` خارجياً عبر المضيفين. هذا الفحص يثبت TLS
والتوجيه وسر القفزة من دون اشتراط أن يكون كتالوج الإصدار القديم غير فارغ (فتظل معالجة المتجر
قابلة للنشر). أي فشل في النسخ أو
الاختبار أو reload أو smoke يعيد **كل** الملفات والروابط السابقة ويختبرها ويعيد تحميلها، ثم
يفحص المضيف الإداري الخارجي المستقر بوصفه بوابة صحةٍ للرجوع. لا يعيد فحص الرجوع فرض نجاح
المضيف العام إن كان متدهوراً قبل المحاولة؛ أمّا قبول العقد الجديد فيبقى صارماً ولا ينجح إلا بعد
اجتياز المضيفين معاً. وإن
انقطعت العملية أو الكهرباء بين التبديلات، فالتشغيل الجذري التالي يستعيد journal بصورة idempotent
قبل أي تثبيت جديد. فشل الرجوع يخرج بالرمز 2 ويُبقي النسخة وjournal للتدخل. لا تُنسخ قيمة السر
إلى النسخة ولا تُطبع في السجل.

### تدوير سرّ القفزة بلا نافذة 403

المُثبّت يولّد السر الجديد داخلياً ولا يضعه في argv أو stdout. يحتفظ أثناء العملية فقط بالقديم
والجديد والـjournal داخل `/var/lib/alroya-nginx/rotation-active` بوضع `0700/0600`، ولا ينسخ `.env`
ولا بقية أسرار النظام. هذه الحالة persistent فتُستأنف بعد reboot، ويُنظّف المجلد بصورة resumable
ومؤكدة بعد نجاح retire أو rollback. قبل أي تغيير في `prepare` و`switch`
و`retire` و`rollback` يرسل فحص `/healthz` خارجي بعلامة غير حساسة وBearer اصطناعي، ثم يقرأ فقط
الإضافة الجديدة إلى `logs/erp-out.log`: تبدل inode أو غياب العلامة أو ظهور السر/Bearer يوقف التدوير
بلا طباعة أي قيمة. نفّذ المراحل بالترتيب؛ بعد كل `prod:deploy`
يختبر helper الأصل مباشرةً، ومرحلة `switch` تختبر أيضاً المسار الخارجي عبر Nginx:

```bash
helper=/usr/local/libexec/erp/nginx/install-nginx-contract.mjs

# 1) prime: القرص old/current + new/previous؛ Nginx يبقى old.
sudo /usr/bin/node "$helper" prepare
sudo -iu deploy bash -lc 'cd /home/deploy/erp && pnpm prod:deploy'

# 2) switch: يثبت قبول old+new، ثم يجعل القرص new/current + old/previous
# ويبدّل Nginx إلى new ذرياً مع nginx -t/reload/smoke.
sudo /usr/bin/node "$helper" switch
sudo -iu deploy bash -lc 'cd /home/deploy/erp && pnpm prod:deploy'

# 3) retire: النداء الأول يحذف previous من .env؛ النشر يحمّل steady state؛
# النداء الثاني يثبت current=200 وold=403 ثم يمحو journal.
sudo /usr/bin/node "$helper" retire
sudo -iu deploy bash -lc 'cd /home/deploy/erp && pnpm prod:deploy'
sudo /usr/bin/node "$helper" retire
```

للرجوع من أي مرحلة: نفّذ `rollback` ثم `prod:deploy` ثم كررهما مرةً ثانية، وبعدها نداء
`rollback` أخير للتأكيد. النداء الأول يعيد نافذة القبول المزدوج بحسب سر Nginx الحي، والثاني
يعيد Nginx و`.env` إلى القديم، والثالث لا يمحو journal إلا بعد canary يثبت القديم ويرفض الجديد.
إعادة أي نداء بعد انقطاع آمنة؛ لا تعدّل `.env` أو ملف السر يدوياً أثناء وجود journal.

```bash
# شهادة لا تتجدد = موقع يسقط بعد 90 يوماً:
systemctl list-timers | grep certbot

# تحقق قراءة فقط بعد الإصلاح؛ لا يحتاج root ولا يطبع السر:
cd /home/deploy/erp && node scripts/nginx-contract.mjs --live
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
pm2 stop erp-server
pnpm db:restore backups/<ملف-النسخة>.sql --confirm RESTORE
pm2 start erp-server
pnpm db:verify
```

نفّذ **اختبار استعادة ربع سنوي** (DR §٣) — نسخة لا تُختبَر = نسخة وهمية.

## ٧. التحديثات اللاحقة (نشر إصدار جديد) — `pnpm prod:deploy`

**الطريقة المعتمدة: أمر نشر مُدار واحد** (`scripts/deploy.mjs`). بعد دمج التغييرات على `main` وخُضرة CI، شغّله بهوية `deploy` نفسها التي تملك `pm2-deploy.service`:

```bash
ssh root@<الخادم>
sudo -iu deploy bash -lc 'cd /home/deploy/erp && pnpm prod:deploy'
```

> **PM2 خاص بكل مستخدم.** السكربت يرفض `root` أو `HOME/PM2_HOME` غير المطابق لـ`deploy`، كي لا يُنشئ daemon ثانياً يبدو فارغاً أو ينازع الخدمة الحقيقية على المنفذ.

**مرة واحدة بعد إدخال عقد PID أعلاه أو عند تغيّر helper/drop-in:** بعد نجاح `prod:deploy` ثبّت
الملفين في مسارين root-owned. ⛔ لا تشغّل `sudo node /home/deploy/erp/...`؛ فهذا يحوّل تعديل
ملفات deploy إلى تنفيذ root. مصدر النسخ قابل للكتابة لـdeploy، لذلك لا يكفي `install source final`:
ثبّت أولاً في ملف مؤقت root-owned على filesystem الهدف، قارنه بقيمة SHA-256 المنشورة في
summary وظيفة `check-test-build` الخضراء على **push إلى main** للإصدار نفسه، ثم استخدم `mv -T`
الذري. لا تأخذ القيم من تشغيل PR ذي merge ref ولا من checkout الخادم. هذه الأوامر لا تستدعي
start/stop/restart:

```bash
cd /home/deploy/erp
release_sha='<CI_GREEN_RELEASE_SHA>'
helper_sha256='<RELEASE_PM2_HELPER_SHA256>'
dropin_sha256='<RELEASE_PM2_DROPIN_SHA256>'
test "$(git rev-parse HEAD)" = "$release_sha"
case "$release_sha$helper_sha256$dropin_sha256" in *'<'*|'') echo 'release hashes are not pinned' >&2; exit 1;; esac

sudo /usr/bin/install -d -o root -g root -m 0755 /usr/local/libexec/erp
sudo /usr/bin/install -d -o root -g root -m 0755 /etc/systemd/system/pm2-deploy.service.d
sudo /usr/bin/install -d -o root -g root -m 0700 /var/backups/erp-systemd
backup_dir="$(sudo /usr/bin/mktemp -d "/var/backups/erp-systemd/${release_sha}.XXXXXX")"
if sudo test -e /usr/local/libexec/erp/pm2-systemd-start.mjs; then
  sudo /usr/bin/cp -a /usr/local/libexec/erp/pm2-systemd-start.mjs "$backup_dir/helper.previous"
else
  sudo /usr/bin/touch "$backup_dir/helper.absent"
fi
if sudo test -e /etc/systemd/system/pm2-deploy.service.d/20-pidfile-reconcile.conf; then
  sudo /usr/bin/cp -a /etc/systemd/system/pm2-deploy.service.d/20-pidfile-reconcile.conf "$backup_dir/dropin.previous"
else
  sudo /usr/bin/touch "$backup_dir/dropin.absent"
fi

helper_tmp="$(sudo /usr/bin/mktemp /usr/local/libexec/erp/.pm2-systemd-start.mjs.XXXXXX)"
dropin_tmp="$(sudo /usr/bin/mktemp /etc/systemd/system/pm2-deploy.service.d/.20-pidfile-reconcile.conf.XXXXXX)"
cleanup_pm2_contract_tmp() { sudo /usr/bin/rm -f -- "$helper_tmp" "$dropin_tmp"; }
trap cleanup_pm2_contract_tmp EXIT HUP INT TERM
sudo /usr/bin/install -o root -g root -m 0755 deploy/systemd/pm2-systemd-start.mjs "$helper_tmp"
sudo /usr/bin/install -o root -g root -m 0644 deploy/systemd/pm2-deploy.service.d/20-pidfile-reconcile.conf "$dropin_tmp"
printf '%s  %s\n' "$helper_sha256" "$helper_tmp" | sudo /usr/bin/sha256sum -c -
printf '%s  %s\n' "$dropin_sha256" "$dropin_tmp" | sudo /usr/bin/sha256sum -c -
sudo /usr/bin/mv -Tf -- "$helper_tmp" /usr/local/libexec/erp/pm2-systemd-start.mjs
sudo /usr/bin/mv -Tf -- "$dropin_tmp" /etc/systemd/system/pm2-deploy.service.d/20-pidfile-reconcile.conf
trap - EXIT HUP INT TERM
sudo /usr/bin/systemctl daemon-reload
sudo /usr/bin/systemd-analyze verify pm2-deploy.service
test "$(stat -c '%U:%G:%a' /usr/local/libexec/erp/pm2-systemd-start.mjs)" = root:root:755
test "$(stat -c '%U:%G:%a' /etc/systemd/system/pm2-deploy.service.d/20-pidfile-reconcile.conf)" = root:root:644

# إن كان daemon يعمل والوحدة failed/inactive: inspect الموثوق يقرأ /proc فقط ولا ينشئ daemon.
before="$(sudo /usr/bin/node /usr/local/libexec/erp/pm2-systemd-start.mjs --inspect)"
before_pid="${before%% *}"
before_start="${before#* }"
sudo systemctl start pm2-deploy.service
after="$(systemctl show pm2-deploy.service -p MainPID --value)"
test "$before_pid" = "$after"
after_stat="$(cat "/proc/$after/stat")"
after_tail="${after_stat##*) }"
read -r -a after_fields <<< "$after_tail"
test "$before_start" = "${after_fields[19]}"
systemctl is-active --quiet pm2-deploy.service
test "$(stat -c '%U:%G:%a' /run/erp-pm2/pm2-deploy.pid)" = root:root:644
sudo -iu deploy pm2 status
```

كل محاولة تنشئ `$backup_dir` جديداً بـ`mktemp -d` ولا تعيد استعمال backup سابقاً. إذا فشل
`systemd-analyze verify` أو أي تحقق **قبل** `systemctl start`، أعد النسختين السابقتين ذرياً من
ذلك المسار الفريد (أو احذف الهدف الذي يحمل marker ‏`*.absent`)، ثم نفّذ
`systemctl daemon-reload` و`systemd-analyze verify` مجدداً. لا تنفّذ rollback بعد نجاح
`start` وثبات PID إلا إذا ثبت انحراف العقد؛ فالعملية الحية لم تُقتل أو تُستبدل أصلاً.

⛔ لا تستعمل `systemctl restart/stop` ولا `pm2 kill/update` لهذا الإصلاح؛ تلك الأوامر تغيّر
العمليات الحيّة بينما المطلوب تبنّي الـdaemon القائم فقط. عند الإقلاع النظيف لا يوجد `before`
وتبدأ الوحدة تلقائياً بالمسار نفسه من `WantedBy=multi-user.target`.

قبل أي خطوة متحوّلة، يرفض السكربت الفرع غير `main` أو الشجرة غير النظيفة، يجلب `origin/main` بـfast-forward، ثم **يعيد تشغيل نفسه من الكود المسحوب** إن تغيّر SHA. كما يثبت أن CLI وحزمة وdaemon ‏PM2 كلها `7.0.3`؛ تثبيت npm وحده لا يكفي من دون `pm2 update`.

بعد ذلك ينفّذ **١٢ مرحلة (٠–١١)** تحت قفل نشر حصري. إذا وجد journal من نشر انقطع، يعيد أولاً آخر إصدار ملتزم ويتحقق منه ويحفظه قبل بدء نشر جديد. `prod:deploy` يعمل بهوية `deploy` ولا يستدعي `sudo`: إن كان Nginx الحي منحرفاً يتوقف قبل install/build/DB بالرمز `NGINX_LIVE_CONTRACT_DRIFT` ويطلب أمر الإصلاح الجذري أعلاه:

| #   | الخطوة                     | الأمر الفعليّ                                                                                    | الغاية                                                                                                    |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| ٠   | مطابقة Nginx الحي          | `node scripts/nginx-contract.mjs --live`                                                         | يثبت الملفات والرابطين وبصمة/هوية السر وغياب تغيّر طوبولوجيا `nginx -T` المصدّقة؛ لا يصلح بصلاحيات ملتوية |
| ١   | تركيب الاعتماديات          | `pnpm install --frozen-lockfile`                                                                 | يطابق `pnpm-lock.yaml` بالضبط                                                                             |
| ٢   | بناء مرشح معزول وعقد Nginx | worktree عند SHA المسحوب داخل `.runtime/web-candidates` + `pnpm build` + الفاحص الساكن           | لا يكتب في `dist` الحي أثناء البناء؛ فشل البناء يترك الخادم والعميل السابقين byte-for-byte                |
| ٣   | preflight قبل DB           | bootstrap الإصدار immutable                                                                      | يفشل مبكراً قبل النسخ والهجرات؛ ويقبل `disabled` كحالة مقصودة                                             |
| ٤   | نسخة احتياطية              | `pnpm db:backup`                                                                                 | قبل أي تغيير مخطّط                                                                                        |
| ٥   | الهجرات                    | `pnpm db:migrate:safe`                                                                           | هجرات مولّدة وآمنة فقط؛ لا `db:push` عارياً                                                               |
| ٦   | مطابقة المخطط              | `pnpm db:verify`                                                                                 | يثبت الأعمدة والفهارس الحرجة                                                                              |
| ٧   | preflight بعد DB           | المرشح نفسه                                                                                      | يثبت توافق المرشح مع المخطط النهائي وعدم تغيّر وضع enabled/disabled أثناء النشر                           |
| ٨   | فحص الرجوع                 | تشغيل إصدار الويب السابق على loopback معزول + فحص إصدار الجسر السابق                             | بعد الهجرات يفحص health و`settings/categories/catalog` فعلياً قبل أي swap؛ بلا عمّال خلفية أو بيئة مميزة  |
| ٩   | تبديل الويب وإعادة تحميله  | rename ذريّ واحد لرابط `.runtime/web-current` ثم `pm2 reload ... --only erp-server --update-env` | لا توجد لحظة بلا artifact؛ العمال القديمة والجديدة تخدم إصدارات immutable كاملة أثناء rolling reload      |
| ١٠  | جاهزية المتجر الخارجية     | `node scripts/verify-nginx-storefront-readiness.mjs`                                             | يفحص المضيف الداخلي والعام: `/store` و`settings/categories/catalog`، ويرفض النتائج الفارغة                |
| ١١  | معاملة تفعيل الجسر         | release-local PM2 config → runtime gate → `pm2 save` → commit                                    | يثبت المسار وcwd وPID والمنفذ والبيئة و`min_uptime`، ثم يثبت dump قبل اعتماد الحالة                       |

**عامل الجسر إصدار immutable فعلي:** يحوي bootstrap والحزمة والسياسة ومصنع PM2 وتعريف PM2 المحلي ولقطة canonical محمية (`0600`) لمفاتيح بيئة الجسر المسموحة، وكلها داخلة في SHA-256 واحد. الـpreflight والتشغيل والrollback تقرأ اللقطة من الإصدار نفسه ولا تعيد قراءة `.env`. لا تُنسخ الأسرار إلى `app.env` أو `dump.pm2`؛ PM2 يحمل مفاتيح التحكم الآمنة فقط، ثم يستبدل bootstrap بيئته باللقطة قبل استيراد العامل. لا يظهر الجسر في `ecosystem.config.cjs` الجذري إلا أثناء artifact-smoke.

**حزمة الويب معاملة إصدار أيضاً:** يُبنى المرشح في worktree معزول من SHA نفسه، ويُفحص قبل أخذ
أي خطوة DB. عند أول انتقال تُنسخ `dist` القديمة إلى إصدار immutable ويُنشأ
`.runtime/web-current` من دون لمسها؛ PM2 يبدأ دائماً من هذا الرابط. بعد إثبات توافق الهجرات
والرجوع؛ ويُشغّل الإصدار السابق مؤقتاً على منفذ loopback معزول بعد المخطط النهائي، ويفحص صحته
وقراءاته العامة ثم يوقفه، فلا يُسمح بالرجوع إلى خادم لا يفهم الهجرة الجديدة. لا يرث هذا المجس
`process.env` أو مفاتيح الصيانة المميزة ولا يشغّل عمّال الخلفية. بعدها يُنقل المرشح المكتمل إلى
release، ويُكتب `.runtime/web-activation-pending.json` ويُزامن على القرص، ثم يُستبدل **الرابط
وحده بـrename واحدة ذرية** قبيل
rolling reload. لذلك فحتى انقطاع العملية عند حدّ التبديل يترك الرابط على إصدار سابق كامل أو مرشح
كامل، ولا توجد نافذة اسمها `dist` مفقود. لا يُحذف journal إلا بعد نجاح الجاهزية الخارجية؛ فإذا
حدث SIGKILL/انقطاع كهرباء بعد swap وقبل القبول، فإن التشغيل التالي **قبل git pull** يعيد previous
ذرياً ويحمّله ويفحص `/healthz` داخلياً، ولا يجعل المرشح غير المقبول baseline جديداً. فشل reload أو الجاهزية الخارجية يعيد الرابط ذرياً إلى
الإصدار السابق ويعيد تحميله؛ المرشح الفاشل والنسخة السابقة يبقيان في snapshot محدود الاحتفاظ
للتشخيص، من دون طباعة بيئة البناء.

**عند فشل التفعيل أو البوابة أو `pm2 save`:** يعيد السكربت الإصدار السابق بالمسار الدقيق، يعيد بوابة الاستقرار، ثم يحفظه. نجاح الرجوع يخرج بكود 1 ويبلّغ `ROLLBACK_OK`؛ فشل الرجوع يخرج بكود 2 ويُبقي journal مانعاً لأي نشر جديد حتى التعافي. لا توجد استعادة DB تلقائية؛ يجب أن تبقى الهجرات expand/contract متوافقة مع نافذة rollback.

> **أول انتقال لا يحذف العامل القديم بلا baseline.** إذا وجد `prod:deploy` عملية legacy ولم يجد `state.current` فإنه يفشل قبل `git pull` بالرمز `HR_BRIDGE_LEGACY_ADOPTION_REQUIRED`. نفّذ adopter أدناه من worktree مؤقت: يبني ويفحص الإصدار الجديد من دون تغيير checkout الفعّال، ثم يبدّل الجسر ويحفظ PM2 و`state.current`. عند فشل المرشح يعيد legacy من checkout القديم قبل السماح بأي pull. بعد نجاح الاعتماد تصبح تغييرات enabled↔disabled وكل الإصدارات اللاحقة قابلة للرجوع الآلي.

> عامل الجسر يبدأ دائماً fresh لأن `startOrReload --update-env` يدمج المفاتيح القديمة. تعريف الإصدار يصفّر البيئة الموروثة ثم يعيد allowlist فقط، والـbootstrap يحذف أي مفتاح زائد **قبل** تحميل كود العامل. البوابة تدقق `pm2_env.env` الفعلية من دون طباعة الأسماء أو القيم.

**بعد النجاح — تحقّق حيّ فوريّ:** بوابة المرحلة ١٠ تكون قد أثبتت أن كلا المضيفين يعيدان صفحة
المتجر وإعداداته وفئاته ومنتجاته بأعداد غير صفرية. لفحص حالة الطباعة أيضاً:

```bash
curl -sf https://srv1548487.hstgr.cloud/api/print/status || pm2 logs erp-server --lines 20
```

> ⚠️ **خادمٌ مشترك (سراج/أودو خطّ أحمر):** `prod:deploy` لا يمسّ إلّا حزمة ERP وقاعدتها؛ لا `reboot` ولا `ufw` ولا تغيير توقيتٍ بلا موافقة المالك (§٦ + ذاكرة قيود VPS).

**مرة واحدة فقط لترحيل VPS عليه عامل legacy يعمل** — يجب أن يبقى `/home/deploy/erp` على checkout القديم حتى ينجح adopter:

```bash
sudo npm install -g pm2@7.0.3
sudo -iu deploy pm2 update
sudo -iu deploy bash <<'BASH'
set -euo pipefail
active=/home/deploy/erp
cd "$active"
git status --porcelain=v1 --untracked-files=all | grep -q . && {
  echo "الـcheckout الفعّال غير نظيف؛ أوقف الاعتماد من دون تغيير أي ملف"
  exit 1
}
git fetch origin main
adopter=$(mktemp -d /home/deploy/hr-bridge-adopter.XXXXXX)
cleanup() {
  cd "$active"
  git worktree remove --force "$adopter" >/dev/null 2>&1 || true
}
trap cleanup EXIT
git worktree add --detach "$adopter" origin/main
cd "$adopter"
pnpm install --frozen-lockfile
pnpm build
node scripts/adopt-hr-bridge-legacy.mjs --project-root "$active"

# adopter نفسه لا يسحب checkout الفعّال إلا بعد runtime gate + pm2 save + state.current،
# ويحمل sync.lock طوال الاعتماد والسحب. عند عودته يكون active على origin/main.
cd "$active"
pnpm prod:deploy
BASH
```

إذا انقطع adopter، أعد الأمر نفسه؛ يقرأ `legacy-adoption.json` ويعيد legacy أولاً ما دام checkout القديم لم يُسحب، أو يثبت الـbaseline الملتزم ويكمل السحب إن وقع الانقطاع بعد الاعتماد. لا تنفذ `git pull` يدوياً بين فشل adopter واستعادة legacy. يكتشف adopter حالة العامل القديمة ديناميكياً: إن كانت سليمة لا يقبل رجوعاً متدهوراً، وإن كانت `online` بلا مستمع (حالة الخادم الحالية) يسجلها `unhealthy` ويسمح للمرشح المترجم بإصلاحها؛ وإذا فشل المرشح يعيد تعريف legacy نفسه إلى `online` ويبلغ بوضوح أنه أعاد baseline غير سليم، لا `ROLLBACK_OK`. كما يقبل snapshot معطلة عمداً ويعتمد غياب الجسر بعد التحقق والحفظ. لا تشغّل الجسر يدوياً من `ecosystem.config.cjs` أو `dist`.

## ٨. قائمة تحقّق ما بعد النشر

- [ ] `https://erp.<نطاقك>` يفتح بقفل TLS صحيح ويقبل تسجيل الدخول (الكوكي secure يعمل ⇒ X-Forwarded-Proto مضبوط).
- [ ] `node scripts/verify-nginx-storefront-readiness.mjs` ينجح للمضيفين الداخلي والعام، وبأعداد فئات ومنتجات غير صفرية.
- [ ] فتح الموقع عبر `http://` يُحوَّل تلقائياً إلى `https://` (certbot).
- [ ] `docker compose ps` تُظهر `healthy`، و`pm2 status` تُظهر `online`.
- [ ] `ss -tlnp | grep 3307` يُظهر `127.0.0.1:3307` فقط (لا `0.0.0.0`) — القاعدة محجوبة بالربط المحلي. (بند ufw فقط على خادم مخصّص.)
- [ ] `systemctl cat pm2-deploy.service | grep wait-mysql` يُظهر درع ترتيب الإقلاع (G10)، و`ExecStart` يشير إلى helper ‏root-owned تحت `/usr/local/libexec/erp`؛ الوحدة `active` و`MainPID` يساوي `/run/erp-pm2/pm2-deploy.pid` المملوك `root:root 0644`.
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
DB_CONTROL_NAME=erp_control
DB_CONTROL_USER=erp_control_app
DB_CONTROL_PW=$(openssl rand -hex 24)
CONTROL_DATABASE_URL=mysql://erp_control_app:<قيمة-DB_CONTROL_PW>@127.0.0.1:3307/erp_control
INTEGRATIONS_ENCRYPTION_KEY=$(openssl rand -hex 32)

pnpm db:ensure-app-user                  # ينشئ قاعدة/حساب التحكّم بصلاحية محصورة، لا root للويب
pnpm control:bootstrap                     # مرّة واحدة: يُنشئ مخطّط erp_control
pnpm company:new <رمز> "<اسم الشركة>" \
  --admin-email admin@company.example --admin-password '<قوية>'   # لكل شركة: قاعدة+مستخدم DB مخصّص+seed
pnpm platform-admin:new                    # حساب تشغيلي واحد يدير الشركات عبر /platform-admin
```

لا حاجة لتعديل كود إضافي — أسطح `/api/trpc` و`/api/print` و`/api/backups` و`/api/webhooks/company/:code`
جاهزة لعزل الشركات فور ضبط `CONTROL_DATABASE_URL`. الاستثناء المتعمَّد: استعادة/تصفير القاعدة من
داخل واجهة النظام تبقى معطَّلة لأي شركة في هذا الوضع (مرّ عبر `pnpm db:backup:all-companies` +
استعادة يدوية موجَّهة بدلاً منها). التفصيل الكامل: ذاكرة `multi-company-tenancy-2026-07-01`.
