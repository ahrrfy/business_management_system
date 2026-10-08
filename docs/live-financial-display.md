# Live financial displays

Financial screens refresh their existing tRPC queries when another user, device, or
background posting changes their data. There is no page reload and no new polling loop.

- `ledgerService.postEntry` queues one invalidation hook per transaction. It fires
  only after `withTx` commits; rollback produces no notification.
- Successful mutations in the financial namespace registry also notify, covering
  pending approvals, manual journals, shift lifecycle, payroll contracts and other
  legitimate changes which do not call `postEntry`.
- The server batches notifications for 400 ms per company and worker. Payloads
  contain branch hints only, never balances, documents or personal details.
  Lifecycle mutations deliberately use a company-wide hint: cross-branch transfers
  and shared customer/supplier balances cannot safely be inferred from the actor's branch.
  Existing authenticated queries remain the authority for permissions and balances.
- One client subscriber uses the existing SSE/BroadcastChannel connection. Changes
  are batched for 750 ms with at least two seconds between refresh starts; continuous
  sales cannot postpone updates indefinitely. Only mounted, enabled financial
  queries refetch. Inactive matching caches are invalidated without HTTP requests.
- Hidden/offline tabs defer refresh until visible/online. SSE reconnection and
  inter-worker bridge recovery request one fresh snapshot, since SSE has no durable
  replay. Changes during a slow read are retained for a subsequent refresh.
  A read already in flight gets at most one repair per event batch, so overlapping
  external requests cannot turn a single event into an endless refresh loop.
- Treasury, return approval portals, reception collections, print POS shift reads
  and offline financial reports no longer poll every 15–60 seconds.

`LiveValue` renders the exact new formatted value immediately and briefly flips the
text using the browser animation API (180 ms). It never interpolates monetary
amounts. Unchanged values, different table records, reduced-motion preferences and
print output do not animate. Numbers keep existing formatting, direction, copy
behavior, links and semantic colors; table cells do not become noisy live regions.

The implementation adds no database reads to publication or idle SSE heartbeats.
Actual updates still execute the existing visible-screen queries, capped and batched
as above; it does not claim that financial aggregation has zero cost. External SQL
edits bypassing application services need a new application event or reconnection.

Validation covers transaction rollback, company isolation, burst coalescing, idle
traffic, active/disabled queries, branch filters, visibility, gap recovery, in-flight
updates, exact monetary text, reduced motion and animation cancellation.
