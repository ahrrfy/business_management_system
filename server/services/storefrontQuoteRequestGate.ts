import type {
  CreateStorefrontQuoteRequestInput,
  CreateStorefrontQuoteRequestResult,
} from "./storefrontQuoteRequestService";

export interface StorefrontQuoteRequestGateDependencies {
  /** قراءة مملوكة ومتحققة الهوية لنفس clientRequestId؛ تسبق token أحادي الاستعمال. */
  findOwnedReplay: (
    input: CreateStorefrontQuoteRequestInput,
  ) => Promise<CreateStorefrontQuoteRequestResult | null>;
  verifyTurnstile: (token: string) => Promise<void>;
  createQuoteRequest: (
    input: CreateStorefrontQuoteRequestInput,
  ) => Promise<CreateStorefrontQuoteRequestResult>;
}

/**
 * ترتيب أمني حاكم لطلب العرض العام: يستعاد الردّ الضائع المملوك أولاً، ثم يتحقق
 * Turnstile أحادي الاستعمال، ثم فقط يُنشأ العميل والطلب والبنود.
 */
export async function createVerifiedStorefrontQuoteRequest(
  input: CreateStorefrontQuoteRequestInput,
  turnstileToken: string,
  dependencies: StorefrontQuoteRequestGateDependencies,
): Promise<CreateStorefrontQuoteRequestResult> {
  const replay = await dependencies.findOwnedReplay(input);
  if (replay) return replay;
  await dependencies.verifyTurnstile(turnstileToken);
  return dependencies.createQuoteRequest(input);
}
