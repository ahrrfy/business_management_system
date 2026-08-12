/**
 * Resolve the HTTP listen host with production-safe defaults.
 * Production must name an interface explicitly; public/LAN binding additionally
 * requires an opt-in so a missing/mistyped HOST cannot bypass the reverse proxy.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  const normalized = host?.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export function resolveListenHost(input: {
  nodeEnv: string | undefined;
  host: string | undefined;
  allowPublicBind: string | undefined;
}): string | undefined {
  const host = input.host?.trim() || undefined;
  if (input.nodeEnv !== "production") return host;

  if (!host) {
    throw new Error(
      "HOST إلزامي في الإنتاج. اضبط HOST=127.0.0.1 خلف reverse proxy.",
    );
  }
  // The bundled Nginx upstream is fixed to 127.0.0.1:3000. Accepting localhost/::1
  // here can validate a deployment that then serves only 502 responses over IPv4.
  if (host === "127.0.0.1") return host;
  if (input.allowPublicBind === "1") return host;

  throw new Error(
    `HOST=${host} ليس loopback في الإنتاج. إن كان الربط العام/LAN مقصوداً اضبط ALLOW_PUBLIC_BIND=1 صراحةً مع جدار ناري مناسب.`,
  );
}
