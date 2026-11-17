# Validation Results and Reproduction

## Ordinary local tests

Run with Node and Git for publication-policy fixtures, without CircleCI, Orca, tmux, or a login:

```sh
node --test test/*.test.mjs
```

The core suite has **86 tests** covering environment/version/path handling, plan confirmation and expiration, frozen launch inputs and uncertainty acknowledgment, shell quoting, example generation, private action scripts, secret detection/redaction, bootstrap integrity and cleanup, CI failure reporting, onboarding seeds, and the English-only repository text policy.

With Orca installed in a development environment:

```sh
orca plugin types . --json
./node_modules/.bin/tsc --noEmit -p .
orca plugin test . --json
orca plugin check . --json
```

Current automated results:

- Core/parser/controller tests and the retained native-control/worker regression tests pass. The command output supplies the current totals.
- TypeScript strict checking passes.
- Manifest/HTML checks enforce one contributed panel with exactly three internal tabs and inline topology; source/content hashes reject stale viewer builds.
- `plugin check` validates the manifest but does not execute HTML. The old components scenarios are not registered panels or evidence of the current GUI. Actual HTML navigation and rendering are covered separately below.
- The allowlisted staging artifact passed `plugin inspect`. Do not use a source directory containing development node_modules, indexes, or sockets directly as a distribution folder.

## Real Orca integration tests

Validation environment:

- macOS / Apple Silicon
- Orca **1.4.258** / OpenRig **0.7.13**
- Node **22.23.1** for local runs and **22.23.4** for CI-worker reproduction
- tmux **3.8**
- Independent Orca profile, OpenRig instance, HOME, and loopback port
- Coding agent `none`: no Claude/Codex login or model calls

```sh
node scripts/sandbox.mjs --install --approve-plugin --output ci-results/local-live
```

Skip the download using an existing installation:

```sh
OPENRIG_TEST_RIG=/absolute/path/to/rig node scripts/sandbox.mjs --approve-plugin --output ci-results/local-live
```

The following real-app checks passed:

1. Install official OpenRig for the first time **inside an Orca terminal**, using the plugin's installation plan.
2. Create, query, and close a real better-sqlite3 database with the selected Node.
3. Finish installation without an agent and start a no-kernel daemon.
4. Create and run the plugin's Example Window terminal-only topology.
5. Attach read-only to **both Builder and Reviewer seats** in real Orca PTYs and verify their `SIMULATION ONLY` output.
6. Close each view and verify its tmux seat remains `running`.
7. Stop only that team through a separately confirmed **Stop demo** plan.
8. Generate Claude-only and Codex-only examples, then validate **both RigSpecs and all four AgentSpecs** with real OpenRig. Do not launch actual agents.
9. Freeze both real-provider templates with OpenRig's assembler and inspect their declared settings/uncertainties. Verify source-role changes do not alter the archives.
10. Run the frozen-bundle confirmation program against a separate two-seat terminal-only fixture. Preview and launch require the uncertainty acknowledgment; no model runtime is used.
11. Verify there is exactly one registered `openrig` panel. In the same isolated app's read-only browser preview, switch its three internal views, select a diagram node and advance the preparation walkthrough; ensure every mutation remains disabled without a plugin bridge. Capture the actual native HTML panel at 440 px light and 320 px dark.
12. Clean up the test team, daemon, plugin, terminals, and profile-owned desktop/terminal-host processes.

`--install` authorizes official package downloads and install scripts; `--approve-plugin` authorizes the exact test-plugin grants in that disposable profile. `--keep` retains the profile, daemon, and plugin for manual inspection. Ordinary user Orca profiles and agent settings are not directly modified.

`--output` receives only `report.json`, `examples-light.png`, and `examples-dark.png`. Temporary profiles and HOME directories are not uploaded as artifacts. Reports include stable check IDs and versions; missing or duplicate checks, failures, and incomplete cleanup are not treated as passes.

## Live onboarding regression verification

An additional check against the existing local Orca 1.4.258 / OpenRig 0.7.13 instance found two gaps that the original mocks missed:

