const CLOUDFLARE_TEST_SITE_KEYS = new Set([
  "1x00000000000000000000AA",
  "2x00000000000000000000AB",
  "3x00000000000000000000FF",
]);

const CLOUDFLARE_TEST_SECRET_KEYS = new Set([
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);

export type StorefrontProductionIssue =
  | "BARCODE_SECRET_MISSING_OR_WEAK"
  | "TURNSTILE_TEST_SITE_KEY_FORBIDDEN"
  | "TURNSTILE_TEST_SECRET_KEY_FORBIDDEN";

function strongBarcodeSecret(raw: string | undefined): boolean {
  const value = raw?.trim() ?? "";
  return (
    Buffer.byteLength(value, "utf8") >= 32 &&
    !/^(?:change|default|example|placeholder|secret|test)/i.test(value)
  );
}

export function storefrontProductionIssues(
  env: NodeJS.ProcessEnv = process.env,
): StorefrontProductionIssue[] {
  if (
    env.NODE_ENV !== "production" ||
    env.STOREFRONT_ORDERING_ENABLED !== "1"
  ) {
    return [];
  }

  const issues: StorefrontProductionIssue[] = [];
  if (!strongBarcodeSecret(env.BARCODE_SECRET)) {
    issues.push("BARCODE_SECRET_MISSING_OR_WEAK");
  }
  if (CLOUDFLARE_TEST_SITE_KEYS.has(env.STOREFRONT_TURNSTILE_SITE_KEY?.trim() ?? "")) {
    issues.push("TURNSTILE_TEST_SITE_KEY_FORBIDDEN");
  }
  if (CLOUDFLARE_TEST_SECRET_KEYS.has(env.STOREFRONT_TURNSTILE_SECRET_KEY?.trim() ?? "")) {
    issues.push("TURNSTILE_TEST_SECRET_KEY_FORBIDDEN");
  }
  return issues;
}

export function assertStorefrontProductionReadiness(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const issues = storefrontProductionIssues(env);
  if (issues.length > 0) {
    throw new Error(`STOREFRONT_PRODUCTION_NOT_READY:${issues.join(",")}`);
  }
}
