// تسجيل بنيوي (structured logging) عبر pino — بديل عن console.log المتناثر.
// في التطوير: مخرجات ملوّنة مقروءة (pino-pretty). في الإنتاج: JSON سطر-لكل-حدث (للتجميع/التحليل).
// المستوى عبر LOG_LEVEL (افتراضي info؛ debug في التطوير).
import pino, { type DestinationStream, type LoggerOptions } from "pino";

const isDev = process.env.NODE_ENV !== "production";
const REDACTED = "[محجوب]";
const MAX_SANITIZE_DEPTH = 20;
const MAX_SANITIZE_NODES = 5_000;

const sensitiveKeySuffixes = Object.freeze([
  "password",
  "passwordhash",
  "passphrase",
  "token",
  "jwt",
  "secret",
  "apikey",
  "accesskey",
  "accesskeyid",
  "privatekey",
  "encryptionkey",
  "credential",
  "credentials",
  "credentialsjson",
  "serviceaccountjson",
  "databaseurl",
  "connectionstring",
  "authorization",
  "cookie",
  "csrftoken",
  "pw",
]);

function normalizedKey(key: string) {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isSensitiveKey(key: string) {
  const normalized = normalizedKey(key);
  return (
    normalized === "headers" ||
    normalized === "dsn" ||
    sensitiveKeySuffixes.some((suffix) => normalized.endsWith(suffix))
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSensitiveStringValues(environment: NodeJS.ProcessEnv) {
  return Object.entries(environment)
    .filter(
      ([key, value]) =>
        typeof value === "string" && value.length >= 8 && isSensitiveKey(key),
    )
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length);
}

function createLogSanitizer(environment: NodeJS.ProcessEnv) {
  const knownSecretPatterns = buildSensitiveStringValues(environment).map(
    (value) => new RegExp(escapeRegExp(value), "g"),
  );

  function redactString(value: string) {
    let sanitized = value
      .replace(/([a-z][a-z0-9+.-]*:\/\/)([^@\s/]+)@/gi, `$1${REDACTED}@`)
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
      .replace(
        /\b(password|passphrase|token|secret|refresh[_-]?token|access[_-]?token|client[_-]?secret|api[_-]?key|authorization|cookie|jwt|database[_-]?url|connection[_-]?string)\b(\s*[:=]\s*)([^\s,;}]+)/gi,
        `$1$2${REDACTED}`,
      );
    for (const pattern of knownSecretPatterns) {
      sanitized = sanitized.replace(pattern, REDACTED);
    }
    return sanitized;
  }

  function sanitize(value: unknown) {
    const seen = new WeakSet<object>();
    let nodes = 0;

    function visit(current: unknown, depth: number): unknown {
      if (typeof current === "string") return redactString(current);
      if (current === null || typeof current !== "object") return current;
      if (depth > MAX_SANITIZE_DEPTH || ++nodes > MAX_SANITIZE_NODES) {
        return REDACTED;
      }
      if (current instanceof Error) {
        return {
          type: redactString(current.name),
          message: redactString(current.message),
          stack: current.stack ? redactString(current.stack) : undefined,
          cause: current.cause ? visit(current.cause, depth + 1) : undefined,
        };
      }
      if (seen.has(current)) return "[Circular]";
      seen.add(current);
      if (Array.isArray(current)) {
        return current.map((entry) => visit(entry, depth + 1));
      }
      if (current instanceof URL) return redactString(current.toString());
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        // req/res وBuffer وسائر كائنات runtime تُترك لـserializers؛ fast-redact يحجب
        // حاويات headers قبل إخراجها. لا نمشي الرسوم الضخمة/الدائرية لهذه الكائنات.
        return current;
      }
      const output: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(current)) {
        output[key] = isSensitiveKey(key) ? REDACTED : visit(entry, depth + 1);
      }
      return output;
    }

    return visit(value, 0);
  }

  return { redactString, sanitize };
}

const sensitiveLogPaths = Object.freeze([
  // رؤوس HTTP حاوية أسرار مفتوحة النهاية. حجب الحاوية كاملةً fail-closed: أي رأس
  // مصادقة/CSRF/كوكي/سر بروكسي جديد يبقى محجوباً بلا انتظار تحديث blocklist.
  "headers",
  "req.headers",
  "request.headers",
  "res.headers",
  "response.headers",
  // الحقول الحسّاسة في حمولات التطبيق، على الجذر أو داخل كائن واحد شائع.
  "password",
  "*.password",
  "passwordHash",
  "*.passwordHash",
  "token",
  "*.token",
  "jwt",
  "*.jwt",
  "secret",
  "*.secret",
  "apiKey",
  "*.apiKey",
  "accessKey",
  "*.accessKey",
  "privateKey",
  "*.privateKey",
  "credentials",
  "*.credentials",
]);

type CreateLoggerOptions = {
  destination?: DestinationStream;
  pretty?: boolean;
};

export function createLogger(options: CreateLoggerOptions = {}) {
  const pretty = options.pretty ?? isDev;
  const sanitizer = createLogSanitizer(process.env);
  const loggerOptions: LoggerOptions = {
    level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
    redact: {
      paths: [...sensitiveLogPaths],
      censor: REDACTED,
    },
    formatters: {
      log(object) {
        return sanitizer.sanitize(object) as Record<string, unknown>;
      },
    },
    serializers: {
      // formatters.log حوّل Error بالفعل إلى شكل آمن؛ لا تعِد تمريره عبر serializer
      // الافتراضي الذي يسمي الكائن العادي Object ويفقد نوع الخطأ الأصلي.
      err(value) {
        return value;
      },
    },
    hooks: {
      logMethod(args, method) {
        return Reflect.apply(
          method,
          this,
          args.map((argument) =>
            typeof argument === "string"
              ? sanitizer.redactString(argument)
              : argument,
          ),
        );
      },
    },
    ...(pretty
      ? {
          transport: {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "HH:MM:ss",
              ignore: "pid,hostname",
            },
          },
        }
      : {}),
  };
  return options.destination
    ? pino(loggerOptions, options.destination)
    : pino(loggerOptions);
}

export const logger = createLogger();

export type Logger = typeof logger;