- The host API returns `identity:wt2:...` workspace selectors, while CLI terminal metadata returns legacy `repo::path` IDs. Direct equality prevented tab recovery. New fixtures use both real wire formats and require exact identity/host/runtime resolution before navigation.
- `rig tui --shared` requires a kernel-owned terminal, but the initial daemon deliberately has no kernel. Dashboard plans now use standalone `rig tui`.

After the fixes, the **actual plugin worker** recovered a previously orphaned terminal and returned `visibility: shown`. One newly prepared/confirmed dashboard plan opened an Orca terminal with a verified tab connection. A rendered-screen read showed the live `EXPLORER` / `TOPOLOGY` dashboard with `no rigs served` (the expected empty instance), rather than a shell error. The existing daemon was not restarted, and no agents or teams were launched. This was a targeted check in the user's current profile, **not a rerun of the disposable full integration suite**.

## Onboarding resolution

A fresh profile's onboarding modal previously obscured captures. The test now follows **Orca's own E2E fixture approach**, seeding `orca-data.json` in a new empty profile before its first launch. It sets `onboarding.closedAt`, records `outcome: dismissed`, and disables telemetry. Existing or nonempty profiles are refused.

**Real light/dark captures were validated on the Orca 1.4.258 release app without computer use.** This is not a general public `--skip-onboarding` CLI option. It is a version-pinned test migration seed that must be revalidated when Orca changes. No running database or TCC permissions are edited.

Actual captures: [light](images/example-window-light.png), [dark](images/example-window-dark.png).

## CircleCI validation boundaries

The managed macOS four-job matrix (secret gate, two core jobs, and one live job) is implemented as described in [CI.md](CI.md).

- Node 22.23.4 core worker passed locally on macOS ARM64.
- Node 24.22.1 core worker passed locally on macOS ARM64.
- Node 22.23.4 live Orca worker passed in a temporary Git snapshot, including first installation, the example, PTYs, templates, cleanup, and JUnit/report generation.
- Pinned Orca ARM64 DMG download, SHA-256, codesign/Team ID, and CLI version checks passed.
- CircleCI CLI configuration validation passed.
- Pinned Gitleaks 8.24.3 and the local candidate scanner completed with no findings against current Git candidates and reachable history. Reports are location-only; raw streams, raw reports and temporary candidate copies are removed.

**These local results are not a hosted CircleCI VM pass.** The implementation has now been committed and pushed to the public repository. The CircleCI GitHub App pipeline/trigger were created after the initial implementation push, so that earlier event was not received retroactively. The enabled trigger has been aligned with the reference's `only-build-prs` preset; see [CI.md](CI.md#connection-and-first-push-diagnostics). Hosted revision `41aa1f4` subsequently passed all four job workloads, including the tmux preflight and live Orca execution, but its test-result upload steps rejected Node's built-in JUnit hierarchy. A green workflow is therefore not proof of successful result ingestion; inspect the individual upload steps. The compatible custom reporter and retained XML artifacts address this reporting failure. The local reproduction records above came from isolated temporary source snapshots.

## Security-review regressions

- Modifying the source YAML and a referenced role after preview still launches the frozen original bytes in an isolated CLI fixture.
- Changing the frozen archive, expiry, a failed preview, missing integrity/permission metadata, or unresolved startup resources blocks launch.
- `LAUNCH` alone cannot acknowledge unknown native settings. Declarations and uncertainties are visible before terminal execution.
- An accepted terminal receipt survives metadata-save and post-execution list-refresh failures, without silently retrying.
- Tilde entries in extraPath are stored expanded.
- Workspace selectors preserve the host's project name, show project/worktree labels, distinguish duplicate names by path (and exact ID for duplicate paths), exclude remote hosts, and submit the original workspace ID rather than display text.
- Runner-level exceptions generate failed JUnit cases; owned application downloads are removed after success or failure, while external installations are untouched.
- Secret-policy fixtures cover ignored versus force-staged credentials, redacted output, and scanner failure paths.
- Ten offline tmux-preflight regressions cover reuse, explicit installation, Homebrew exit 1 with working/broken tmux, missing binaries, verify-only mode, private-session failures, interrupted installs, cleanup failures and CI-only installation. These tests mock commands and do not require tmux or Homebrew. A separate real local tmux 3.8 private-socket probe passed without installing software or touching a personal server.

