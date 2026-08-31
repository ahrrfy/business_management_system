export const STOREFRONT_READ_DEADLINE_MS = 12_000;
export const STOREFRONT_CREATE_ORDER_DEADLINE_MS = 30_000;

type RequestTarget = string | URL | Request;

function requestUrl(input: RequestTarget): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function storefrontProceduresFromRequest(input: RequestTarget): string[] {
  let pathname: string;
  try {
    pathname = new URL(requestUrl(input), "http://localhost").pathname;
  } catch {
    return [];
  }
  const marker = "/api/trpc/";
  const index = pathname.indexOf(marker);
  if (index < 0) return [];
  return pathname.slice(index + marker.length).split(",").filter(Boolean);
}

export function storefrontRequestDeadlineMs(input: RequestTarget): number | null {
  const procedures = storefrontProceduresFromRequest(input);
  if (procedures.includes("storefront.createOrder")) {
    return STOREFRONT_CREATE_ORDER_DEADLINE_MS;
  }
  return procedures.some((procedure) => procedure.startsWith("storefront."))
    ? STOREFRONT_READ_DEADLINE_MS
    : null;
}

export function shouldRetryStorefrontCreateOrder(input: {
  path: string;
  attempts: number;
  httpStatus?: number;
}): boolean {
  if (input.path !== "storefront.createOrder" || input.attempts !== 1) return false;
  return input.httpStatus == null || input.httpStatus === 408 || input.httpStatus >= 500;
}

/**
 * يضع مهلة على نقل tRPC نفسه. إعادة المحاولة منفصلة في retryLink، فتُعاد العملية بنفس
 * input — وبذلك يبقى clientRequestId نفسه ولا يمكن أن تتحول مهلة غامضة إلى طلب ثانٍ.
 */
export function fetchWithStorefrontDeadline(
  fetchImpl: typeof fetch,
  input: RequestTarget,
  init?: RequestInit,
): Promise<Response> {
  const deadlineMs = storefrontRequestDeadlineMs(input);
  if (deadlineMs == null) return fetchImpl(input, init);

  const controller = new AbortController();
  const upstreamSignal = init?.signal;
  const forwardAbort = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) forwardAbort();
  else upstreamSignal?.addEventListener("abort", forwardAbort, { once: true });

  const timeout = globalThis.setTimeout(
    () => controller.abort(new DOMException("STORE_REQUEST_DEADLINE", "TimeoutError")),
    deadlineMs,
  );

  return fetchImpl(input, { ...(init ?? {}), signal: controller.signal }).finally(() => {
    globalThis.clearTimeout(timeout);
    upstreamSignal?.removeEventListener("abort", forwardAbort);
  });
}
