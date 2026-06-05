# دليل النشر على VPS

## المتطلبات

- **VPS بـ Ubuntu 24.04 LTS** (أو أحدث)
- **4 CPU cores** (أو أكثر)
- **16GB RAM** (أو أكثر)
- **200GB Disk Space** (أو أكثر)
- **Docker و Docker Compose**
- **Domain Name** (اختياري لـ SSL)

## الخطوة 1: تثبيت Docker و Docker Compose

```bash
# تحديث النظام
sudo apt update && sudo apt upgrade -y

# تثبيت Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# إضافة المستخدم الحالي إلى مجموعة docker
sudo usermod -aG docker $USER
newgrp docker

# تثبيت Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# التحقق من التثبيت
docker --version
docker-compose --version
```

## الخطوة 2: استنساخ المشروع

```bash
# استنساخ المشروع
git clone <your-repo-url> /opt/erp-system
cd /opt/erp-system

# إنشاء ملف .env
cp .env.example .env

# تحرير ملف .env وإضافة القيم الخاصة بك
nano .env
```

## الخطوة 3: إعداد SSL (اختياري ولكن موصى به)

```bash
# تثبيت Certbot
sudo apt install certbot python3-certbot-nginx -y

# الحصول على شهادة SSL
sudo certbot certonly --standalone -d your-domain.com

# نسخ الشهادات إلى المشروع
sudo mkdir -p /opt/erp-system/ssl
sudo cp /etc/letsencrypt/live/your-domain.com/fullchain.pem /opt/erp-system/ssl/cert.pem
sudo cp /etc/letsencrypt/live/your-domain.com/privkey.pem /opt/erp-system/ssl/key.pem
sudo chown -R $USER:$USER /opt/erp-system/ssl
```

## الخطوة 4: بناء وتشغيل التطبيق

```bash
# الانتقال إلى مجلد المشروع
cd /opt/erp-system

# بناء الصور
docker-compose build

# تشغيل الخدمات
docker-compose up -d

# التحقق من حالة الخدمات
docker-compose ps

# عرض السجلات
docker-compose logs -f app
```

## الخطوة 5: إعداد قاعدة البيانات

```bash
# الانتظار لبضع ثوان حتى تبدأ قاعدة البيانات
sleep 10

# تشغيل الهجرات
docker-compose exec app pnpm db:push

# التحقق من قاعدة البيانات
docker-compose exec database mysql -u erp_user -p erp_system -e "SHOW TABLES;"
```

## الخطوة 6: إعداد النطاق (Domain)

```bash
# إضافة سجل DNS
# A record: your-domain.com -> VPS_IP
# CNAME: www.your-domain.com -> your-domain.com

# التحقق من الاتصال
ping your-domain.com
```

## الخطوة 7: النسخ الاحتياطية

```bash
# إنشاء سكريبت للنسخ الاحتياطية
cat > /opt/erp-system/backup.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="/opt/erp-system/backups"
mkdir -p $BACKUP_DIR
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# نسخ احتياطية من قاعدة البيانات
docker-compose exec -T database mysqldump -u erp_user -p erp_system > $BACKUP_DIR/db_$TIMESTAMP.sql

# ضغط النسخة
gzip $BACKUP_DIR/db_$TIMESTAMP.sql

# حذف النسخ القديمة (أكثر من 30 يوم)
find $BACKUP_DIR -name "db_*.sql.gz" -mtime +30 -delete

echo "Backup completed: $BACKUP_DIR/db_$TIMESTAMP.sql.gz"
EOF

chmod +x /opt/erp-system/backup.sh

# إضافة النسخ الاحتياطية إلى cron
crontab -e
# أضف هذا السطر:
# 0 2 * * * /opt/erp-system/backup.sh
```

## الخطوة 8: المراقبة والصيانة

```bash
# عرض استخدام الموارد
docker stats

# عرض السجلات
docker-compose logs -f

# إعادة تشغيل الخدمات
docker-compose restart

# إيقاف الخدمات
docker-compose down

# تحديث التطبيق
git pull
docker-compose build
docker-compose up -d
```

## استكشاف الأخطاء

### المشكلة: الاتصال برفض قاعدة البيانات

```bash
# التحقق من حالة قاعدة البيانات
docker-compose logs database

# إعادة تشغيل قاعدة البيانات
docker-compose restart database
```

### المشكلة: استهلاك عالي للذاكرة

```bash
# عرض استخدام الموارد
docker stats

# تقليل حجم المخزن المؤقت
docker system prune -a
```

### المشكلة: بطء الاستجابة

```bash
# التحقق من أداء قاعدة البيانات
docker-compose exec database mysql -u erp_user -p erp_system -e "SHOW PROCESSLIST;"

# تحسين الأداء
docker-compose exec database mysql -u erp_user -p erp_system -e "OPTIMIZE TABLE invoices, invoice_items;"
```

## الأوامر المفيدة

```bash
# الوصول إلى shell التطبيق
docker-compose exec app sh

# الوصول إلى shell قاعدة البيانات
docker-compose exec database mysql -u erp_user -p erp_system

# عرض استخدام الموارد
docker stats

# تنظيف الموارد غير المستخدمة
docker system prune -a

# عرض حجم الصور
docker images --format "table {{.Repository}}\t{{.Size}}"

# عرض حجم الحاويات
docker ps -a --format "table {{.Names}}\t{{.Size}}"
```

## الأمان

1. **تغيير كلمات المرور الافتراضية**
   - غيّر `DB_PASSWORD` في `.env`
   - غيّر `JWT_SECRET` في `.env`

2. **تفعيل Firewall**
   ```bash
   sudo ufw enable
   sudo ufw allow 22/tcp
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   ```

3. **تحديث النظام بانتظام**
   ```bash
   sudo apt update && sudo apt upgrade -y
   ```

4. **مراقبة السجلات**
   ```bash
   docker-compose logs -f
   ```

## الدعم والمساعدة

للمزيد من المعلومات، راجع:
- [Docker Documentation](https://docs.docker.com/)
- [Docker Compose Documentation](https://docs.docker.com/compose/)
- [Nginx Documentation](https://nginx.org/en/docs/)
