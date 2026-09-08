# Camera regression harness

Run `pnpm exec vite --config tests/e2e/scan/vite.config.ts`, then open
http://127.0.0.1:4187/ in a real browser at a phone-sized viewport.

Each barcode button supplies rasterized barcode pixels through a canvas video
stream to the production CameraScanner and real ZXing decoder. PASS requires an
exact decoded string (including leading zeros and internal spaces) and stopped
tracks. Exercise each button once, waiting for its result before the next.

Also exercise native-runtime failure fallback, cancellation during native decode,
cancellation during media acquisition, and reopening after each. Cancellation must
produce PASS without a STALE-READ result. Finally show the capture station and press
its camera button: the scanner dialog must close, the product name must appear,
and claim count must stay at one. The station API link is mocked; no backend or paid
provider is called by this harness.

The complementary database integration test in productStudioService.test.ts
(`opens a scanned owned task outside the first fifty`) checks real barcode lookup,
exact task retrieval, and owner/branch/status isolation beyond the first page.

These checks do not certify physical phone autofocus, camera permissions, lighting,
or a live provider generation. Verify those on the deployed HTTPS site with a real
phone; browser viewport emulation is not physical-device testing.
