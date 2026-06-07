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

## ٣. اختبار استعادة دوري (ربع سنوي — إلزامي)

نسخة لا تُختبَر استعادتها = نسخة وهمية. كل ٣ أشهر:

```powershell
# 1) أنشئ قاعدة مؤقّتة للاختبار
docker exec erp-mysql mysql -uroot -perp_root_pw -e "CREATE DATABASE erp_restore_test;"

# 2) استعد آخر نسخة إليها (مع تغيير اسم القاعدة في السطر USE داخل الـdump عند الحاجة،
#    أو استعملها بـ--one-database)
docker exec -i erp-mysql mysql -uroot -perp_root_pw erp_restore_test < backups\<أحدث نسخة>.sql

# 3) قارن عدد الصفوف في الجداول الحرجة
docker exec erp-mysql mysql -uroot -perp_root_pw -e "
  SELECT 'invoices' t, COUNT(*) n FROM erp_restore_test.invoices
  UNION SELECT 'products', COUNT(*) FROM erp_restore_test.products
  UNION SELECT 'branchStock', COUNT(*) FROM erp_restore_test.branchStock
  UNION SELECT 'accountingEntries', COUNT(*) FROM erp_restore_test.accountingEntries;"

# 4) نظّف
docker exec erp-mysql mysql -uroot -perp_root_pw -e "DROP DATABASE erp_restore_test;"
```

سجّل تاريخ آخر اختبار ناجح هن: `آخر اختبار استعادة: ____________`

## ٤. سيناريوهات الطوارئ

| العطل | الإجراء |
|---|---|
| **الحاوية لا تبدأ** | `docker compose logs mysql` لمعرفة السبب؛ إن كان Docker Desktop ساقطاً: أعد تشغيله ثمّ `node scripts/docker-watchdog.mjs`. |
| **فقد البيانات (حذف/تلف)** | استعد من آخر نسخة (§٢). البيانات منذ آخر نسخة تضيع — لذا النسخ اليومية مهمّة. |
| **تلف الجهاز كاملاً** | جهاز جديد ⇐ `docs/redeploy.md` + استعادة آخر نسخة من `BACKUP_OFFSITE_DIR` (OneDrive/USB). |
| **`docker rm` بالخطأ** | الـvolume `erp_data` يبقى! `docker compose up -d` يعيد ربطه بالبيانات سليمة. (هذا هو سبب وجود الـvolume.) |
| **حذف الـvolume بالخطأ (`down -v`)** | استعد من نسخة (§٢). لهذا لا تستعمل `down -v` أبداً. |

## ٥. مؤشّرات صحّة يجب مراقبتها

- حجم آخر نسخة احتياطية **يتزايد** بمرور الوقت (تقلّصه = إنذار فقد بيانات).
- عمر أحدث ملف في `backups\` **< ٢٤ ساعة** (وإلّا الجدولة معطّلة).
- وجود نسخة في `BACKUP_OFFSITE_DIR` بعمر < ٢٤ ساعة.
- `docker compose ps` تُظهر `healthy` لا `unhealthy`.
