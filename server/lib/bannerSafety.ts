import { TRPCError } from "@trpc/server";

/** لا نسمح للبنر العام إلا بالتنقل داخل المتجر؛ يمنع javascript:/data:/open redirects. */
export function normalizeInternalBannerUrl(value: string | null | undefined): string | null {
  const url = value?.trim();
  if (!url) return null;
  if (!url.startsWith("/") || url.startsWith("//") || url.includes("\\")) return null;
  try {
    const parsed = new URL(url, "https://store.invalid");
    if (parsed.origin !== "https://store.invalid" || !["/store", "/apply"].some((p) => parsed.pathname === p || parsed.pathname.startsWith(`${p}/`))) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

export function assertSafeBannerCtaUrl(value: string | null | undefined) {
  if (value != null && value.trim() !== "" && !normalizeInternalBannerUrl(value)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "رابط البنر يجب أن يكون مساراً داخلياً آمناً مثل /store" });
  }
}
