# نظام إدارة الأعمال المتكامل

نظام متكامل وموثوق لإدارة المبيعات والمشتريات والمخزن والموارد البشرية والحسابات، مع نقطة بيع احترافية وتطبيق موبايل PWA.

## الميزات الرئيسية

### 🛒 نقطة البيع (POS)
- واجهة سهلة الاستخدام وسريعة
- إضافة المنتجات للسلة بسهولة
- حساب الإجماليات والضرائب تلقائياً
- طباعة فواتير فورية وموثوقة
- دعم طرق دفع متعددة

### 📦 إدارة المخزن
- تتبع المنتجات والمخزون
- تنبيهات المخزون المنخفض
- تقارير المخزون التفصيلية
- استيراد وتصدير البيانات

### 💰 الحسابات والمالية
- إدارة الفواتير والمقبوضات
- تقارير الأرباح والخسائر
- إدارة المدفوعات والتحويلات
- تقارير مالية شاملة

### 👥 الموارد البشرية
- إدارة الموظفين والرواتب
- تسجيل الحضور والانصراف بالبصمة
- تقارير الحضور والغياب
- حساب الرواتب والعلاوات

### 📊 التقارير والتحليلات
- تقارير مبيعات يومية وشهرية
- تحليل الأداء
- إحصائيات العملاء والموردين
- تصدير التقارير (PDF, Excel, CSV)

### 🌐 التطبيق الويب والموبايل
- تطبيق ويب متجاوب (Responsive)
- تطبيق PWA يعمل بدون إنترنت
- واجهة عربية كاملة
- دعم الأجهزة المختلفة

## المتطلبات التقنية

### للتطوير المحلي
- Node.js 22+
- pnpm
- PostgreSQL أو MySQL
- Redis (اختياري)

### للنشر على VPS
- Ubuntu 24.04 LTS
- Docker و Docker Compose
- 4 CPU cores
- 16GB RAM
- 200GB Disk Space

## البدء السريع

### 1. التثبيت المحلي

```bash
# استنساخ المشروع
git clone <repo-url>
cd business_management_system

# تثبيت التبعيات
pnpm install

# إعداد قاعدة البيانات
pnpm db:push

# تشغيل التطبيق
pnpm dev
```

### 2. الوصول إلى التطبيق
- الويب: http://localhost:3000
- API: http://localhost:3000/api/trpc

## البنية المعمارية

```
┌─────────────────────────────────────┐
│   Frontend (React + Tailwind)       │
│   - نقطة البيع                      │
│   - الحضور والانصراف               │
│   - التقارير                       │
└────────────┬────────────────────────┘
             │
┌────────────▼────────────────────────┐
│   Backend (Express + tRPC)          │
│   - API الفواتير                   │
│   - API البصمة                     │
│   - API التقارير                   │
└────────────┬────────────────────────┘
             │
┌────────────▼────────────────────────┐
│   قاعدة البيانات (MySQL/PostgreSQL)│
│   - الفواتير والمبيعات            │
│   - المنتجات والمخزن              │
│   - الموظفين والحضور              │
│   - الحسابات والمالية             │
└─────────────────────────────────────┘
```

## الخدمات الرئيسية

### خدمة الفواتير
```typescript
// إنشاء فاتورة جديدة
await invoiceService.createInvoice({
  customerId: 1,
  sourceType: "POS",
  items: [...],
  taxPercent: 15,
  paymentMethod: "CASH"
});

// معالجة الدفع
await invoiceService.processPayment({
  invoiceId: 1,
  amount: 1000,
  paymentMethod: "CASH"
});
```

### خدمة البصمة
```typescript
// تسجيل البصمة
await biometricService.processBiometricData({
  employeeId: 1,
  fingerprint: "fingerprint_data",
  timestamp: new Date()
});

// الحصول على تقرير الحضور الشهري
await biometricService.getMonthlyAttendanceReport(
  employeeId,
  year,
  month
);
```

## API Endpoints

### الفواتير
- `POST /api/trpc/invoices.create` - إنشاء فاتورة
- `POST /api/trpc/invoices.processPayment` - معالجة الدفع
- `GET /api/trpc/invoices.getDetails` - تفاصيل الفاتورة
- `GET /api/trpc/invoices.list` - قائمة الفواتير
- `GET /api/trpc/invoices.getDailyStats` - إحصائيات اليوم

### البصمة والحضور
- `POST /api/trpc/biometric.recordBiometric` - تسجيل البصمة
- `GET /api/trpc/biometric.getAttendanceRecord` - سجل الحضور
- `GET /api/trpc/biometric.getMonthlyReport` - التقرير الشهري
- `GET /api/trpc/biometric.checkLateArrival` - التحقق من التأخر
- `GET /api/trpc/biometric.exportReport` - تصدير التقرير

## قاعدة البيانات

### الجداول الرئيسية

#### جدول الفواتير
```sql
CREATE TABLE invoices (
  id INT PRIMARY KEY AUTO_INCREMENT,
  invoiceNumber VARCHAR(50) UNIQUE,
  customerId INT,
  subtotal DECIMAL(12,2),
  taxAmount DECIMAL(12,2),
  total DECIMAL(12,2),
  status ENUM('PENDING', 'PAID', 'PARTIALLY_PAID'),
  invoiceDate TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### جدول الحضور
```sql
CREATE TABLE attendance (
  id INT PRIMARY KEY AUTO_INCREMENT,
  employeeId INT,
  attendanceDate DATE,
  checkIn TIMESTAMP,
  checkOut TIMESTAMP,
  status ENUM('PRESENT', 'ABSENT', 'LATE', 'LEAVE'),
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## الأداء والموثوقية

### معايير الأداء
- ⚡ استجابة API أقل من 100ms
- 📊 معالجة 1000+ فاتورة يومياً
- 🔒 99.9% uptime
- 💾 نسخ احتياطية تلقائية

### الأمان
- ✅ تشفير البيانات الحساسة
- ✅ مصادقة OAuth2
- ✅ حماية CSRF
- ✅ Rate limiting
- ✅ SQL injection protection

## النشر على VPS

```bash
# انظر DEPLOYMENT.md للتعليمات الكاملة

# البناء والتشغيل
docker-compose build
docker-compose up -d

# التحقق من الحالة
docker-compose ps

# عرض السجلات
docker-compose logs -f
```

## الاختبار

```bash
# تشغيل الاختبارات
pnpm test

# الاختبارات مع التغطية
pnpm test:coverage

# الاختبارات المراقبة
pnpm test:watch
```

## المساهمة

نرحب بالمساهمات! يرجى:
1. Fork المشروع
2. إنشاء فرع للميزة الجديدة
3. الالتزام بالتغييرات
4. Push إلى الفرع
5. فتح Pull Request

## الترخيص

هذا المشروع مرخص تحت MIT License

## الدعم

للمساعدة والدعم:
- 📧 البريد الإلكتروني: support@example.com
- 💬 Telegram: @support_bot
- 📱 الهاتف: +966 XX XXX XXXX

## الشكر والتقدير

شكر خاص لـ:
- فريق التطوير
- المختبرين
- جميع المساهمين

---

**آخر تحديث:** يونيو 2026
**الإصدار:** 1.0.0
