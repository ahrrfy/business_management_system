import type { Href } from "expo-router";

/** Notification data is a closed destination dictionary, never a URL. */
const DESTINATIONS = {
  center: "/(tabs)",
  "my-day": "/(tabs)/my-day",
  account: "/(tabs)/account",
} as const satisfies Record<string, Href>;

export type SuperAppNotificationDestination = keyof typeof DESTINATIONS;

export function routeForSuperAppNotification(value: unknown): Href | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "version" && key !== "destination")) return null;
  if (record.version !== "1" || typeof record.destination !== "string") return null;
  return DESTINATIONS[record.destination as SuperAppNotificationDestination] ?? null;
}

/** No employee, branch, approval, or record IDs are accepted in an app link. */
export function isClosedSuperAppNotificationDestination(value: unknown): boolean {
  return routeForSuperAppNotification(value) !== null;
}
