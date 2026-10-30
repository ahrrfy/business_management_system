/** Serialize JSON inside an HTML script element without allowing an HTML terminator. */
export function serializeJsonForHtml(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) throw new TypeError("JSON_VALUE_REQUIRED");
  return json.replace(/</g, "\\u003c");
}
