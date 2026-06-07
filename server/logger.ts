// تسجيل بنيوي (structured logging) عبر pino — بديل عن console.log المتناثر.
// في التطوير: مخرجات ملوّنة مقروءة (pino-pretty). في الإنتاج: JSON سطر-لكل-حدث (للتجميع/التحليل).
// المستوى عبر LOG_LEVEL (افتراضي info؛ debug في التطوير).
import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";
const level = process.env.LOG_LEVEL ?? (isDev ? "debug" : "info");

export const logger = pino({
  level,
  // تجريد الحقول الحسّاسة من السجلّات (لا نسجّل كلمات مرور/كوكيز/توكنات).
  redact: {
    paths: [
      "req.headers.cookie",
      "req.headers.authorization",
      "*.password",
      "*.passwordHash",
      "*.token",
      "*.jwt",
    ],
    censor: "[محجوب]",
  },
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      }
    : {}),
});

export type Logger = typeof logger;
