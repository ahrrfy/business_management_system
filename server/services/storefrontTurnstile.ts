import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import {
  STOREFRONT_TURNSTILE_ACTION,
  STOREFRONT_TURNSTILE_TOKEN_MAX_LENGTH,
} from "@shared/storefrontTurnstile";

export { STOREFRONT_TURNSTILE_ACTION } from "@shared/storefrontTurnstile";
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 2_500;

export type StorefrontOrderingReadinessIssue =
  | "TURNSTILE_DISABLED"
  | "TURNSTILE_SITE_KEY_MISSING"
  | "TURNSTILE_SECRET_KEY_MISSING"
  | "TURNSTILE_HOSTNAMES_INVALID";

export interface StorefrontOrderingReadiness {
  orderingEnabled: boolean;
  ready: boolean;
  issues: StorefrontOrderingReadinessIssue[];
}

interface StorefrontTurnstileConfig {
  siteKey: string;
  secretKey: string;
  hostnames: ReadonlySet<string>;
}

function readExactHostnames(raw: string | undefined): string[] | null {
  if (!raw?.trim()) return null;
  const hosts = raw.split(",").map((host) => host.trim().toLowerCase());
  if (
    hosts.some((host) => {
      if (!host || host.includes("*") || host.includes("/") || host.includes(":")) return true;
      try {
        return new URL(`https://${host}`).hostname !== host;
      } catch {
        return true;
      }
    })
  ) return null;
  return Array.from(new Set(hosts));
}

export function checkStorefrontOrderingReadiness(
  env: NodeJS.ProcessEnv = process.env,
): StorefrontOrderingReadiness {
  const orderingEnabled = env.STOREFRONT_ORDERING_ENABLED === "1";
  if (!orderingEnabled) return { orderingEnabled: false, ready: true, issues: [] };

  const issues: StorefrontOrderingReadinessIssue[] = [];
  if (env.STOREFRONT_TURNSTILE_ENABLED !== "1") issues.push("TURNSTILE_DISABLED");
  if (!env.STOREFRONT_TURNSTILE_SITE_KEY?.trim()) issues.push("TURNSTILE_SITE_KEY_MISSING");
  if (!env.STOREFRONT_TURNSTILE_SECRET_KEY?.trim()) issues.push("TURNSTILE_SECRET_KEY_MISSING");
  if (!readExactHostnames(env.STOREFRONT_TURNSTILE_HOSTNAMES)) {
    issues.push("TURNSTILE_HOSTNAMES_INVALID");
  }
  return { orderingEnabled, ready: issues.length === 0, issues };
}

export function assertStorefrontOrderingReadiness(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const readiness = checkStorefrontOrderingReadiness(env);
  if (!readiness.ready) {
    throw new Error(`STOREFRONT_ORDERING_NOT_READY:${readiness.issues.join(",")}`);
  }
}

function readStorefrontTurnstileConfig(env: NodeJS.ProcessEnv): StorefrontTurnstileConfig {
  const readiness = checkStorefrontOrderingReadiness(env);
  if (!readiness.orderingEnabled) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "إنشاء الطلبات متوقف مؤقتاً",
    });
  }
  if (!readiness.ready) {
    throw new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message: "تعذّر التحقق الآمن من الطلب حالياً — حاول لاحقاً",
    });
  }
  return {
    siteKey: env.STOREFRONT_TURNSTILE_SITE_KEY!.trim(),
    secretKey: env.STOREFRONT_TURNSTILE_SECRET_KEY!.trim(),
    hostnames: new Set(readExactHostnames(env.STOREFRONT_TURNSTILE_HOSTNAMES)!),
  };
}

/** الإسقاط العام الوحيد: مفتاح الموقع عام بطبيعته؛ لا يصل السر أو قائمة المضيفين للمتصفح. */
export function getPublicStorefrontTurnstileSettings(
  env: NodeJS.ProcessEnv = process.env,
): { orderingEnabled: boolean; turnstileSiteKey: string | null } {
  const readiness = checkStorefrontOrderingReadiness(env);
  return {
    orderingEnabled: readiness.orderingEnabled && readiness.ready,
    turnstileSiteKey:
      readiness.orderingEnabled && readiness.ready
        ? env.STOREFRONT_TURNSTILE_SITE_KEY!.trim()
        : null,
  };
}

interface SiteverifyResponse {
  success?: boolean;
  action?: string;
  hostname?: string;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface VerifyOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  idempotencyKey?: string;
}

async function siteverifyAttempt(
  token: string,
  config: StorefrontTurnstileConfig,
  fetchImpl: FetchLike,
  idempotencyKey: string,
): Promise<{ kind: "verified"; payload: SiteverifyResponse } | { kind: "transient" } | { kind: "rejected"; payload: SiteverifyResponse }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const response = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: config.secretKey,
        response: token,
        idempotency_key: idempotencyKey,
      }),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) return response.status >= 500 ? { kind: "transient" } : { kind: "rejected", payload: {} };
    let payload: SiteverifyResponse;
    try {
      payload = await response.json() as SiteverifyResponse;
    } catch {
      return { kind: "transient" };
    }
    if (!payload.success) return { kind: "rejected", payload };
    return { kind: "verified", payload };
  } catch {
    return { kind: "transient" };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * يتحقق خادمياً من token أحادي الاستعمال. لا يُسجَّل token أو السر إطلاقاً، وإعادة الشبكة
 * الوحيدة تحمل idempotency_key نفسه كي لا تتحول مهلة Siteverify إلى استهلاك مبهم ثانٍ.
 */
export async function verifyStorefrontTurnstile(
  rawToken: string,
  options: VerifyOptions = {},
): Promise<void> {
  const token = rawToken.trim();
  if (!token || token.length > STOREFRONT_TURNSTILE_TOKEN_MAX_LENGTH) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "تحقق الأمان غير صالح — أعد المحاولة" });
  }
  const config = readStorefrontTurnstileConfig(options.env ?? process.env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const idempotencyKey = options.idempotencyKey ?? randomUUID();

  let outcome = await siteverifyAttempt(token, config, fetchImpl, idempotencyKey);
  if (outcome.kind === "transient") {
    outcome = await siteverifyAttempt(token, config, fetchImpl, idempotencyKey);
  }
  if (outcome.kind === "transient") {
    throw new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message: "تعذّر التحقق الآمن من الطلب حالياً — حاول لاحقاً",
    });
  }
  if (
    outcome.kind !== "verified" ||
    outcome.payload.action !== STOREFRONT_TURNSTILE_ACTION ||
    typeof outcome.payload.hostname !== "string" ||
    !config.hostnames.has(outcome.payload.hostname.toLowerCase())
  ) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لم يكتمل تحقق الأمان — أعد المحاولة" });
  }
}