- Seven JUnit regressions cover CircleCI hierarchy, safe metadata, failure/skip/todo/hook semantics, invalid input, decimal timings, real standalone Node test execution, and a suite whose skipped body never runs. The failing fixture must retain exit code 1 while producing well-formed report structure.

## Native message requests and legacy terminal instructions

Messages are tested through the shared Native queue-create path: one fixed ID, explicit external source, default nudge, a private body file containing the original message and short completion guidance, and no second rig send or self-registration prompt. Busy-agent acceptance, title/body bounds, literal quoting, stopped/retargeted recipients, immutable server plans and ambiguous-result reconciliation are covered. Readback accepts mutable summaries while checking the original body hash and source, rejects mismatches, and bounds stored resolutions to 16 KiB valid UTF-8. The older direct-send API retains isolated literal-argv and idle-target regressions, including the earlier Native 0.7.12/0.7.13 mock-endpoint evidence; it is no longer the Messages UI transport.

These checks do not send to a real agent or prove model acknowledgment/completion. Existing live teams, kernel, account settings and instance selection were not changed. No paid-model smoke run is part of this verification; obtain approval before one. CI monitoring was not resumed.

## Single-seat start and durable task registration

Offline coverage includes never-started registrations without fabricated session addresses; start consent; already-running no-op behavior; model/cwd changes; shell/kernel/unknown targets; busy-agent durable destinations; private exclusive body staging; literal title/body argv; fixed request IDs; and read-only registration checks for matching, missing, changed-content and changed-instance responses. The shared HTML session-controller tests and retained native-control regressions exercise startup acknowledgment and registration snapshots without resubmitting work.

Real OpenRig 0.7.12 and 0.7.13 were each connected only to an isolated mock HTTP server: the generated start command made one single-node launch POST (no subset/fresh/stop/model fields), queue creation made one POST preserving its ID, destination, declared external source and multiline body, and registration readback added no POST. These are native CLI/API contract checks, not live-agent startup or model-work validation. Existing live teams, kernel, accounts and global settings were not modified; CI was not monitored.

## Unified HTML panel and local topology

`test/topology.test.mjs` imports the shipped bundled parser, including under Orca's no-bare-import loader. It covers generated native templates, explicit directed edges, mapping forms, ambiguous cross-pod endpoints, missing declarations, aliases/custom tags/duplicate documents, nesting and size bounds, prototype-shaped keys, label injection, Mermaid-prefixed selection IDs, asset/source integrity, license presence, and a read-only loopback server that refuses private paths and uploads. Rebuild with `node scripts/build-visualizer.mjs` after source or lockfile changes; the integrity test rejects stale generated assets.

The earlier standalone topology HTML was exercised in a fresh isolated Orca browser profile with synthetic local YAML: node selection, zoom, layout redraw, malformed-source clearing, the local File handler, and inert injected HTML/directive/math captions. Resource origins remained loopback-only. The HTML plugin panel was also captured in an isolated Orca 1.4.258 app/profile and temporary folder workspace in wide light and narrow dark sizes. No real team, agent, daemon, kernel, login or model was involved, and the personal installed plugin was not replaced. Screenshots are visual evidence, not a pixel-baseline regression gate.

`test/plugin-state.test.mjs` covers navigation without execution, preserving drafts, invalidating reviews, read-only discovery navigation, startup consent, one-use confirmation, task-ID retention after unknown results, accepted receipts surviving refresh failures and existing-terminal recovery. The native operating-system save dialog and arbitrary third-party RigSpec dialects are not automatically verified. SVG payloads are sanitized; exporting private topology remains an explicit user decision. The standalone YAML projection is not a complete RigSpec validator or AgentSpec resolver. The Dashboard now uses manual native membership snapshots rather than auto-loading that declaration. Selected-pod relationships now use bounded compact whoami metadata. Real-time push updates, atomic graph snapshots and sessionless-seat relationship resolution are not implemented; periodic opt-in observation refresh is covered below.

