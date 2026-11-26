# OpenRig for Orca — v0.1 Integration Contract

## 1. Goal and scope

Starting with Orca and no OpenRig installation, install the plugin, prepare its dependencies, and inspect and interact with OpenRig teams and seats through one Orca plugin panel and its terminal views.

**tmux remains required.** Orca replaces the visualization and workspace roles of Herdr/cmux/Ghostty and separate terminal apps. It does not reimplement or replace OpenRig orchestration, seat identity, or the tmux execution backend.

Responsibilities:

| Component | Responsibility |
|---|---|
| Orca | Workspaces, panels, terminal tabs, and views |
| Plugin | Environment discovery, installation/execution plans, CLI integration, and logical seat-to-view connection records |
| OpenRig | Teams, tasks, messages, seat lifecycles, and recovery |
| tmux | Persistent terminal execution and attachment/reconnection |

Non-goals: removing or making tmux optional, reimplementing agent SDKs, migrating credentials, forking OpenRig, automatically stopping or recovering existing teams, default permission bypass, and remote host provisioning.

## 2. Dependency contract

1. Node/npm: Prefer Node near the main agent and on the existing PATH. Reuse only compatible host runtimes. nvm is not required; do not source or edit shell startup files. Do not assume Electron's embedded runtime has the same ABI as ordinary Node. Provide installation guidance and executable overrides when compatible Node is missing.
2. OpenRig: Discover an existing compatible installation or download and install official `@openrig/cli@0.7.13` into a plugin-private prefix. Do not overwrite external installations or change global prefixes.
3. tmux: Check PATH, standard locations, and explicit overrides, then verify execution with `-V`. If missing, prepare an installation through an existing OS package manager or provide official manual guidance. There is no tmux-free fallback backend.
4. Agents: Offer Claude Code, Codex, both, or configure later. Do not install or authenticate unused providers. Reuse the selected CLI's authentication status and compatible existing configuration paths.
5. Herdr/cmux/Ghostty/other terminal apps: Not required. Use Orca terminals for installation, sign-in, and seat views.
6. Homebrew: Reuse it when present. Otherwise, offer MacPorts or official manual installation guidance. Do not install Homebrew automatically.
7. curl/jq/git: Reuse paths found in the existing environment, but do not fail the universal readiness gate when they are absent. Use Node's JSON/HTTPS facilities for core plugin operations.
8. SQLite: Install it as an OpenRig Node dependency and **verify in-memory database creation, a query, and closure with the selected Node**. Do not require a separate database server or sqlite3 CLI.
9. gh/Docker: Optional. Requirements imposed by a selected spec or project apply to that operation, not to the plugin universally.
10. Windows: OpenRig's own WSL2 support is distinct from this plugin's remote/WSL integration. v0.1 supports local macOS/Linux only and explicitly refuses execution on other hosts.

## 3. State model

- `dependencies-missing`: Node, tmux, an executable rig, or verified SQLite is missing.
- `installed-agent-deferred`: Required infrastructure is ready and the provider is `none`. **Installation is complete, but agent execution is not ready.**
- `agent-setup-required`: A provider is selected, but its CLI or authentication is missing.
- `ready`: Infrastructure and authentication checks for the selected providers passed. This does not mean a daemon or team is running.

Verify daemon readiness and actual seat execution separately. Unknown, failed, or truncated observations must not be interpreted as success or an empty team.

## 4. Installation and execution consent

- Opening a panel or activating a worker must not install software, sign in, or start a daemon/team. Explicitly preparing a verified launch may create a private bundle and review record; disclose those writes.
- The user **explicitly selects a local destination workspace**. Never silently substitute local execution for a remote workspace.
- Mutations follow `prepare -> review -> confirm -> Orca terminal -> recheck`.
- Plans disclose the official source, exact command, write scope, and side effects.
- Confirmation accepts only the ID of a plan stored by the worker. No API accepts an arbitrary shell command from a panel.
- Only after consuming confirmation, save the exact command as a new private script with mode `0600` under `<plugin-data>/actions/`. Send a short invocation within Orca's 4096-character terminal-command limit, and disclose the script's write scope in the plan.
- Plans expire after five minutes and are single-use. Configuration changes, destination changes, or worker restarts require a new plan. After an ambiguous terminal-creation response, inspect the existing terminal before preparing another execution.
- Terminal creation is not proof of operation success. Inspect and reverify the result.
- Retain existing 1Password npm integration where configured; never bypass its approval.
- Leave sudo, sign-in, warnings, and potentially billable model execution decisions to the user.

## 5. Daemon and instance boundaries

