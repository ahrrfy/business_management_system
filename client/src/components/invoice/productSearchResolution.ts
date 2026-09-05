export type ExactProductResolution = "FOUND" | "NOT_FOUND" | "BLOCKED";

export async function resolveExactBeforeFuzzy<T>(
  resolveExact: () => Promise<ExactProductResolution>,
  readFuzzy: () => T,
): Promise<{ status: ExactProductResolution; fuzzy?: T }> {
  const status = await resolveExact();
  return status === "NOT_FOUND" ? { status, fuzzy: readFuzzy() } : { status };
}
