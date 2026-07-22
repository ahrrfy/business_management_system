# دليل التعافي من الكوارث — نظام الرؤية العربية

> ماذا تفعل عند فقد البيانات أو تعطّل القاعدة. اقرأه **قبل** الكارثة، لا بعدها.

## ١. الترحيل الآمن من الحاوية القديمة (بلا volume) إلى docker-compose

الحاوية `erp-mysql` القديمة أُنشئت بلا named volume ⇒ بياناتها داخل طبقة الحاوية القابلة للحذف.
هذا الإجراء ينقلها إلى `erp_data` volume دائم **دون فقد**. نفّذه مرّة واحدة:

```powershell
# 1) نسخة احتياطية كاملة أوّلاً (الأمان قبل كل شيء)
pnpm db:backup
docker exec erp-mysql mysqldump -uroot -perp_root_pw --all-databases --single-transaction --routines --events > full-dump.sql

# 2) أوقف الحاوية القديمة وأعد تسميتها (لا تحذفها بعد — شبكة أمان)
docker stop erp-mysql
docker rename erp-mysql erp-mysql-old

# 3) ارفع الحاوية الجديدة بالـvolume الدائم
docker compose up -d
docker compose ps          # انتظر "healthy"

# 4) استورد البيانات إلى الحاوية الجديدة
docker exec -i erp-mysql mysql -uroot -perp_root_pw < full-dump.sql

# 5) تحقّق التكامل
pnpm test                  # يجب أن تمرّ اختبارات التكامل
#    + جولة بصرية: افتح اللوحة وتأكّد من ظهور المنتجات/الفواتير

# 6) بعد ٧ أيام من الاستقرار فقط، احذف القديمة
docker rm erp-mysql-old
```

## ٢. استعادة من نسخة احتياطية

```powershell
# اعرض النسخ المتاحة (الأحدث أسفل)
dir backups\

# استعد نسخة محدّدة (⚠ يستبدل البيانات الحالية)
docker exec -i erp-mysql mysql -uroot -perp_root_pw < backups\erp-2026-06-07T02-00-00.sql
```

### استعادة نسخة خارجية مشفّرة (VPS)

النسخ الخارجية تُسحب مشفّرة (`.sql.gpg`). فكّ التشفير أولاً ثم استعد كالمعتاد:

```bash
gpg -d -o restore.sql erp-2026-06-10T23-00-00.sql.gpg   # يطلب BACKUP_GPG_PASSPHRASE
docker exec -i erp-mysql mysql -uroot -p"$DB_ROOT_PW" < restore.sql
```

> **استعادة نقطة-زمنية (binlog):** قاعدة الـVPS تحتفظ بـbinlog لثلاثة أيام، فبعد استعادة آخر نسخة
> ليلية يمكن إعادة تطبيق الحركات حتى لحظة العطل عبر `mysqlbinlog --start-datetime=…` —
> إجراء دقيق؛ اطلبه من المهندس ولا تنفّذه ارتجالاً.

## ٣. اختبار استعادة دوري (ربع سنوي — إلزامي)

نسخة لا تُختبَر استعادتها = نسخة وهمية. كل ٣ أشهر.

> ⚠️ **خطر يدمّر الإنتاج — لا تستعد نسخة تطبيق على الإنتاج لغرض الاختبار.** نسخ التطبيق
> (`scripts/backup.mjs` / `maintenanceService`) هي `mysqldump --databases erp` ⇒ تبدأ بعبارتَي
> `CREATE DATABASE` و`USE erp;`. وعبارة `USE erp` تُوجّه **كلّ ما بعدها** إلى قاعدة الإنتاج `erp`
> وتتجاوز أيّ قاعدة هدف تُمرَّر على سطر الأمر — فمجرّد استيراد نسخة «للاختبار» في قاعدة مؤقّتة
> **بلا تنظيف يكتب على الإنتاج ويدمّره**. لذلك احذف أسطر `CREATE DATABASE`/`USE`/`DROP DATABASE`
> قبل الاستيراد (كما في الخطوة ٢ أدناه) لتُستعاد النسخة في قاعدة مؤقّتة معزولة فعلاً.
> (ثبت عملياً ٢٢/٧: النسخ تحوي هذين السطرين.)

> **بيئة التنفيذ:** إجراء POSIX (يستعمل `grep` وأنبوباً) ⇒ نفّذه على الخادم (VPS) عبر SSH، أو على
> جهاز المتجر عبر Git Bash — لا في PowerShell عارياً. كلمة مرور الجذر تُقرأ من بيئة الحاوية
> (`$MYSQL_ROOT_PASSWORD`) لا من قيمة مكتوبة (على الإنتاج القيمة سرّ في `.env` لا `erp_root_pw`)،
> وتُمرَّر عبر `MYSQL_PWD` لا سطر الأوامر (خادم مشترك — `ps` يكشف argv؛ نفس نمط `backup.mjs`
> و healthcheck في `docker-compose.yml`).