- Use a separate `OPENRIG_HOME=<plugin-data>/instance` for managed setup. A reviewed existing-home start uses that exact selected home and its verified native database.
- Remove the parent seat's `OPENRIG_*` identity/endpoint and `TMUX` context, then explicitly set this instance's HOME/PORT/HOST.
- Bind only to loopback. Report port conflicts as failures; do not silently connect to another daemon.
- The initial daemon launch uses `--no-kernel`. No selected agent is required.
- Observation reads use the explicitly selected instance and require that instance's daemon record. Never fall back to a different endpoint. Seat and message operations keep their separate configured routing until the explicit plugin routing action changes it.
- `OPENRIG_HOME` alone does not isolate provider settings or personal skill paths. Execution plans disclose OpenRig's independent configuration, trust, hook, and project-file writes.
- Changing account or executable paths does not automatically change an existing daemon's environment. Applying the new environment requires a separate explicit lifecycle operation.

## 6. Teams and seat views

- Read only supported observation fields through `rig ps --nodes -A --json --no-cleanup --fields ...`. Native 0.7.12/0.7.13 do not support a cwd projection: leave it unverified, never request an unsupported field that prevents all seat reads. Do not request resume-token or credential payloads.
- Native seat identity is `(instance key, rigId, logicalId)` and pod grouping is `(instance key, rigId, podId)`. Orca view/recovery identity also includes the destination workspace ID; that workspace never becomes the managed rig/pod identity. An occupant's tmux session name is not a permanent identity.
- Refresh the list before opening a view and use the current canonical session. Do not automatically restart a seat that is not running.
- Run `rig terminal attach [--read-only] -- <canonical-session>` in a new Orca terminal. Let OpenRig select its own tmux server.
- Do not execute arbitrary shell strings such as a `tmuxAttachCommand` supplied in JSON.
- Views default to read-only. Each click opens a separate view. Never type an attach command into an existing agent terminal.
- **Closing a tab/view is not stopping a seat or shutting down a team.** Plugin unload and UI reload also must not terminate teams.
- Verified team execution requires an absolute local YAML spec. Export library specs first. Freeze declared specs/resources through the supported OpenRig assembler, verify the archive and display its runtime/model/permission declarations.
- Clearly label native/model/host uncertainties. When present, require `ACCEPT UNVERIFIED SETTINGS` before `LAUNCH`; never present declared posture as verified OS enforcement.
- Preview and execution use the same private archive, not the mutable source path. Check its hash and the review expiry before preview and again before launch. Changed or expired inputs require another review.
- Do not add `--yes`, permission bypass, automatic model changes, or an extra kernel launch. These controls do not protect against a malicious process controlling the same user account.

## 7. Authentication contract

Reuse an existing environment for the same CLI and explicit CODEX_HOME/CLAUDE_CONFIG_DIR paths. Do not retain authentication-check output in panels, logs, or plugin storage. If the host API cannot export Orca-managed accounts, explain that limitation. Do not convert Orca logins/API keys into other CLI logins or copy secret files.

## 8. Acceptance criteria

Automated checks:

- Compatibility, paths, shell quoting, parent-identity removal, and SQLite validation.
- Installation can finish without optional tools or an agent.
- Single-use plans, expiration, invalidation after changes, and remote-host refusal.
- UI rendering for first installation, deferred agent setup, readiness, errors, and no available workspace.

Real sandbox Orca integration:

1. Use a temporary staged plugin outside the source tree and an independent Orca profile.
2. Download OpenRig through the plugin installer into a fresh private prefix.
3. Verify Node, real SQLite, and tmux.
4. Start a daemon without an agent.
5. Run a terminal-only fixture without a model or login, then read its seats.
6. Attach read-only in an Orca PTY and verify the fixture's output.
7. Confirm the tmux seat stays running after closing the view.
8. Clean up task-owned teams, daemon, plugin, terminals, and independently verified processes.

Actual billable Claude/Codex execution, Linux package-manager installation, Orca account export, remote connectivity, hosted CircleCI execution, and pixel-baseline UI regression testing are separate acceptance scopes. Never report unverified behavior as complete.

## Read-only Live Pi timeline

Dashboard can explicitly follow one selected local Native Pi seat without a result workspace. Bind the read to the exact instance, pod, seat, occupant, runner launch, file identity and JSONL header using the same Native resolver as Pi HTML snapshots. Never infer another file from a directory, cwd or timestamp. Hold only a short-lived, per-panel reader and cursor. Keep the database and durable Native node pinned while the binding or runner identity is pending. Once the database token, runner and JSONL header agree again for that same node, reset the timeline and follow the verified history. A changed instance, database, durable node, runtime or lease ends the view rather than retargeting it.

