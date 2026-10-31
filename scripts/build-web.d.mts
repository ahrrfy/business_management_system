export type WebRelease = {
  schema: 1;
  kind: "erp" | "storefront";
  fingerprint: string;
  files: Array<{ file: string; sha256: string }>;
};
export function storefrontRuntimeSources(root: string): Promise<string[]>;
export function webReleaseFingerprint(
  root: string,
): Pick<WebRelease, "fingerprint" | "files">;
export function writeWebRelease(
  root: string,
  kind: WebRelease["kind"],
): WebRelease;
export function readWebRelease(
  root: string,
  expectedKind: WebRelease["kind"],
): WebRelease;
export function buildWeb(): Promise<void>;
