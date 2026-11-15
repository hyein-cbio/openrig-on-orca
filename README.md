# OpenRig for Orca

**tmux-backed OpenRig, Orca-fronted UI.** An Orca plugin that works without a preinstalled OpenRig. OpenRig retains ownership of team execution and seat lifecycles; Orca provides setup guidance and terminal views.

> Early release `0.1.0`. Real Orca/OpenRig integration has been validated on macOS. Linux installer branches have unit coverage; remote workspaces and native Windows are not supported yet.

## Architecture

```text
Orca native panel / terminal
        |
OpenRig for Orca worker
        | rig CLI
OpenRig daemon + team / seat
        |
       tmux                  <- Required, not replaced
```

- **Required:** Orca `>=1.4.248`, this plugin, compatible Node, OpenRig, and tmux.
- **Agents:** Choose Claude Code, Codex, both, or configure later. Installation and daemon setup can finish without an agent; agent-team execution remains unavailable.
- **Not required:** Herdr, cmux, Ghostty, or a separate terminal app.
- **Optional:** Homebrew, nvm, curl, jq, git, gh, and Docker. Individual features or projects may need them, but they are not universal installation gates.
- OpenRig installation is pinned to **`0.7.13`**. Node 22 and 24 are checked; Apple Silicon Macs require Node 22 under the current OpenRig compatibility guidance.

## Additional Intel Mac entry

The original Apple Silicon implementation and default installation/CI paths remain unchanged. Intel support is an **opt-in additive package**: run `node scripts/stage-intel.mjs` and inspect/install the printed directory. Only that output manifest selects the additional Intel worker; loading this repository root still uses the original worker.

See [Intel installation, preservation contract and verification boundaries](docs/INTEL-MAC.md). Intel-only validation uses `node ci/intel/run-ci.mjs`; it does not replace the existing ARM64 runner. The additional [manual GitHub CI](docs/INTEL-CI.md) targets `intel-mac-lab` and fails with bounded cancellation if the lab does not accept work.

## Load into Orca

On the host running Orca:

```sh
orca plugin validate . --json
orca plugin dev load . --json
```

Because this plugin runs code, Orca returns its requested grants and a **fingerprint for that exact approval request**. Review them, then rerun the command Orca provides with `--approve ...`. Never hardcode a fingerprint or copy one from another installation.

Requested access:

- `trusted-worker`: Runs a separate Node process with your account's permissions. This is not an OS security sandbox.
- `workspace:read`: Lists destination workspaces.
- `terminal:send`: **Creates new Orca terminals and runs commands**.
- `storage:own`: Stores plugin configuration and recent view connections.

The plugin does not request account-secret storage, access to existing terminal output, or automatic agent-launch capabilities. However, a trusted worker itself has your account's file and process access, so approve only source you trust.

The plugin contributes **exactly one Orca sidebar panel: OpenRig for Orca**. Open it with the layers icon or:

```sh
orca plugin open local.openrig-for-orca --panel openrig --environment local --json
```

Inside that one panel are exactly two views:

- **OpenRig Preparation**: tool/daemon checks, installation and account setup, paths, the walkthrough and recorded examples.
- **OpenRig Dashboard**: native rig/pod selection, a selected-pod inventory diagram and seat snapshot, reviewed single-seat starts, instructions and durable tasks. Team creation/launch and the advanced terminal console live in Preparation.

[Earlier dashboard design capture](docs/images/openrig-dashboard.png) · [Preparation capture](docs/images/openrig-preparation.png). These historical, read-only declared-example previews predate native pod selection; they are not current live-inventory evidence.

Topology and examples have no independent Orca panel/tab. Switching the two internal views never installs software, starts an agent/daemon or sends work; opt-in visible Dashboard observations may resume read-only queries. Navigation retains operation drafts and the selected pod, and invalidates an unconfirmed operation review. Read-only discovery does not block access to the dashboard. The HTML, styles, renderer/parser/sanitizer and notices are bundled; rendering needs no CDN or npm installation, but actual pod observations require an explicitly identified running local OpenRig daemon. Live operations retain their existing explicit worker review/confirmation boundary.