Read a bounded recent tail and poll for newly completed JSONL records only while the panel is positively visible. Revalidate identity before returning additional content. Only the read-only display projection crosses the panel bridge. Show recorded write order, not active-branch reconstruction or runtime token events. Map the display projection to the bundled pi-esp Native Chat view: only user messages are bubbles, replies are inert inline Markdown, consecutive tools are grouped, and results update by call ID without rebuilding existing rows. Preserve scroll and disclosure state. Ship the pinned pi-esp browser view and notices only, not the pi-esp CLI, server or reader. Reuse Orca’s public theme variables and attribute the small adapted prompt layout to its pinned Orca source; no Orca chat runtime is embedded. A hidden panel stops reading and discards the view; resuming requires an explicit action. The separate HTML snapshot flow is unchanged.

## Explicit Pi HTML observations

A selected Native Pi seat may be reviewed and exported as a fixed HTML snapshot, then opened by the official Orca CLI in the exact local destination workspace/default built-in browser profile. No global permissions/settings or manifest grants change. The original RPC agent is never resumed, prompted, stopped or restarted.

Resolve only the selected instance/rig/pod/canonical seat from fresh projected inventory and read-only Native SQLite metadata. Match its current occupant and exact Pi file token to its account-switch-aware runner sidecar and JSONL header; missing/ambiguous/personal/changed paths fail with no directory scan or cwd/latest fallback. Freeze the source identity into a one-use review and recheck around a bounded stable-prefix snapshot. Copy only complete records; disclose an incomplete append tail and reject rewrites/corrupt complete records.

Use supported Pi --export against the private copy with isolated HOME, not the original history. Final HTML remains private and bounded, displays snapshot time/session identity, is sandboxed/offline with sanitized untrusted Markdown, and never exposes a directory server or uploads content. Browser failure preserves the same artifact for an explicit reopen, not re-export. No automatic export or history watch is allowed.

## 9. One panel, preparation, dashboard and messages

Messages create Native queue requests through the shared reviewed task path, with a fixed random ID, declared orca-gui@external source, exact destination and exclusive confirmed body file. Native default nudges deliver work, including to busy running agents; no second rig send or agent-side self-registration is requested. A short completion note names the existing qitem and asks for truthful state, short result summary and full resolution. User input remains a bounded 2000-character single line; the generated title/body fit Native task bounds. The concise review exposes the ID, message and completion note. Manual request checks verify immutable identity/source/body despite mutable summaries, and may return at most 16 KiB UTF-8 of the original stored resolution as inert text. There is no reply polling or synthesized result. The same source/destination permits Reports for you to read the resolution. Existing expiry, routing, one-use and ambiguous-outcome guards remain.

Contribute exactly one sidebar panel, `openrig`, titled **OpenRig for Orca**. Its HTML document has exactly three internal tabs, left to right: **Preparation**, **Dashboard**, **Messages**. Keep routine views focused on controls and current state. Show the tmux/session-lifetime note only on the opening Preparation screen; keep operation-specific risks with their reviews. There are no separate topology/example panels, nested frames or new browser tabs for plugin navigation. Keep operation drafts and the pod viewer mounted across view changes. Navigation invalidates pending reviews and never executes an operation; opted-in read-only observations may resume only when the Dashboard is visibly active. Navigation remains available during read-only discovery; an in-flight operation locks navigation.

Preparation contains environment/provider/daemon setup, paths, examples, new-team launch and opening the successfully observed instance in its reviewed TUI. Dashboard selects native rig/pod identities and displays observed membership, seat-start reviews, stored reports and durable-task registration. Messages contains the mounted guarded message form, selected native instance/pod/recipient context and result-workspace picker; it does not infer targets or send on navigation. Source/recipient/message drafts persist, reviews are invalidated on tab changes, and automatic observations pause outside Dashboard. Orca workspaces are secondary result-terminal destinations, never rig/pod identities. Result and seat terminals remain deliberate Orca terminal views.

Read projected native inventory without cleanup, transcript/resume payloads or inferred namespace prefixes. Default observation uses the effective HOME's local TUI daemon record; plugin-configured/custom instances remain explicit alternatives. Never silently retarget writes: a different observation keeps operations locked until the user explicitly changes plugin-owned routing. Recheck the observation key before that setting change and bind scoped reviews/views to both instance and rig/pod identity. Preparation alone selects the observed source and may prepare a review for that exact daemon. An existing-home selection is not implicit permission to use the managed-daemon action.

