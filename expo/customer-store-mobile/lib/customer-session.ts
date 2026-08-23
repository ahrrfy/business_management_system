import * as SecureStore from "expo-secure-store";

/** مفاتيح SecureStore تقبل الحروف والأرقام والنقطة والشرطة والشرطة السفلية فقط. */
export const CUSTOMER_SESSION_KEY = "alarabiya.customer.verified_session.v1";

export type VerifiedCustomerSession = {
  token: string;
  expiresInSeconds: number;
  customer: { id: number; name: string; phone: string };
};

export async function loadVerifiedCustomerSession(): Promise<VerifiedCustomerSession | null> {
  try {
    const raw = await SecureStore.getItemAsync(CUSTOMER_SESSION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as VerifiedCustomerSession;
    if (!value.token || !value.customer?.id || !value.customer.phone) return null;
    return value;
  } catch {
    try { await SecureStore.deleteItemAsync(CUSTOMER_SESSION_KEY); } catch { /* التخزين غير متاح؛ لا نرمي وعداً غير ملتقط. */ }
    return null;
  }
}

export async function saveVerifiedCustomerSession(session: VerifiedCustomerSession) {
  try {
    await SecureStore.setItemAsync(CUSTOMER_SESSION_KEY, JSON.stringify(session));
  } catch {
    throw new Error("تعذر حفظ جلسة التحقق على هذا الجهاز. أعد المحاولة.");
  }
}

export async function clearVerifiedCustomerSession() {
  try { await SecureStore.deleteItemAsync(CUSTOMER_SESSION_KEY); } catch { /* لا يمنع التنظيف فشل واجهة الولاء. */ }
}
