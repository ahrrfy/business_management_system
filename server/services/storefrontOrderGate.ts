import type {
  CreateOnlineOrderInput,
  CreateOnlineOrderResult,
} from "./onlineOrderService";

export interface StorefrontOrderGateDependencies {
  /** قراءة مملوكة ومتحققة الهوية لنفس clientRequestId؛ تسبق token أحادي الاستعمال. */
  findOwnedReplay: (
    input: CreateOnlineOrderInput,
  ) => Promise<CreateOnlineOrderResult | null>;
  verifyTurnstile: (token: string) => Promise<void>;
  createOrder: (
    input: CreateOnlineOrderInput,
  ) => Promise<CreateOnlineOrderResult>;
}

/**
 * ترتيب أمني حاكم: replay الرد الضائع أولاً، ثم Siteverify، ثم الكتابة. بذلك لا يُستهلك
 * token ثانيةً لاسترداد نجاحٍ ملتزم، ولا يصل طلب جديد إلى DB إذا فشل التحقق الخارجي.
 */
export async function createVerifiedStorefrontOrder(
  input: CreateOnlineOrderInput,
  turnstileToken: string,
  dependencies: StorefrontOrderGateDependencies,
): Promise<CreateOnlineOrderResult> {
  const replay = await dependencies.findOwnedReplay(input);
  if (replay) return replay;
  await dependencies.verifyTurnstile(turnstileToken);
  return dependencies.createOrder(input);
}