Local-folder installation is also available. Its installed copy is separate from the development folder and requires the same code-execution approval.

```sh
node scripts/stage.mjs
# Run the printed inspect/install commands against the temporary staging directory.
```

Use the **staging directory** for local-folder installation. Orca's content inspection is separate from Git's `.gitignore`; packaging a source directory containing development `node_modules` symlinks or local indexes/sockets can fail. The staging script copies only allowlisted runtime files, integrity-listed viewer assets and documentation and refuses to overwrite a nonempty destination. It also rejects stale viewer source/lockfile hashes, so changes cannot accidentally be packaged with an older generated visualizer. For Git distribution, retain the intentional prebuilt viewer assets in `src/visualizer/` with their source/content hashes and licenses. Do not commit generated `.orca/` state, `node_modules`, test profiles or staging folders.

`local.openrig-for-orca` is the local development-folder key. For Git distribution, Orca derives the publisher from the repository owner. The repository is public, but Git installation reads a committed revision, not your local uncommitted work. Use the staged local folder to prepare the current working tree; do not assume local additions are already released.

## Built-in examples: explore a team first

Within **OpenRig Preparation**, expand **Learn with the built-in example**. The walkthrough and templates are part of the same panel, not another Orca tab.

- **Walkthrough:** Explains `You -> Builder -> Reviewer -> Builder -> You` step by step. This simulation runs no commands or models.
- **Terminal demo:** Uses an installed OpenRig and a no-agent daemon to create two real tmux seats. Their prerecorded role descriptions are labelled **SIMULATION ONLY**; they do not pretend to perform AI work or exchange messages. Try opening/closing views and the separate **Stop demo** action.
- **Claude/Codex templates:** Create two agents using the same provider, their RigSpec and AgentSpecs, role guidance, and a small clamp() example project. Existing project files are not overwritten, and creation does not launch agents.
- **Preview real team launch:** After authenticating the selected provider, review a private frozen bundle. The terminal shows declared settings and explicitly unverified native/model/host settings. Acknowledge those with `ACCEPT UNVERIFIED SETTINGS`, then type `LAUNCH`. Model usage may incur charges.

Demo-stop records are bound to the explicit operation home/port as well as the private data root. A record from a different or unknown/legacy instance cannot authorize stopping a team after switching connections; inspect it natively instead of guessing or backfilling ownership.

Example operations use the same shared destination and review card. Their result/seat terminals remain Orca terminal views; they are not additional plugin panels.

## First use

1. Reading pods needs no Orca destination. Before an operation, explicitly select a local workspace under **Result terminal destination** (in Preparation, or the secondary expandable Dashboard section). It uses project/worktree names and Orca's exact workspace ID; labels never change the target.
2. Use **OpenRig Preparation -> Recheck environment** to inspect Node/npm, OpenRig, tmux, and SQLite.
3. Select an installation action for missing OpenRig or tmux. **Review the exact command, source, write scope, and warnings** before running it in an Orca terminal. Opening a terminal does not prove installation succeeded.
4. Inspect the terminal result and recheck the environment.
5. Choose a coding agent and select **Save configuration**. Reuse an available CLI login or open its official sign-in command in an Orca terminal. Choosing `Later` is also valid.
6. For a **new managed instance only**, select **Start daemon · no agents**. Skip this when connecting to an already running TUI instance; managed start is disabled for an existing-home override. No kernel or agent starts automatically. Inspect its terminal, then **Recheck environment**. **Go to OpenRig Dashboard** is internal GUI navigation and never runs `rig tui`. The separate **Advanced · terminal console** operation retains the reviewed standalone terminal TUI path and is disabled until this instance responds.
7. In **OpenRig Dashboard**, use **Refresh pods**, choose an actual rig/pod, and inspect the timestamped snapshot. The default observation source is the default local TUI instance; choose the plugin-configured source for step 6's separate managed instance. If routing differs, explicitly use the observed instance for operations before **Open seat view**. Views default to read-only; disable the checkbox and open a new view if writable input is intended.

