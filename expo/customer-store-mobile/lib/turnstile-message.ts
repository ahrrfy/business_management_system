export function extractTurnstileToken(message: string): string | null {
  try {
    const data = JSON.parse(message) as { type?: unknown; token?: unknown };
    return data.type === "ALARABIYA_TURNSTILE_TOKEN" && typeof data.token === "string" && data.token.length > 0 && data.token.length <= 2048
      ? data.token
      : null;
  } catch {
    return null;
  }
}
