# ====================================
# Dockerfile للنشر على VPS
# ====================================
# 
# يبني صورة Docker متكاملة للتطبيق
# مع Node.js والتبعيات المطلوبة

# المرحلة 1: البناء
FROM node:22-alpine AS builder

WORKDIR /app

# تثبيت pnpm
RUN npm install -g pnpm

# نسخ ملفات package
COPY package.json pnpm-lock.yaml ./

# تثبيت التبعيات
RUN pnpm install --frozen-lockfile

# نسخ الكود
COPY . .

# بناء التطبيق
RUN pnpm build

# المرحلة 2: الإنتاج
FROM node:22-alpine

WORKDIR /app

# تثبيت pnpm
RUN npm install -g pnpm

# نسخ package.json فقط
COPY package.json pnpm-lock.yaml ./

# تثبيت التبعيات الإنتاجية فقط
RUN pnpm install --frozen-lockfile --prod

# نسخ الملفات المبنية من المرحلة السابقة
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/client/dist ./client/dist

# إنشاء مستخدم غير root
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001
USER nodejs

# تعريض المنفذ
EXPOSE 3000

# متغيرات البيئة
ENV NODE_ENV=production
ENV PORT=3000

# أمر البدء
CMD ["node", "dist/index.js"]

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"
