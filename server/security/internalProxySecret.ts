import { timingSafeEqual } from "node:crypto";

const SECRET_PATTERN = /^[a-f0-9]{64}$/i;
const DUMMY_SECRET = "0".repeat(64);

export type InternalProxySecrets = Readonly<{
  current: string;
  previous?: string;
}>;

type ProxySecretEnvironment = Readonly<{
  INTERNAL_PROXY_SECRET?: string;
  INTERNAL_PROXY_SECRET_PREVIOUS?: string;
}>;

function secureEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function readInternalProxySecrets(
  environment: ProxySecretEnvironment,
): InternalProxySecrets {
  const current = environment.INTERNAL_PROXY_SECRET?.trim() ?? "";
  const previous = environment.INTERNAL_PROXY_SECRET_PREVIOUS?.trim() ?? "";
  if (!SECRET_PATTERN.test(current)) {
    throw new Error(
      "INTERNAL_PROXY_SECRET يجب أن يكون 64 خانة hex عشوائية (openssl rand -hex 32).",
    );
  }
  if (previous && !SECRET_PATTERN.test(previous)) {
    throw new Error(
      "INTERNAL_PROXY_SECRET_PREVIOUS يجب أن يكون فارغاً أو 64 خانة hex عشوائية.",
    );
  }
  if (previous && secureEquals(current, previous)) {
    throw new Error(
      "INTERNAL_PROXY_SECRET_PREVIOUS يجب أن يكون مختلفاً عن INTERNAL_PROXY_SECRET.",
    );
  }
  return Object.freeze({ current, ...(previous ? { previous } : {}) });
}

export function matchesInternalProxySecret(
  supplied: string,
  secrets: InternalProxySecrets,
): boolean {
  const syntacticallyValid = SECRET_PATTERN.test(supplied);
  const candidate = syntacticallyValid ? supplied : DUMMY_SECRET;
  // قارن دائماً خانتي التدوير كي لا يكشف زمن الاستجابة أيّهما طابق.
  const currentMatch = secureEquals(candidate, secrets.current);
  const previousMatch = secureEquals(
    candidate,
    secrets.previous ?? DUMMY_SECRET,
  );
  return syntacticallyValid && (currentMatch || previousMatch);
}
