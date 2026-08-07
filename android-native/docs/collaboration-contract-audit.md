# Native collaboration contract audit

Scope: the Compose-only `feature/collaboration` implementation, its repository, and the mounted server contracts inspected on 2026-08-06. This document does not claim an employee-announcements API that the server does not expose.

## Native surfaces

- Adaptive phone/tablet task list and shared task-detail destination.
- Branch-scoped task filtering, keyset pagination, create, assign, claim, wait, resume, resolve, comment, reopen, and cancel.
- Assignee and service-type lookup from the server; selecting a service type applies its default kind/priority without hiding later edits.
- WhatsApp broadcast list/detail/results, audience preview, draft creation, launch, four-eyes approval, pause, resume, and cancel where the server scope is safe.
- No `WebView`, TWA route, browser hand-off, or fabricated/local business state.

## Exact task contracts

| Native operation | Mounted procedure | Permission/lifecycle enforced |
| --- | --- | --- |
| List | `tasks.list` | `tasks` READ; selected `branchId` is always sent; non-elevated users are also owner-scoped by the server |
| Detail | `tasks.get` | READ; native rejects a response whose `branchId` differs from the selected workspace |
| Assignees | `tasks.assignableStaff` | READ; exact branch required |
| Service types | `tasks.serviceTypes.list` | READ |
| Create | `tasks.create` | `tasks` FULL and permitted execution role |
| Claim | `tasks.claim` | NEW and unassigned/self-assigned |
| Wait | `tasks.setWaiting` | NEW/IN_PROGRESS and assignee/elevated |
| Resume | `tasks.resume` | WAITING_CUSTOMER and assignee/elevated |
| Resolve | `tasks.resolve` | IN_PROGRESS/WAITING_CUSTOMER; SUPPORT requires resolution note |
| Comment | `tasks.addComment` | assignee, creator, or elevated |
| Assign | `tasks.assign` | manager/admin; open task only |
| Reopen | `tasks.reopen` | manager/admin; RESOLVED within seven days |
| Cancel | `tasks.cancel` | manager/admin; open task; reason required |

The full task view is intended as the common details destination for both team lists and the compact personal tasks already returned by `superApp.myWorkspace`. The central navigator still needs to route a personal task tap/deep link to this screen with its task ID; duplicating a second personal details implementation is intentionally avoided.

## Exact WhatsApp broadcast contracts

These are external marketing broadcasts, not internal employee announcements.

- Read: `broadcasts.list`, `broadcasts.get`, `broadcasts.results` via `campaigns` READ.
- Authoring: `broadcasts.preview`, `broadcasts.create` via manager/admin + `campaigns` FULL.
- Lifecycle: `broadcasts.launch`, `broadcasts.approve`, `broadcasts.pause`, `broadcasts.resume`, `broadcasts.cancel`.
- Templates: `integrations.templates.list({ statusFilter: "APPROVED" })`.
- Native draft creation always sends `segment.requireOptIn=true`, validates every required template variable mapping, and only maps the server-supported fields `name`, `currentBalance`, `phone`, and `phoneE164`. Customer type, price tier, balance, and RFM criteria stay within the server enums and numeric limits.
- Four-eyes approval is represented in the UI: a creator cannot approve their own pending broadcast.

## Security/scoping decisions

1. `tasks.list` always receives a selected branch. Non-elevated users cannot request a branch other than their bootstrap branch.
2. `tasks.get` does not accept `expectedBranchId` server-side for manager/admin. Native validates the returned branch before exposing it, but the stronger final fix is server-side branch enforcement for elevated direct lookups.
3. `branchScopedProcedure` and `superApp.bootstrap.scope.allBranches` deliberately treat both admin and manager as global readers. Native therefore permits manager-global `broadcasts.list/get/results`. This does not widen writes: `ownBranch`, `assertBroadcastBranchAccess`, and `assertSegmentBranchMatchesActor` restrict manager create/lifecycle operations to the manager's assigned branch; native action policy mirrors that split.
4. Internal employee announcements have no mounted API, permission key, acknowledgement model, or target-audience contract. The app does not relabel WhatsApp marketing broadcasts as internal announcements. This remains a release gap for that requested feature.

## Verification boundary

Unit coverage was added for task lifecycle policy, seven-day reopen, four-eyes approval, date formats, required template variables, exact procedure names, selected-branch requests, direct-task branch rejection, SUPPORT resolution notes, manager-global broadcast reads with branch-restricted writes, and opt-in broadcast payloads.

Gradle was intentionally not run in this isolated batch. Root navigation, application wiring, dependency catalogs, server code, CI, signing, and release artifacts were intentionally not modified. This feature must not be represented as reachable or release-ready until the parent integration wires `CollaborationRepository`, `CollaborationViewModelFactory`, `CollaborationRoute`, branch selection, and the shared personal-task deep link, and the normal Android verification pipeline passes.