Unavailable, malformed, truncated and oversized observations are unknown, never an empty list or example fallback. Do not automatically select a pod. Refreshing/changing pods invalidates pending reviews and recipients; fresh native membership is checked again before execution. Show a timestamp and distinct status/activity/attention; do not infer working/healthy/completed from running. Diagrams show observed membership and native-reported directed same-pod relationships through compact whoami reads without runtime-token/transcript-content requests. Deduplicate incidence, verify instance/rig/pod/seat identity, count omitted outside-pod endpoints, and preserve unknown/partial states for failed or sessionless members. Only complete successful selected-seat reads may report zero relationships; do not infer communication, work or completion from a stored edge. Roles, cwd and effective permission settings remain unverified. Keep optional local YAML inspection explicitly labelled and collapsed by default; entering it invalidates reviews and locks pod operations/views until native inventory is restored. The separate static YAML development page is not a registered panel or the default Dashboard data source.

### Instance-bound daemon-only start

Preparation has the single observed-instance selector (`tui` or `configured`); Dashboard displays its context and links back to Preparation. Check reads without changing operation routing. Resolve a canonical local home from that choice, never a path from the panel. A missing native record for the default TUI requires a user-entered port. Configured homes use their explicit saved port. Verify an existing home’s standard SQLite file, reject native DB/port mismatches, an apparently live PID, or an occupied/unverified loopback port, and never pick a different target. Only a new managed home may initialize a missing DB. Review fixes the exact source, home, database, port, CLI and Node; confirmation consumes the expiring plan and repeats identity and availability checks before one terminal creation. OpenRig owns native startup locks and conflict refusal. Use `--no-kernel` with the exact DB and endpoint; never bypass a conflict, switch operations, start seats, or retry automatically.

### Instance-bound TUI view

Preparation and Dashboard TUI actions use the same successfully observed instance and require a local destination but no selected pod. Bind canonical home/port/instance key, CLI/Node paths and CLI version into the reviewed plan; recheck the record, executable selection/version and native response before creating the terminal. No fallback, write-routing change, daemon/kernel/agent startup, shared kernel attachment or retry is implicit. Standalone rig tui receives explicit local routing and OPENRIG_NO_KERNEL=1. Dashboard navigation preserves the selected source and does not launch a team.

### Safe one-minute observation refresh

Default OFF, panel-session only. Poll only read-only native inventory and selected-pod relationships every 60000 ms after success; never call mutation/report/provider/account APIs from the loop. Suspend when hidden, visibility unproven, not on native Dashboard, reviewing, operating, doing another read or editing unsaved settings. Combine standard document lifecycle and visibility-tracking intersection; do not invent a private Orca frame event or treat unsupported visibility as true. Abort/discard stale responses on pause/scope change and prevent overlap/catch-up bursts.

Failure/incomplete backoff is 2/4/8 minutes, capped at 8; complete success resets it. Preserve last-good seats/relationships independently with last-success timestamps, stale/partial flags and a one-minute age threshold. Failed observation is not stop/absence evidence. Keep pending reviews/drafts intact; never automatically reconnect or select a replacement pod. Unchanged geometry must preserve SVG identity, zoom, selection and tooltip while updating observation metadata.

### Hub-scoped topology navigation

Project the full snapshot into an overview that stops at nodes with at least 7 distinct non-self `delegates_to` targets. Count targets in the original snapshot, not the current projection. Other relationship kinds and incoming/duplicate edges do not define children or trigger this threshold. Preserve unrelated components and nodes reachable through another open hierarchy path. Condense hierarchy cycles into indivisible components before traversal/root selection; cycle members remain visible together, and a hub in the component stops traversal to later components. Never mutate the observed/declared graph to implement display omissions.

Activating a hub replaces the SVG with a top-to-bottom subdiagram rooted at that hub. Exempt the current root component from the hub stop rule; nested hubs remain navigable boundaries. Omit visible arrows into the focused root and disclose their count rather than letting feedback pull it below descendants. No inline expansion or native operation is implied. Provide Back to main, Previous hub for nested navigation, a scope breadcrumb, accessible mouse/Enter/Space activation, and per-view zoom/scroll/selection restoration. Ordinary node activation still inspects settings.

