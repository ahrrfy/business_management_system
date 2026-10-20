# Static font 503 during production acceptance

At 2026-10-19T18:54:17.722Z the production request for
`/fonts/cairo-latin-500-normal.woff2` returned 503. Its worker logged
the storefront load-shedding lane at 418ms event-loop lag. The workers remained
online with unchanged restart counters and no observed OOM. That acceptance
window failed and its original evidence remains retained.

The code placed general static serving after the overload guard. `/assets/`
was exempt, while fonts and `/manifest.webmanifest` were classified as storefront
requests on the public hostname and rejected above 300ms before their local
files could be served. A concurrent official deployment is established by live
processes, locks and timestamps. Its causal contribution to the historical lag
has not been established; this repair does not claim a historical CPU stack.

`createRuntimeStaticAssets` now serves only the fonts namespace and exact
manifest route before the guard in the existing non-development bootstrap.
Existing host restrictions, security middleware and rate limiting remain ahead
of it. The public root is the same runtime directory used by late static serving.
Unhashed files retain `Cache-Control: no-cache`, HEAD and conditional file
handling. Missing files, directories, malformed/traversal requests and writes
terminate locally instead of entering SPA/SEO rendering. Unexpected file errors
still reach the normal error handler. The early fonts response bypasses general
compression; WOFF2 is already compressed. The existing late static middleware
and hashed asset cache policy are unchanged.

No API lane, pressure threshold, memory limit, authentication, SQL or nginx
configuration changed. Dynamic product images still pass the overload guard.
This prevents this particular load-shedding rejection of local assets; it does
not guarantee a response during process failure or eliminate every source of lag.

The Node 20.20.2 local HTTP fixture reproduced six failing assertions against
the original serving order, including font and manifest HTTP503. After repair,
nine static-router tests and 21 existing overload/priority tests pass. They cover
the observed font, HEAD, manifest, missing files, methods, directories, dotfiles,
encoded traversal, malformed paths, bootstrap order, dynamic image shedding,
and the unchanged critical cashier threshold. Fixtures contain synthetic bytes
and invoke no production or financial transactions.

Release remains gated on independent review, normal type/guard checks, green
CI for the exact PR head and resulting main push, and the official deployment.
Production verification must prove this bootstrap/module in the runtime
sourcemap, the existing qualified search sources and memory configuration,
assets across both domains, successful ordinary probes and actual read traffic,
then at least 15 minutes of stable workers/MySQL without 503, lag warnings or
OOM. Earlier failed windows must remain visible. D1 qualification remains blocked
until production acceptance succeeds.