Operation buttons prepare a shared **Review operation** card, not an installation or launch. It identifies destination, source, writes, warnings and exact command and requires explicit confirmation. Operation forms are hidden while reviewing. Cancel or change the internal view to invalidate the review. Executing an operation locks navigation until its response; read-only checks do not.

Immediately before execution, confirmed commands are stored as private scripts with mode `0600` under `<data>/actions/`. This accommodates Orca's terminal-command length limit without accepting a command different from the reviewed plan. These scripts contain explicit environment paths and the reviewed command. Instruction plans also contain the entered message, which may be sensitive; never include credentials.

Orca's `terminal.create` receipt does not prove that a tab is visible. After creation the trusted worker uses the same host/profile's Orca CLI to inspect **only that terminal handle**, resolve the host API's identity selector to the CLI's workspace ID, switch to its destination workspace/tab, and verify that it is connected to the renderer. Identity resolution checks the exact instance and local host, never just a matching project path. This may change the workspace you are viewing. It never resends the action or creates another terminal as a visibility fallback. The CLI's terminal metadata can include an output preview; that preview is neither returned to panels nor saved by this check. No additional manifest capability is requested.

The panel distinguishes **Terminal tab connected** from **Terminal created · tab not verified**; neither means the command succeeded. **Show / recover existing terminal** retries only the view connection. A copyable recovery command is provided when the CLI/profile is unavailable; it preserves an explicit `ORCA_USER_DATA_PATH` when present. Recover the existing terminal rather than repeating an installation or launch. Recovery receipts contain only terminal/workspace identity and action title, never terminal output, and are saved in plugin storage. A storage failure keeps the accepted receipt visible but may prevent button-based recovery after a worker restart.

Each Open seat view click creates a separate view. **Closing a tab detaches from tmux; it does not stop the seat.** Stop or recover teams through the OpenRig dashboard or explicit lifecycle operations.

### Dashboard: native rig / pod inventory

The primary **OpenRig pod** selector comes from the native projected seat inventory, not Orca workspaces or the built-in example. Choose a real `rig / pod`; its diagram, seat rows, instruction recipients and durable-task recipients use that exact rig/pod identity. An Orca workspace appears only in the secondary **Result terminal destination** section, and is unnecessary for reading/selecting pods.

Inventory is a bounded observation snapshot from `rig ps --nodes -A --json --no-cleanup --fields …`, with explicit loopback routing and pod ID/namespace fields. No transcript content, resume token, full graph payload, credential file or arbitrary YAML reference is requested. The list represents registered seat groups, as in the TUI's node-backed pod groups; empty declarations without seats are not synthesized. Unassigned seats are labelled as such. Invalid, incomplete, unavailable or oversized observations stay unavailable, not an empty list or an example fallback. Bounds: 512 seats and 128 groups; diagrams cap at 80 seats without truncating the complete selected-pod list.

**Observed OpenRig instance** defaults to the local TUI's `~/.openrig/daemon.json` under the effective HOME. The metadata's local port is pinned; this is not a search of arbitrary hosts. Choose **Plugin-configured instance** for a separate managed/custom instance. If observation and operation routing differ, operations stay locked. **Use this observed instance for operations** rechecks that observation and changes only plugin-owned OpenRig-home/port settings. It does not modify native configuration, start a daemon/kernel/agent or change authentication. Existing-home connections disable the managed daemon-start action. Custom existing homes/ports can also be set explicitly in Preparation.

No pod is selected automatically. Changing pods, refreshing inventory, switching views or changing configuration invalidates an unconfirmed review. Native identity is the rig ID plus pod ID, not a namespace guessed from a logical ID. Reviewed starts/messages/tasks and seat views validate that the target still belongs to the selected pod; fresh-target and one-use consent checks remain in place.