`test/pods.test.mjs` covers explicit local metadata/port routing, no ambient host fallback, projected pod fields without resume payloads, unknown versus empty inventory, duplicate/missing identities, rig-scoped namespaces and explicit connection keys without native file writes. Controller tests cover selection independent of terminal destination, scoped recipients, review invalidation, observation/operation mismatch locks and no automatic connection. Worker tests reject foreign/reassigned pod members and changed instance keys before creating terminals. The isolated live harness reads its real two-seat terminal demo through `pods.list` and the configured-instance source; browser coverage starts with no example SVG and separately exercises the explicit inventory renderer with that task-owned snapshot. The `topology-layout` check measures rendered node centers in LR and TB order: dropdown values or generated `direction` statements alone are not sufficient. Edgeless rosters use invisible layout-only ranks, not invented relationship edges.

`test/pod-relations.test.mjs` verifies typed directed edges, duplicate incidence, same-pod endpoint mapping, cross-pod omissions, missing sessions, identity mismatch, building/inconsistent observations and changed-instance refusal. A task-owned HTTP server asserts compact GET-only loopback requests without cookies/auth, rejects redirects and oversized payloads, and never serves a transcript. The isolated live suite checks real native compact metadata for its terminal demo and a visible sanitized SVG arrow; its separate edgeless fixture still verifies LR/TB geometry.

Report-preview coverage in `test/seat-reports.test.mjs` and the session-controller tests exercises exact 500-byte UTF-8 boundaries (including escaped non-ASCII fixtures, emoji and BOM), source/destination aliases, wrong identities, sessionless and missing histories, automatic-wake exclusion, partial windows, private-error suppression, lazy cache behavior and stale pod responses. The live harness writes only a task-owned outbox audit fixture (not terminal input), reads its native preview, and checks mouse hover, inert HTML, focus-event handling, Escape dismissal and absence of the body from the SVG. Regression cases keep focus on a clicked/selected node, dismiss on mouseleave, close on click/Enter/Space and reject reopening from a late preview response. Background Chromium may change activeElement without dispatching focus, so the renderer focus event is explicitly dispatched rather than stealing OS focus; real keyboard Tab interaction is not claimed from that check. The installed app updated to 1.4.259 during this work; the end-to-end harness was run against the separately cached, signature-verified pinned 1.4.258 app without changing the personal app or weakening its onboarding guard.

Safe auto-refresh tests use a deterministic injected clock without changing the production 60000 ms interval. `refresh-loop.test.mjs` checks opt-in, 1-minute cadence, 2/4/8-minute backoff/recovery, review/edit/hidden gates, one overdue resume, cancellation and no overlap. `auto-refresh.test.mjs` checks read-only request names, draft/review retention, stale last-good data, independent relationship failure, vanished/changed-instance refusal and late-response disposal. Visibility unit tests cover document/page lifecycle and visibility-tracking intersection with unknown fail-closed behavior. The live browser harness verifies unchanged SVG/node identity, zoom, selection and tooltip preservation, stale metadata without re-render, and conservative suspension for CSS-hidden same-origin frames. These standard frame checks do not claim a private Orca HTML visibility event exists or OS-level occlusion testing on every desktop.

## Hub drill-down regression coverage

`test/topology-view.test.mjs` exercises the pure, non-mutating projection and instance/pod-scoped navigation: the exact 6/7-child boundary, incoming/duplicate/self/unknown-kind edges, nested hubs, alternate shared paths, disconnected components, rootless hierarchy cycles, omitted feedback into a focus root, partial/unqueried observations, empty pod projection, stable keys across reordered UIDs, missing roots and camera reset/restore. Deterministic mixed-graph checks verify visible endpoints, original-edge provenance and node accounting for every focus. Existing bundled-parser, sanitization, asset-integrity and staging checks still apply.

