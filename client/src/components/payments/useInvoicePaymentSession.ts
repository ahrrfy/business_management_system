import { useEffect, useState } from "react";

/** Per-tab invoice identity survives reload; users and other tabs keep separate recovery scopes. */
export function useInvoicePaymentSession(ownerId?: number) {
  const key = ownerId ? `advanced-sales-payment-session:${ownerId}` : null;
  const [session, setSession] = useState<{ key: string | null; id: string }>({
    key: null,
    id: "",
  });
  useEffect(() => {
    if (!key) {
      setSession({ key: null, id: "" });
      return;
    }
    let id = "";
    try {
      id = sessionStorage.getItem(key) ?? "";
    } catch {
      /* Live editing still works without storage. */
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      id = crypto.randomUUID();
    try {
      sessionStorage.setItem(key, id);
    } catch {
      /* Browser storage can be unavailable. */
    }
    setSession({ key, id });
  }, [key]);
  const replace = (id: string) => {
    if (!key) return;
    try {
      sessionStorage.setItem(key, id);
    } catch {
      /* Keep the new identity in memory. */
    }
    setSession({ key, id });
  };
  return [session.key === key ? session.id : "", replace] as const;
}