The diagram displays observed membership, runtime/model and separate normalized status, activity and attention scalars with a timestamp. Running does not imply working, healthy or complete. After pod selection, the worker queries each available canonical seat through the native compact whoami endpoint and draws its reported directed same-pod relationships. Four requests at most run concurrently, each bounded to 2.5 seconds and 256 KiB; no transcript endpoint, full graph or credential lookup is used. Duplicate incoming/outgoing reports are merged, not turned into extra lines. Cross-pod endpoints are omitted with a count, never guessed. Missing sessions, failed/mismatched reads, roster construction or inconsistent observations remain partial/unavailable, not evidence of no connection. Zero relationships is reported only after all selected seat queries succeed. The read is not atomic or a real-time push feed; optional periodic refresh is described below. Effective roles/AgentSpecs, cwd and permission guarantees remain unverified. Zoom, fit, LR/TB layout, node inspection and explicit **Save SVG** remain local. Narrow views favor readable vertical scrolling. Exports may contain sensitive topology metadata.

### Topology hub drill-down

The main diagram stops downstream traversal at hubs with **7 or more distinct `delegates_to` targets**. Parent links, duplicate links, self-links, feedback and other relationship kinds do not inflate that threshold. Hubs have a dashed outline and a direct-target label. Click a hub (or activate it with Enter/Space) to replace the diagram with a **top-to-bottom subdiagram rooted at that hub**; this is navigation, not an inline expansion or page reload. The focused hub opens its own downstream structure, stopping again at subsequent hubs. Ordinary nodes still select inspector details.

**Back to main** restores the overview; **Previous hub** returns one level in a nested path. A breadcrumb identifies the current scope. Per-view zoom, scroll and selection are restored on return. Focus views start centered on the root at a readable minimum scale; wide fan-outs use horizontal panning rather than shrinking all labels into a miniature. Navigation uses stable seat keys, scoped to the observed instance and pod; unchanged periodic observations do not redraw the view, reordered/changed snapshots retain a surviving focus, and a missing breadcrumb hub returns to main with an explanation. Changing instance/pod or rendering a new YAML source resets the path. Dirty YAML disables navigation and export until Render applies it.

Only `delegates_to` defines descendants; other observed/declared relationships remain visible when both endpoints are in scope. Shared nodes reached through another open path remain visible, and unrelated components remain in the overview. Hierarchy cycles are treated as indivisible components for traversal: all cycle members remain visible together, with downstream traversal stopping if the component contains a hub. Focus views omit arrows back into their root so it stays above its descendants. Display totals, boundary-link omissions and root-return omissions are explicit, including in SVG title/description metadata; partial/unavailable observations remain distinct from intentional display omissions. The original snapshot and complete seat list are not modified.

This improves navigation **within the existing input safety limits** (80 nodes / 160 relationships); it does not add lazy native queries, raise those limits, or guarantee a small subdiagram for hundreds of direct children. Hub clicks never send work, start an agent or change the selected native pod/operation target. As with other nodes, deliberate hover/focus can still read the existing bounded outbound preview.

### Safe automatic observations · one minute

**Auto refresh · every 1 minute** is OFF by default and lasts only for the current panel session. Once enabled, only the selected native pod is refreshed: the roster read validates its identity, followed by compact relationship reads for that pod. No environment/auth reconfiguration, connection switch, terminal creation, report request, outbox/body read, queue write, agent wake or model call is scheduled.

The healthy interval is 60 seconds after a successful read. Failed/incomplete cycles wait 2, 4 and then at most 8 minutes; successful/manual complete reads reset the delay. Reads never overlap or accumulate catch-up bursts. Open reviews, in-flight operations/other reads, unsaved configuration, YAML preview and non-Dashboard navigation pause the loop. Auto refresh does not clear an open consent review or change a target.

The HTML frame has no documented Orca visibility event. The client combines document visibility/page lifecycle with IntersectionObserver visibility tracking, including ancestor clipping, display:none, visibility:hidden and opacity. Unknown visibility suspends polling rather than assuming the panel is visible. Hidden/disposed frames stop timers, abort the bridge request where supported and discard late responses; an already-dispatched native read cannot be undone, but no further stage is started. On return, an overdue observation runs once, respecting any remaining failure backoff. Unsupported visibility tracking leaves manual refresh available.

Separate last-success times are shown for seats and complete relationships. Failed reads retain the last-good data with a stale/incomplete marker, never infer missing/stopped seats or absent relationships. Data at least one minute old is marked stale even with auto refresh OFF. An instance change stops auto reads until manual inspection; a missing pod never silently selects another. Unchanged node/edge data updates only timestamps/notes, preserving the SVG, zoom, selected node and open tooltip. Outbox previews still load only on hover/focus. Stored request-resolution reports load only through the explicit Reports for you action.

