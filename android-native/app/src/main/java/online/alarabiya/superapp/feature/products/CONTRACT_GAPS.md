# Native products and pricing contract gaps

1. `catalog.adminList` is the only `productsReadProcedure` that returns general product, variant, unit, stock, price, and barcode rows. There is no read-level product detail endpoint. `catalog.getForEdit` and `getForVariantEdit` expose cost and require `productsManagerProcedure`. The native reader therefore assembles detail only from the currently returned page and never escalates to a manager endpoint.

2. `catalog.byBarcode` returns `null` for a miss, while the current Android `TrpcClient.query` accepts object results only. Native exact-barcode lookup uses the real `catalog.adminList` search contract, which searches primary and alias barcodes and always returns an object page. A future transport-level nullable query would allow using `catalog.byBarcode` directly.

3. `priceWaves.applyWave` has no `clientRequestId` or other idempotency key. A network timeout can leave the client unable to distinguish success from failure. Native blocks retry after an uncertain outcome, requires a fresh `priceWaves.list` reconciliation, and then requires a new server preview.

4. `printPricing.*` uses role-only `managerProcedure`. The super-app bootstrap exposes module grants but no operation capability for print pricing. Native exposes this section only to `admin` and `manager`, matching the server and avoiding inferred access from the `products` module.

5. `bundles.setComponents` updates the current recipe. `bundles.previewImpact` reports invoice-line impact, but there is no immutable recipe version attached to historical invoice items. The first native release is read-only for bundle composition and displays the impact count rather than presenting unsafe recipe editing.