```bash
# 1) أنشئ قاعدة مؤقّتة للاختبار — منفصلة تماماً عن الإنتاج erp
docker exec erp-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -e "CREATE DATABASE IF NOT EXISTS erp_restore_test;"'

# 2) استعد آخر نسخة إليها — بعد حذف أسطر تحويل القاعدة (CREATE DATABASE/USE/DROP DATABASE) أوّلاً،
#    وإلّا فعبارة USE erp تُوجّه الاستيراد إلى الإنتاج وتدمّره (انظر التحذير أعلاه).
grep -vE '^(CREATE DATABASE|USE |DROP DATABASE)' backups/<أحدث نسخة>.sql \
  | docker exec -i erp-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot erp_restore_test'
#    للنسخ الخارجية المشفّرة (.sql.gpg): فكّها أولاً بـ gpg -d (§٢) ثمّ مرّرها عبر نفس مرشّح grep.

# 3) قارن عدد الصفوف في الجداول الحرجة (على القاعدة المؤقّتة حصراً)
#    استعادة كاملة ~١١٨ جدولاً؛ نقصٌ حادّ في العدد أو الصفوف = استيراد ناقص.
docker exec erp-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot erp_restore_test -e "
  SELECT \"invoices\" tbl, COUNT(*) n FROM invoices
  UNION SELECT \"products\",          COUNT(*) FROM products
  UNION SELECT \"branchStock\",       COUNT(*) FROM branchStock
  UNION SELECT \"accountingEntries\", COUNT(*) FROM accountingEntries;"'

# 4) نظّف — احذف القاعدة المؤقّتة (لا تمسّ الإنتاج erp إطلاقاً)
docker exec erp-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -e "DROP DATABASE erp_restore_test;"'
```

سجّل تاريخ آخر اختبار ناجح هنا: `آخر اختبار استعادة: ٢٠٢٦-٠٧-٢٢ ✓ (١١٨ جدولاً، قاعدة مؤقّتة، الإنتاج لم يُمَسّ)`

## ٤. سيناريوهات الطوارئ

| العطل | الإجراء |
|---|---|
| **الحاوية لا تبدأ** | `docker compose logs mysql` لمعرفة السبب؛ إن كان Docker Desktop ساقطاً: أعد تشغيله ثمّ `node scripts/docker-watchdog.mjs`. |
| **فقد البيانات (حذف/تلف)** | استعد من آخر نسخة (§٢). البيانات منذ آخر نسخة تضيع — لذا النسخ اليومية مهمّة. |
| **تلف الجهاز كاملاً (متجر محلي)** | جهاز جديد ⇐ `docs/redeploy.md` + استعادة آخر نسخة من `BACKUP_OFFSITE_DIR` (OneDrive/USB). |
| **فقد الـVPS كلياً (احتراق/حذف/اختراق)** | خادم جديد ⇐ `docs/deployment-vps.md` من الصفر، ثم فكّ آخر نسخة مسحوبة على جهاز المتجر (`~/erp-vps-backups/*.sql.gpg`) بعبارة GPG **من الـescrow** واستعادتها. يتطلّب أسرار الـescrow أدناه — بدونها النسخ الخارجية لا تُفتح. |
| **`docker rm` بالخطأ** | الـvolume `erp_data` يبقى! `docker compose up -d` يعيد ربطه بالبيانات سليمة. (هذا هو سبب وجود الـvolume.) |
| **حذف الـvolume بالخطأ (`down -v`)** | استعد من نسخة (§٢). لهذا لا تستعمل `down -v` أبداً. |

## ٤.١ — Escrow الأسرار (إلزامي قبل اعتبار النشر مكتملاً)

النسخ الخارجية مشفّرة، والمفاتيح تعيش في `.env` على الخادم نفسه — **يوم يُفقد الخادم تُفقد معه ما لم
تكن محفوظة خارجه**. احفظ هذه الأسرار في مكانين مستقلّين على الأقل (مدير كلمات مرور المالك + ورقة
في خزنة المتجر):

| السرّ | لماذا يلزم يوم الكارثة |
|---|---|
| `BACKUP_GPG_PASSPHRASE` | بدونها كل ملفات `.sql.gpg` الخارجية **حبر على ورق** |
| `DB_ROOT_PW` | الاستعادة وإدارة القاعدة على الخادم الجديد |
| `JWT_SECRET` | إن أُعيد استعماله تبقى جلسات المستخدمين صالحة؛ وإلا فدخول جديد للجميع (مقبول) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | أول دخول بعد الاستعادة |

**واختبر فعلياً** (مرة بعد النشر ثم ربع سنوياً): فكّ نسخة `.sql.gpg` على جهاز المتجر بالعبارة
المحفوظة في الـescrow — لا بالعبارة الموجودة على الخادم. عبارة منسوخة خطأً تُكتشف اليوم، لا يوم الحريق.

## ٥. مؤشّرات صحّة يجب مراقبتها

- حجم آخر نسخة احتياطية **يتزايد** بمرور الوقت (تقلّصه = إنذار فقد بيانات).
- عمر أحدث ملف في `backups\` **< ٢٤ ساعة** (وإلّا الجدولة معطّلة).
- وجود نسخة في `BACKUP_OFFSITE_DIR` بعمر < ٢٤ ساعة.
- `docker compose ps` تُظهر `healthy` لا `unhealthy`.