### DAG hover: last outbound record

Hover a native seat node to preview its latest qualifying recorded outbound message to another registered seat. The keyboard focus handler also opens the tooltip; Escape, blur or leaving the node closes it immediately, even if the node keeps focus. Clicking or activating it with Enter/Space closes the tooltip and selects the seat details (hubs also navigate into their subdiagram); a late preview response cannot reopen it. This is the original native outbox body, not an LLM summary or an inferred report. Metadata includes recipient, recorded time and native delivery state; a queued/indeterminate/delivered record does not prove acknowledgment or correct work, and seat history can include an earlier occupant.

The worker inspects at most the latest 20 sender-filtered native outbox entries, excludes explicit automated wake records and external/system/self destinations, and validates sender/recipient identities without guessing aliases. An entry may be a queue notification rather than an authored report; the tooltip labels that provenance instead of treating all output as a report. Missing sessions/history or incomplete windows remain unverified; no terminal/transcript scan or task-title fallback is used.

Only the first **500 UTF-8 bytes** of the original body cross the worker bridge, with incomplete final code points omitted. Byte counts and a separate truncation notice preserve that limit. Hover/focus loads lazily, with at most two panel requests in flight and memory-only caching (30 seconds for a recorded preview, 5 seconds for none/unverified; clear on explicit refresh or selected seat/context changes). No additional LLM, model credentials, provider configuration, report-request message or delivery retry is involved. Message text may be sensitive: it is plain text, is not persisted or logged by the plugin, and is outside Mermaid/SVG exports.

### Reports for you · original user-request resolutions

The Dashboard includes a read-only **Reports for you** section. Choose a reporting seat in the selected native rig and click **Load stored reports**. A unique delegation root is offered only when the complete rig fits the observed pod graph; otherwise choose explicitly. A seat name containing `lead` is not treated as authority.

This view follows the actual native workflow where a coordinator stores its final report in the original external request's `resolution`, rather than reconstructing terminal text or showing its internal peer instructions. It reads exact source/destination-filtered compact queue windows: default declared sources are `user@external` and this GUI's `orca-gui@external`, editable as 1–4 exact external source addresses. Only nonempty stored resolutions become report cards. Task titles are labelled as the original request, never substituted for result text.

Cards show the original title, declared requester, assigned reporting seat, source task ID, native state and record-update time. Expand the plain original resolution to read up to **16 KiB** of valid UTF-8 text (500-byte card preview); truncation is explicit. Inspect at most 20 requests per source and return at most 10 cards, with bounded-window/partial/error notes. Source labels and seat assignment do not authenticate the author or person; an earlier occupant or another actor may have written a resolution. Recorded `done` is not independent verification or proof of delivery to the user. This is not the native delivered-human-notification inbox or a complete message archive.

Reads require a current instance/seat identity and no Orca result workspace. Reports remain memory-only, clear when the rig/seat/source context changes or the session is disposed, and stay outside SVG exports. One-minute observations never fetch report bodies. No new LLM, agent message, terminal capture, transcript-ingest startup, native queue write, evidence-path resolution or command execution occurs. Failed refreshes retain the last successful report snapshot with its original read time and an error marker.

### Renderer and optional declared-YAML preview

The dependency-backed renderer uses pinned **Mermaid 12.3.0**, **yaml 2.9.1** and **DOMPurify 3.4.17**. Generated strict-mode Dagre flowcharts receive an additional SVG sanitization pass. Local prebuilt split ESM assets, integrity/source hashes and third-party notices ship in `src/visualizer/`; rendering needs no npm installation, CDN or online converter. The dashboard never auto-loads a sample or YAML declaration in place of native inventory.

**Optional YAML declaration preview** in the Dashboard is collapsed by default. Explicitly open it to load/paste YAML or a labelled example. Entering that mode invalidates a pending review and locks pod operations/views; **Return to selected pod inventory** restores the native snapshot without changing the selected pod or executing anything. YAML drafts remain in memory across navigation.

