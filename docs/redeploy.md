# دليل إعادة النشر — نظام الرؤية العربية

> من جهاز فارغ إلى نظام يعمل في الإنتاج. اتبع الخطوات بالترتيب. الزمن المتوقّع: ~ساعة.

## المتطلّبات المسبقة

| الأداة | الإصدار | التحقّق |
|---|---|---|
| Node.js | 20+ | `node -v` |
| pnpm | 9+ | `pnpm -v` (تثبيت: `npm i -g pnpm`) |
| Docker Desktop | حديث | `docker -v` |
| Git | أي | `git -v` |

## الخطوات

1. **استنساخ المستودع**
   ```powershell
   git clone <REPO_URL> business_management_system
   cd business_management_system
   ```

2. **تثبيت الحزم**
   ```powershell
   pnpm install
   ```

3. **إعداد متغيّرات البيئة**
   ```powershell
   copy .env.example .env
   ```
   ثمّ حرّر `.env` واملأ: `DATABASE_URL`, `DB_ROOT_PW`, `JWT_SECRET` (ولّده بالأمر في القالب), `ADMIN_PASSWORD`.

4. **رفع قاعدة البيانات (مع تخزين دائم)**
   ```powershell
   docker compose up -d
   ```
   انتظر حتى تصبح الحاوية `healthy`:
   ```powershell
   docker compose ps
   ```

5. **هجرة المخطط**
   ```powershell
   pnpm db:push
   ```

6. **البذرة الأولى (admin + الفروع + عيّنات)**
   ```powershell
   pnpm seed
   ```

7. **فحص الأنواع**
   ```powershell
   pnpm check
   ```

8. **بناء الإنتاج**
   ```powershell
   pnpm build
   ```

9. **تشغيل تجريبي**
   ```powershell
   pnpm start
   ```
   افتح `http://localhost:3000` وسجّل دخولاً بـ`ADMIN_EMAIL` / `ADMIN_PASSWORD`.

10. **تشغيل تلقائي عند الإقلاع (خدمة Windows)**

    باستعمال [nssm](https://nssm.cc/) (أبسط من PM2 على Windows):
    ```powershell
    nssm install "AlRoya ERP" "C:\Program Files\nodejs\node.exe" "dist\index.js"
    nssm set "AlRoya ERP" AppDirectory "C:\path\to\business_management_system"
    nssm set "AlRoya ERP" AppEnvironmentExtra NODE_ENV=production
    nssm start "AlRoya ERP"
    ```

11. **جدولة النسخ الاحتياطي اليومي**

    حرّر `scripts\scheduled-backup.xml` (المسار + المستخدم)، ثمّ:
    ```powershell
    schtasks /Create /TN "AlRoya ERP - Daily Backup" /XML "scripts\scheduled-backup.xml"
    ```
    وحارس الحاوية (ساعي):
    ```powershell
    schtasks /Create /SC HOURLY /TN "AlRoya ERP - Docker Watchdog" /TR "node -r dotenv/config C:\path\to\business_management_system\scripts\docker-watchdog.mjs" /ST 00:00
    ```

12. **تأكيد النسخ الاحتياطي يعمل**
    ```powershell
    pnpm db:backup
    ```
    يجب أن تظهر نسخة في `backups\` ورسالة «✓ تدوير».

## قائمة تحقّق ما بعد النشر

- [ ] `http://localhost:3000` يفتح ويقبل تسجيل الدخول.
- [ ] `docker compose ps` تُظهر `healthy`.
- [ ] `pnpm db:backup` يُنتج ملفاً > 2KB.
- [ ] مهمّتا Task Scheduler ظاهرتان (`schtasks /Query /TN "AlRoya ERP - Daily Backup"`).
- [ ] الخدمة تبدأ تلقائياً بعد إعادة تشغيل الجهاز.
- [ ] `BACKUP_OFFSITE_DIR` مضبوط على OneDrive/USB إن توفّر.

## بديل أصلب (موصى به للمتجر الواحد): MySQL كخدمة Windows

Docker Desktop ينهار أحياناً بعلّة AI Inference manager. لمتجر واحد، MySQL كخدمة Windows أصلب وأخفّ ذاكرة:

1. ثبّت MySQL 8 Server (MSI) واختر «Run as Windows Service» + تشغيل تلقائي.
2. أنشئ القاعدة: `mysql -uroot -p -e "CREATE DATABASE erp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"`
3. عدّل `DATABASE_URL` في `.env` (المنفذ نفسه 3306).
4. عدّل `scripts/backup.mjs`: استبدل `docker exec erp-mysql mysqldump …` بـ`mysqldump.exe` المحلّي مباشرة (بلا `docker exec`).
5. ألغِ مهمّة `Docker Watchdog` (لا حاجة لها).

> هذا قرار للمالك — راجع §٦ في خطّة `infra-prod`. حالياً النظام يدعم المسارَين.
