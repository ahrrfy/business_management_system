import { channel } from "node:diagnostics_channel";
import type { TtlCache } from "./ttlCache";

/** Test fixtures remain immediately visible unless the isolated lab explicitly opts in. */
export function storefrontReadCacheEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.NODE_ENV !== "test" || env.RUNTIME_LAB_READ_CACHE === "1";
}

const observations = channel("erp.storefront.read-cache");
type CacheLabel =
  | "index"
  | "suggestions"
  | "candidates"
  | "search"
  | "sold"
  | "categories";
/** No keys or values enter diagnostics. With no subscriber the original cache promise is returned. */
export function storefrontCacheGet<K, V>(
  cache: TtlCache<K, V>,
  label: CacheLabel,
  key: K,
  loader: () => Promise<V>,
): Promise<V> {
  if (!observations.hasSubscribers) return cache.get(key, loader);
  const publish = (phase: string, durationMs = 0) =>
    observations.publish({ label, phase, durationMs, ...cache.snapshot() });
  publish("get");
  const result = cache.get(key, async () => {
    const start = performance.now();
    publish("load-start");
    try {
      const value = await loader();
      publish("load-end", performance.now() - start);
      return value;
    } catch (error) {
      publish("load-error", performance.now() - start);
      throw error;
    }
  });
  return result.then(
    (value) => {
      publish("get-end");
      return value;
    },
    (error) => {
      publish("get-error");
      throw error;
    },
  );
}
