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

- Use a separate `OPENRIG_HOME=<plugin-data>/instance`.
- Remove the parent seat's `OPENRIG_*` identity/endpoint and `TMUX` context, then explicitly set this instance's HOME/PORT/HOST.
- Bind only to loopback. Report port conflicts as failures; do not silently connect to another daemon.
- The initial daemon launch uses `--no-kernel`. No selected agent is required.
- Seat queries require this instance's daemon state. Do not fall back to querying another instance on the default port.
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

## 9. One panel, preparation and dashboard

Contribute exactly one sidebar panel, `openrig`, titled **OpenRig for Orca**. Its HTML document has exactly two internal tabs: **OpenRig Preparation** and **OpenRig Dashboard**. There are no separate topology/example panels, nested frames or new browser tabs for plugin navigation. Keep operation drafts and the pod viewer mounted across view changes. Navigation invalidates pending reviews, never executes a command and remains available during read-only discovery; an in-flight operation locks navigation.

Preparation contains environment/provider/daemon setup, paths, examples, new-team launch and the separately labelled advanced terminal console. Dashboard selects native rig/pod identities and displays the selected pod's observed membership and explicit single-seat/task/message operations. Orca workspaces are secondary result-terminal destinations, never rig/pod identities. Result and seat terminals remain deliberate Orca terminal views.

Read projected native inventory without cleanup, transcript/resume payloads or inferred namespace prefixes. Default observation uses the effective HOME's local TUI daemon record; plugin-configured/custom instances remain explicit alternatives. Never silently retarget writes: a different observation keeps operations locked until the user explicitly changes plugin-owned routing. Recheck the observation key before that setting change and bind scoped reviews/views to both instance and rig/pod identity. Existing-home connections must not expose managed daemon start.

Unavailable, malformed, truncated and oversized observations are unknown, never an empty list or example fallback. Do not automatically select a pod. Refreshing/changing pods invalidates pending reviews and recipients; fresh native membership is checked again before execution. Show a timestamp and distinct status/activity/attention; do not infer working/healthy/completed from running. Diagrams show observed membership without inventing unqueried edges, roles, cwd or effective permission settings. Keep optional local YAML inspection explicitly labelled and collapsed by default; entering it invalidates reviews and locks pod operations/views until native inventory is restored. The separate static YAML development page is not a registered panel or the default Dashboard data source.

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