A separate **development-only** static YAML inspection page also remains at the preview server's `/topology.html`; it is not another registered Orca panel or a live daemon view. It supports local files/text, declared edges and a labelled example without resolving references or calling a daemon. YAML stays in frame memory; aliases, duplicate keys, custom tags and multiple documents are refused. Limits remain 256 KiB, 16 pods, 80 agents and 160 edges. Invalid source clears the previous declaration; dirty source disables export.

Rebuild after changing authored client/projection/build inputs or the lockfile:

```sh
op plugin run -- npm ci --ignore-scripts
node scripts/build-visualizer.mjs
node scripts/preview-topology.mjs
# / shows the unified panel; /topology.html is the standalone YAML development page.
# Ctrl-C stops this allowlisted, loopback-only static preview.
```

The preview does not install or replace an Orca plugin. Installed HTML panels use Orca's explicit user-gesture SVG save API; a standalone browser uses a normal SVG download. Native OS dialog writes are not inferred from bridge-payload tests.

### Send one instruction to an existing agent

In **OpenRig Dashboard**, select a native pod and use **Refresh selected pod snapshot**, choose an **Instruction recipient**, enter a **Short instruction**, and press **Review instruction**. Review the exact target/text and side effects, then **Confirm and open in Orca terminal**. The existing single-use, five-minute plan runs `rig send --wait-for-idle 1 --json -- <session> <text>` in an Orca result terminal; no TUI typing is needed.

This deliberately small feature accepts one running, explicitly idle Claude Code, Codex or Pi seat without an attention request. An existing Pi seat does not require selecting a new installer/provider or changing its model. Shell/unknown runtimes, stopped/busy/unknown-activity seats, control characters and host-qualified targets are refused. Text is a single line of at most 2000 characters. The worker refreshes the target at confirmation and refuses a changed session/runtime; the native CLI retains its idle and prompt/permission guards. The configured loopback instance is explicit, overriding persisted remote-host selection and legacy URL aliases, without changing global settings.

This is a **terminal message**, not a durable queue item, ownership handoff, acknowledgment or completed task. It may trigger paid model calls and file edits; cwd and the read-only view checkbox do not sandbox the agent's tools. The CLI may display an unknown sender. A created result terminal is not proof of delivery, and a timeout can follow delivery: inspect/reconcile with the recipient before any resend. No automatic retry, seat launch, stop, model change or permission bypass is added. The destination Orca workspace only determines where the result terminal opens.

### Start one registered seat

After **OpenRig Dashboard -> Refresh pods -> Select a native pod**, use **Review seat start** on one stopped/exited/detached or never-started agent row. Registrations with no conversation remain visible as **No session yet**; no session address is invented. The review shows the registered rig ID/logical ID and declared runtime/model/cwd. Acknowledge **I accept unverified native startup settings and possible model costs**, then confirm. This runs only `rig launch --json -- <rigId> <logicalId>` in the result terminal, not an all-seat launch or the separate `--seats` snapshot-restore path.

Running seats are disabled. If another actor starts the seat after review, confirmation returns a no-op and creates no launch terminal. Changes to observable session/runtime/model definitions require another review. Native 0.7.12/0.7.13 cannot project cwd through `ps --fields`; cwd therefore remains explicitly UNVERIFIED rather than breaking all seat queries. Shell, unknown and reserved `kernel` targets are excluded. No fresh occupant, stop, model override, permission bypass or kernel recovery is requested. The review is not a complete first-start preflight: native `--plan` cannot preview a never-started materialized seat. Provider settings, permissions and hooks remain unverified, and startup may incur model costs or edit files. Refresh actual seat status after inspecting the result; opening the terminal is not proof of startup.

### Register one durable task

In **Register one durable task**, choose a running local agent, enter a title (up to 200 single-line characters) and body (up to 4000 characters, LF newlines allowed), then **Review durable task** and confirm. Busy agents are allowed because this is durable work, not a direct typing command. Shell, remote, attention-requesting and reserved `kernel` targets are excluded. Native nudges may invoke models and edit files.