Keep full-model and navigation state separate. Bind history/cameras to instance/pod and stable seat keys, never agent_N SVG IDs. Identical observations preserve the SVG; changed/reordered observations retain surviving navigation roots. A missing breadcrumb hub resets to main with a visible explanation; new instance/pod or YAML render resets navigation. Dirty source blocks navigation/export. Late Mermaid/preview results cannot overwrite a newer navigation/source revision. Explicitly show visible/total nodes and relationships, nodes beyond hubs/outside scope, boundary links, root-return omissions and observation completeness. Export only the displayed graph with scope/omission metadata, not hidden node bodies. Input safety limits remain 80 nodes and 160 edges; this feature does not silently enlarge data collection or add lazy native reads.

### Last outbound record tooltip

Native DAG node hover/focus may lazily read the seat's sender-filtered outbox. Preview the original body's first 500 UTF-8 bytes, omitting a split final code point; never call this extractive preview an LLM summary, authenticated report, current-occupant proof or acknowledgment. Show recipient, recorded time, delivery state and separate truncation metadata. Do not fabricate a sender/session, scan terminal/transcript output or substitute a task title. Keep bounded-window/unknown states explicit. Use text-only, dismissible tooltip DOM outside the exported SVG, with context-bound memory caching and no automatic agent input.

### Original user-request result reports

The Dashboard exposes manual, read-only cards from stored resolutions on requests assigned to a selected native rig seat. Exact declared external source and canonical destination filters exclude peer handoffs and title-only tasks. Default source labels user@external and orca-gui@external are not authenticated identities. A unique delegation root is offered only for a complete in-pod rig graph; no role is inferred from the spelling lead.

The worker rechecks instance/seat identities, inspects at most 20 compact requests per source (up to four sources) and returns at most 10 plain original resolutions, 16 KiB per body and 500 bytes per card preview. No task mutation, LLM summary, transcript capture/start, delivery claim, evidence traversal or automatic body polling occurs. Native recorded states/timestamps are provenance, not independently verified correctness/authorship. Partial, unavailable and bounded/empty results are explicit.

### Built-in examples

- The example walkthrough topology is `You -> Builder -> Reviewer -> Builder -> You`; it is never substituted for native pod inventory.
- The walkthrough explains the steps without sign-in, commands, or model calls.
- The terminal demo prints prerecorded role descriptions in two real tmux terminal seats. Label it **SIMULATION ONLY**, not actual AI work or message exchange.
- Creating and starting a demo requires an existing daemon and a confirmed plan. It starts no kernel or model.
- Provide separate Claude-only and Codex-only templates. Each creates two AgentSpecs, a RigSpec, role guidance, and a bounded-task fixture in a new private directory. Creation alone must not launch agents.
- Actual template execution requires provider authentication, frozen-input review and a preview in the private example project, explicit acknowledgment of unverified settings, and `LAUNCH` confirmation in the terminal. Use the CLI's existing model configuration; do not pin an arbitrary paid model or permission bypass.
- Do not confuse the reviewer's no-edit role guidance with an OS permission guarantee.
- Example records prove only that a command was issued. Verify success through actual seat observations.
- Stop demo targets only a demo recorded as created by this plugin in the current instance. It must not stop existing projects or other teams, or delete example files.

## 10. Ordinary tests and CircleCI

Ordinary core tests run locally with Node and Git for publication-policy fixtures; they do not require CircleCI. Orca test-kit panel/worker tests and real Orca smoke tests are separate paths.

CircleCI uses managed macOS ARM64 VMs with Xcode 26.4.1 / m4pro.medium. A pinned secret-scanning job must pass first; then run core jobs on Node 22.23.4 and 24.22.1, and a live job on Node 22.23.4. The live job repeats its own core gate and verifies the pinned Orca DMG's checksum, signature, and version. No secret context or provider login is required.

- A Node 24 core pass is not evidence of Apple Silicon OpenRig live support.
- Preserve reports, JUnit, step logs, and captures even on failure. Runner-level validation exceptions must create failed JUnit cases, not only a failed process exit. Clean up CI-owned application downloads after either outcome.
- Do not upload profiles, HOME directories, credentials, private launch bundles, environment dumps or raw secret-scanner reports. Publication checks cover reachable history and the Git candidate set, including untracked first-commit files, and emit locations only.
- Metadata-save or example-refresh failures must not hide a terminal operation that was already accepted; retain its receipt and warn against repeating it.
- Use stable check IDs for no-kernel startup, first installation, both seats, attach/detach, explicit stop, template schemas, panel capture, and cleanup.
- Apply Orca 1.4.258's upstream E2E migration seed **only to a new empty test profile before its first launch**. Do not modify ordinary user profiles, running databases, or TCC. Do not describe it as a public skip CLI option.
- Report local worker reproduction, YAML validation, and real hosted pipeline success separately. Do not automatically push, publish, or change branch protection.