`test/topology-client.test.mjs` executes the actual browser controller bundled with renderer/DOM doubles. Its test-only build runs in a bounded normal Node child (`test/compile-topology-fixture.mjs`), so Orca's strict no-bare-import loader is not relaxed; pure view tests use the shipped bundled parser rather than importing bare YAML. Deferred Mermaid promises deterministically hold membership refreshes and theme redraws while stale click/Enter/Space events or newer metadata arrive. Regressions cover removed hubs, identical seat keys across instance changes, detached/previous-view events, legitimate navigation after a metadata-only update, and complete/partial/unavailable transitions reaching the UI, SVG description and exported SVG after the paused redraw finishes. The doubles do not validate browser layout or sanitization; the real browser checks below cover the shipped renderer separately. They also pause its actual Mermaid promise to verify both stale-click and completeness-update races without timing-dependent sleeps.

With Orca already running, run the synthetic browser checks without installing a plugin or touching a real OpenRig instance:

```sh
npm run build:visualizer
npm run test:topology-browser
npm run test:topology-browser -- --narrow --dark
# Optional --capture prints paths for main, hub and nested-hub screenshots.
```

The runner opens/closes only its own allowlisted loopback preview and browser tab. Shared `scripts/topology-browser-checks.mjs` is also used by the disposable live suite, which requires a `topology-drilldown` report entry. Checks cover actual rendered root/child coordinates, mouse and keyboard-event activation, nested/Back to main navigation, camera restoration, unchanged SVG identity, reordered refreshes, partial markers, scoped SVG export through a cancelled save stub, a vanished hub, changed instance, obsolete render disposal and dirty/new YAML behavior. These tests use synthetic observations, no daemon/agent/model/terminal operations. Programmatically dispatched keyboard events do not claim OS-level keyboard or native save-dialog validation.

## Pi HTML snapshots

`test/pi-html-export.test.mjs` covers exact Native identity (including committed account-switch directories), newer-sibling decoys, non-Pi/personal/missing/ambiguous files, runner/header mismatches, complete-record snapshots, append/rewrite/truncation handling, isolated exporter HOME/argv, original-byte/mtime preservation, export/tool changes, offline sandbox policy, encoded special-character paths and browser failure/reuse without re-export. Controller/worker tests bind the selected observed instance/pod/Pi seat without connecting operation routing, preserve drafts and reject unowned artifacts. The real browser control fixture performs only simulated export/reopen receipts; the Native topology controller has separate explicit-action/YAML/staleness coverage.

For the optional installed-tool smoke (no agents or model calls), set explicit tools and, optionally, an exact local browser destination:

```sh
OPENRIG_TEST_RIG=/absolute/path/to/rig OPENRIG_TEST_PI=/absolute/path/to/pi \
OPENRIG_PI_BROWSER_WORKSPACE=identity:exact-local-workspace \
node --test test/pi-html-export.test.mjs
```

`src/pi-html-worker.test.ts` also verifies successful prepare/execute/reopen through Orca's actual worker loader when the two tool paths are supplied to `orca plugin test`; its mock workspace cannot open an unrelated real browser tab. Both installed-tool smokes create only synthetic managed Pi seats/databases under private temporary directories. It uses the actual SQLite binding, supported Pi CLI export and native Orca file-URL browser, verifies original bytes/mtime, and closes only its own browser page. The opaque iframe intentionally is not readable through the outer page's AX snapshot; screenshot review verifies the rendered tool call/result. The optional smoke is skipped when tool paths are absent; CI does not install/authenticate Pi silently.

## Messages tab

Controller cases preserve message draft/recipient/pod across all three tabs, invalidate reviews on navigation and pause automatic observations outside Dashboard. Successful message and durable-task confirmations clear only the submitted form, preserving the other form's draft. A busy recipient is accepted by send-message but not legacy send-instruction. An ambiguous confirmation retains the original request ID and does not resubmit; manual reply reads reject wrong IDs, oversized bodies and unverified resolution projections. The real 274px/dark browser fixture checks keyboard navigation, adjacent workspace prerequisites, the exact request ID and short completion guidance, then simulates one confirmation receipt and one explicit reply check. Stored reply HTML remains inert. Disposal regressions start with a retained private reply, close during a pending check, then resolve or reject it; no reply, error callback or new read is accepted. Pending outbound previews are also discarded after disposal. Packaging assertions verify the exact project MIT license and security policy are included, with MIT metadata in package.json and the root lockfile entry. The fixture never forwards an actual queue mutation or model call.

