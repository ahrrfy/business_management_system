export function dispatchManualCameraEntry(
  code: string,
  lifecycle: {
    deliver: (code: string) => void;
    stopMedia: () => void;
    manual: (code: string) => void;
    hasManualOverride: boolean;
  },
): void {
  if (!lifecycle.hasManualOverride) {
    lifecycle.deliver(code);
    return;
  }
  lifecycle.stopMedia();
  lifecycle.manual(code);
}
