/** Keeps scanner responses ordered without coupling the picker to transport details. */
export function createLatestBarcodeResolutionGate() {
  let latest = 0;
  return {
    next: () => ++latest,
    isCurrent: (token: number) => token === latest,
  };
}