The server fixes a random request ID before execution, stores the body in an exclusive private read-only file after confirmation, and invokes native `rig queue create` once with `--id`, `--source orca-gui@external`, `--destination`, `--summary` and `--body-file`. The source is a declared external label, not an authenticated human or an impersonated seat. No human reply route is guaranteed. An ID or result terminal is **not proof of persistence**. The GUI retains the ID even if confirmation returns an ambiguous error.

**Check task registration** is a manual read-only snapshot. It queries the same configured instance, correlates the saved ID/destination/title/body, and shows verified registration and the recorded workflow state only for a matching row. Changed content requires native-history reconciliation. A missing row, timeout, changed instance or unreadable result remains **unverified**, not definitely absent; the check never creates, nudges or retries. A recorded `done` state is the assignee's workflow record, not independent proof of correct results. Do not create another ID for the same work after an unknown outcome.

### Launch a team (Preparation)

- The shipped `starter` uses both Claude and Codex. For a single provider, use an Example Window template or an adapted local YAML spec.
- Verified launches require an **absolute local YAML spec**. Export library specs locally first. Unresolved library names and remote URLs are not accepted by this path.
- Preparation uses OpenRig 0.7.13's bundle assembler and integrity inspector to freeze declared specs and resources under `<data>/launches/`. No agents start during preparation, but private review files are created.
- Both the panel and terminal show bundle-derived runtime, model and permission declarations. Native defaults and effective host enforcement that cannot be verified are labelled **UNVERIFIED**, not assumed safe.
- The terminal previews that same bundle. When uncertainties remain, type **`ACCEPT UNVERIFIED SETTINGS`** before **`LAUNCH`**. Other input cancels. No automatic permission bypass or model substitution is added.
- Execution uses the frozen archive, not the mutable source YAML. Changing original specs or role files does not change the approved launch. Archive changes or an expired five-minute review block execution and require a new review.
- Native host settings and installed runtime integrations are outside the archive. This is a consent and input-integrity boundary, not an OS sandbox or protection against another process controlling the same user account.

## Paths, accounts, and installation policy

Use **OpenRig Preparation -> Paths and existing configuration** to set absolute paths or `~/...` overrides.

- Default data directory: `~/.local/share/openrig-for-orca/`
- Managed CLI: `<data>/runtime/node_modules/.bin/rig`
- Optionally installed agent CLIs: `<data>/providers/node_modules/.bin/`
- Managed OpenRig state: `<data>/instance/`; an explicit **Existing OpenRig home override** can connect operations to an existing instance without copying it.
- Private frozen reviews and materialization targets: `<data>/launches/`. Treat these as potentially sensitive and never upload or commit them.
- Daemon: loopback `127.0.0.1` only; the default port is `43811`, configurable in Paths.

Discovery checks Node near existing agents and on PATH, then reuses a compatible runtime. It does not automatically install nvm or a new Node, or edit shell startup files. **An embedded Electron runtime is not assumed to be an ordinary Node installation.** If no compatible standalone runtime exists, the plugin links to official Node installation guidance.

OpenRig installs into a private directory rather than a global npm prefix. The plugin does not automatically run `rig setup`, avoiding Herdr installation and changes to personal tmux settings. When `op` is found, npm actions use `op plugin run -- npm ...`. Approve 1Password in the terminal when required; credentials are neither extracted nor bypassed. **The 1Password npm plugin requires the command name `npm`**, so retain the selected Node's PATH and make advanced npm overrides match it.

On macOS, the installer uses existing Homebrew or MacPorts. On Linux, it uses a detected apt/dnf/yum/pacman/zypper/apk installation. Without a supported package manager, it provides official tmux guidance and executable-path overrides. It does not silently bootstrap Homebrew or pipe a remote shell script into execution.

### Authentication boundaries

- Existing CLI environments and selected `CODEX_HOME` / `CLAUDE_CONFIG_DIR` paths can be reused.
- Orca's current plugin host API does not export managed accounts. Orca logins or API keys are not automatically converted into CLI logins.
- Only the success status of CLI `auth status` / `login status` is used; their output and tokens are not retained in panels or plugin storage.
- Changing account paths or runtime configuration does not change an already-running daemon's environment. Safely settle active teams and use OpenRig's explicit stop/start procedure to apply the new environment. The plugin does not restart it automatically.

