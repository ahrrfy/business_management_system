export function sendStorefrontPhoneOtp(rawPhone: string): Promise<string>;
export function confirmStorefrontPhoneOtp(code: string): Promise<{ firebaseIdToken: string; phone: string }>;
