export const STOREFRONT_SHELL_CHUNK_GLOB: string;

type WorkboxUrlMatchInput = {
  request?: Pick<Request, "method">;
  url: Pick<URL, "pathname">;
};

export function storefrontPublicImageCacheMatcher(
  input: WorkboxUrlMatchInput,
): boolean;

export function storefrontPrivateImageNetworkMatcher(
  input: WorkboxUrlMatchInput,
): boolean;