**Changing `OPENRIG_HOME` alone does not isolate provider settings or personal skill directories.** OpenRig startup can write discovery skills; team startup can write trust, hooks, and project guidance. Execution plans disclose those effects. Use a separate Orca profile and effective HOME for isolated testing. This separates configuration and state paths; it is not a security container.

## Development and testing

No compilation build step is required: Orca loads TS/TSX directly. Run development commands in the source checkout; staging directories contain only runtime files and documentation. Generate development types from the installed Orca.

```sh
orca plugin types . --json
# When using the 1Password npm plugin, as in this environment:
op plugin run -- npm ci
./node_modules/.bin/tsc --noEmit -p .
node --test test/*.test.mjs
orca plugin test . --json
orca plugin check . --json
```

Without 1Password integration, use ordinary `npm ci` to install development dependencies.

Ordinary tests use Node and Git for publication-policy fixtures, **not CircleCI, Orca, or a model account**:

```sh
node --test test/*.test.mjs
```

Run the disposable smoke test from first installation onward:

```sh
node scripts/sandbox.mjs --install --approve-plugin --output ci-results/local-live
```

These options explicitly authorize external package downloads and **approval of this test plugin's exact grants**. Each run copies the plugin outside the source tree and uses a separate Orca profile, OpenRig state directory, HOME, and unused port. Only npm installation reuses the existing npm/1Password environment and cache. The test does not launch agents or copy logins.

To skip the network installation using an existing rig:

```sh
OPENRIG_TEST_RIG=/absolute/path/to/rig node scripts/sandbox.mjs --approve-plugin
```

Following Orca 1.4.258's own E2E approach, the test seeds `orca-data.json` in **a new empty test profile only**, dismissing onboarding and first-use tips with telemetry disabled. It does not assume a public `--skip-onboarding` option or modify existing user profiles, running databases, or TCC permissions. Real panel capture works without computer use on this version.

Add `--keep` to retain the sandbox for manual inspection. Otherwise, the test cleans up its team, daemon, plugin, terminals, and verified sandbox processes, leaving a report. Administrator or 1Password approval requirements are never bypassed.

**Do not place running sandbox state inside the development plugin source directory.** It can interfere with file watching and reloads. If a worker retains an old dependency after an edit, explicitly run `orca plugin restart local.openrig-for-orca --json`. Worker restarts discard pending execution plans.

## CircleCI macOS

`.circleci/config.yml` follows the managed macOS setup in `dsh-session-cleanup`. A checksum-pinned Gitleaks job checks Git history and current commit candidates first. Xcode 26.4.1 / m4pro.medium then independently runs Node 22 and 24 core tests and the **Node 22 live Orca/OpenRig suite**. Orca ARM64 1.4.258 installs into a private directory after verification of the official DMG's pinned SHA-256 and signature. Jobs do not sign in to accounts, run paid agents, or deploy anything.

JUnit, allowlisted logs, and example screenshots are collected. Missing required checks, installation, either seat, attach/detach, explicit stop, template validation, or cleanup fail the suite. A Node 24 core pass does not establish Apple Silicon OpenRig execution support.

Run `node scripts/scan-secrets.mjs` for a quick Git-candidate check, or `node ci/check-secrets.mjs --bootstrap` for the pinned full history/current-candidate gate on macOS ARM64. Reports contain locations and rule IDs, not credential values. Common credential/key/state files are ignored, but force-staged files and historical secrets still need detection.

CI-owned application downloads are removed in `finally`; an externally supplied `--orca-cli` installation is never removed. Validation failures outside command steps produce failed JUnit cases as well as a nonzero exit. An accepted terminal receipt remains visible even if metadata storage or a subsequent list refresh fails.

See [SECURITY.md](SECURITY.md) for publication safeguards and reporting, [docs/CI.md](docs/CI.md) for connection settings, triggers and validation boundaries, [SPEC.md](SPEC.md) for the contract, and [docs/TESTING.md](docs/TESTING.md) for evidence.
