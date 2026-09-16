# Design QA — Super Arabia experience upgrade

- Selected visual source: `C:\Users\alara\.codex\generated_images\01a08268-2760-7303-b976-19d727123cf5\exec-b164e063-3df5-4ebf-a264-8bfee87977d5.png`
- Generated storefront asset: `C:\Users\alara\.codex\generated_images\01a08268-2760-7303-b976-19d727123cf5\exec-7b78557d-8a8a-4949-a0c1-89fae89a57bb.png`
- Native implementation screenshots:
  - `C:\Users\alara\.codex\visualizations\2026\09\08\01a08268-2760-7303-b976-19d727123cf5\experience-upgrade-owner-native.png`
  - `C:\Users\alara\.codex\visualizations\2026\09\08\01a08268-2760-7303-b976-19d727123cf5\experience-upgrade-my-day-native.png`
  - `C:\Users\alara\.codex\visualizations\2026\09\08\01a08268-2760-7303-b976-19d727123cf5\experience-upgrade-work-native.png`
  - `C:\Users\alara\.codex\visualizations\2026\09\08\01a08268-2760-7303-b976-19d727123cf5\experience-upgrade-account-native.png`
- Native task-detail state: `C:\Users\alara\.codex\visualizations\2026\09\08\01a08268-2760-7303-b976-19d727123cf5\experience-upgrade-work-task-native.png`
- Native completed-task state: `C:\Users\alara\.codex\visualizations\2026\09\08\01a08268-2760-7303-b976-19d727123cf5\experience-upgrade-work-completed-native.png`
- Four-screen board: `C:\Users\alara\.codex\visualizations\2026\09\08\01a08268-2760-7303-b976-19d727123cf5\experience-upgrade-four-screens-native.png`
- Same-input reference/implementation comparison: `C:\Users\alara\.codex\visualizations\2026\09\08\01a08268-2760-7303-b976-19d727123cf5\experience-upgrade-owner-comparison.png`
- Viewport: Android emulator at 1080 × 2400 px, portrait; web preview constrained to a 480 px mobile shell.

## Comparison history

1. Kept the selected photographic navy/coral direction and rebuilt the information hierarchy around one clear action, readable operational context and quieter supporting detail.
2. Added explicit loading, empty, offline, error, success and pending states so the user always understands what happened and whether a change reached the server.
3. Added reduced-motion-aware reveals, progress motion and active-tab feedback; motion communicates state and never blocks task completion.
4. Native inspection exposed bottom labels too close to Android gesture navigation. The tab bar now derives its height and bottom padding from the real safe-area inset.
5. Verified the employee task lifecycle on Android: open task, add context, start, complete, update counters and show an explicit local-preview success state.
6. Re-captured all four routes after the safe-area fix and compared the owner route with the selected visual target in one review image.

## Final inspection

- The selected hierarchy, imagery, indigo/coral palette, RTL composition, typography, density, borders, radii and CTA treatment remain visually coherent.
- Owner: live-source health semantics, operational metrics, one primary review action and independent-device verification before completion.
- My Day: shift progress, location and sync proof, attendance CTA, correction/permission shortcuts and pull-to-refresh.
- Work: actionable task groups, approvals empty state, detail sheet, comment/attachment affordances and a complete local task lifecycle.
- Account: grouped work, document and security services with privacy-first disclosure and trusted-device context.
- The preview safety strip deliberately remains visible so mock data and local-only changes cannot be mistaken for production actions.
- Four-tab RTL navigation, refresh behavior, bottom sheets, safe areas and Android gesture navigation were visually verified at 1080 × 2400 px.
- Android log review found no JavaScript exception or fatal crash; only React Native development-reload soft exceptions were present.
- P0 issues: 0
- P1 issues: 0
- P2 issues: 0

final result: passed