## Prominent seat-start controls

Browser controller fixtures select a pod at 274px in dark mode and verify that a highlighted per-seat start section precedes reports and the DAG, with the actual result-workspace picker moved into it. Mismatched operation routing and missing workspace keep buttons disabled with visible prerequisites. A supported stopped Pi fixture receives one primary review button; an unsupported custom runtime gets an explanation instead. Clicking the button produces the exact instance/pod/seat-scoped review, with startup-risk consent still unchecked and confirmation disabled. The fixture bridge never executes a startup or config mutation; real agent launches are not part of this UI check. Existing worker requery/no-op/consent guards remain unchanged.

## Standalone TUI view

Worker cases bind TUI reviews to canonical home/port, source, selected CLI/Node and version; changed daemon records, executable versions and unavailable observed sources fail before terminal creation, without falling back or changing stored routing. Controller coverage checks configured-instance handoff and review without selecting a pod. A shell regression verifies that the per-view socket directory is short, absent during review, exclusively created, cleaned on a failing TUI exit and never overwritten or deleted on collision. The live suite opens the actual standalone rig tui in an Orca PTY against an empty no-kernel daemon, observes its rendered screen, checks that no kernel/agent registrations appeared, closes the TUI and confirms the daemon still responds. Browser fixture controls exercise both visible buttons and the exact reviewed scope without executing through the read-only fixture bridge. This does not validate paid-agent startup or team recovery.

## Stored user-result reports

Unit cases cover exact external-source/destination filters, topology defaults without name heuristics, raw resolutions versus peer/title-only tasks, UTF-8 bounds, failed/partial/empty reads and changed/late contexts. The live suite seeds user and peer completed-request fixtures only in its proven private SQLite database, without queue notifications or agent input. The real worker reads the former and excludes the latter; the browser renders returned plain report cards, source task IDs, disclosure bodies and stale labels outside the SVG, with inert HTML. A separate iframe realm also runs the shipped controller with a read-only test bridge populated from those native fixture results. Actual DOM controls select the pod/seat, issue the exact report request only on Load, retain the expanded original text across roster refresh and failed report reads (also at 274px in dark mode without horizontal overflow), and clear it when source input changes; invalid peer sources never reach the bridge. This is controller wiring coverage, not a claim of a full real-host bridge interaction. Production never reads console logs or starts transcript ingestion.

Security regressions deliberately diverge the checkout from the copied scanner input: a repaired checkout cannot excuse a bad copied digest, and later checkout edits cannot invalidate a genuine copied digest. Missing snapshot evidence cannot fall back to the checkout. The full mocked gate reproduces a checkout repair after candidate copying and must remain blocked.

## Unverified behavior

- Compatibility with Orca/OpenRig/macOS versions outside the pinned hosted and local targets. Hosted workload success and JUnit ingestion are separate acceptance checks; see the reporting history above.
- Real Linux package-manager installation and terminal UI.
- Manual tmux installation on macOS without a package manager.
- Actual Claude/Codex sign-in, paid-agent work quality, and handoffs.
- Operational migration of an existing daemon after account-path changes.
- Orca-managed account export: not provided because the current host API does not support it.
- Remote/WSL host connections: explicitly refused as outside v0.1's scope.
- Full pixel-baseline UI regression testing. Current coverage uses controller/worker tests, retained native-control regressions, isolated browser interaction checks and real HTML panel captures.

## Integration issues resolved

- OpenRig's actual `entries` JSON envelope and truncated-list handling.
- The literal command name required by `op plugin run -- npm`.
- Keeping active sandbox state outside the source tree to avoid development watcher/approval conflicts.
- Orca's **4096-character terminal-command limit**: stage the reviewed command after confirmation as a private `0600` script and pass a short invocation.
- Separating a pure walkthrough module so panels do not import Node-dependent modules.
- Observing macOS `?E (Orca)` exit transitions with bounded waits. Never signal an unproven PID or interpret observation failures as successful termination.
