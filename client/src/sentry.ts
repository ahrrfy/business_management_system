import type { Event } from "@sentry/react";

const dsn = (import.meta.env.VITE_SENTRY_DSN_CLIENT as string | undefined)?.trim();
const release = (import.meta.env.VITE_SENTRY_RELEASE as string | undefined)?.trim();

type SentryModule = typeof import("@sentry/react");

function scrubUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    const url = new URL(raw, "https://client.invalid");
    return url.origin === "https://client.invalid"
      ? url.pathname
      : `${url.origin}${url.pathname}`;
  } catch {
    return "[redacted-url]";
  }
}

function scrubFreeText(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return raw
    .slice(0, 2_000)
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/([?&][^=\s&]*(?:token|input|phone|secret)[^=\s&]*=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(?:\+?964|0)?7\d{8,10}\b/g, "[redacted-phone]")
    .replace(/((?:authorization|input|token|secret|phone|cookie)["']?\s*[:=]\s*["']?)(?!\[redacted)[^"',\s}&]+/gi, "$1[redacted]");
}

/** يحذف الهاتف/المدخلات/التوكنات الممكنة من URL وbreadcrumbs قبل مغادرة المتصفح. */
export function scrubClientSentryEvent<TEvent extends Event>(event: TEvent): TEvent {
  const request = event.request
    ? {
        ...event.request,
        url: scrubUrl(event.request.url),
        cookies: undefined,
        data: undefined,
        headers: undefined,
        query_string: undefined,
      }
    : undefined;
  const breadcrumbs = event.breadcrumbs?.map((breadcrumb) => {
    const message = scrubFreeText(breadcrumb.message);
    if (!breadcrumb.data) return { ...breadcrumb, message };
    const method = breadcrumb.data.method;
    const statusCode = breadcrumb.data.status_code;
    const safeData: Record<string, unknown> = {};
    if (typeof method === "string") safeData.method = method;
    if (typeof statusCode === "number" || typeof statusCode === "string") {
      safeData.status_code = statusCode;
    }
    const safeUrl = scrubUrl(breadcrumb.data.url);
    if (safeUrl) safeData.url = safeUrl;
    return { ...breadcrumb, message, data: safeData };
  });
  const exception = event.exception
    ? {
        ...event.exception,
        values: event.exception.values?.map((value) => ({
          ...value,
          value: scrubFreeText(value.value),
        })),
      }
    : undefined;

  return {
    ...event,
    message: scrubFreeText(event.message),
    exception,
    request,
    breadcrumbs,
    user: undefined,
  } as TEvent;
}

const sentryReady: Promise<SentryModule | null> = dsn
  ? import("@sentry/react")
      .then((Sentry) => {
        Sentry.init({
          dsn,
          environment: import.meta.env.MODE,
          release: release || undefined,
          sendDefaultPii: false,
          tracesSampleRate: 0,
          beforeSend: scrubClientSentryEvent,
        });
        return Sentry;
      })
      .catch(() => null)
  : Promise.resolve(null);

export function captureClientException(
  error: unknown,
  context: { ref: string; surface: "app-root" | "route"; componentStack?: string },
): void {
  void sentryReady.then((Sentry) => {
    Sentry?.captureException(error, {
      tags: { ref: context.ref, surface: context.surface },
      extra: context.componentStack
        ? { componentStack: context.componentStack }
        : undefined,
    });
  });
}
