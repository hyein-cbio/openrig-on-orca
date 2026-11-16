# Additive Intel Mac support

## Preservation contract

Intel support is an **opt-in addition**, not a rewrite or generalization of the Apple Silicon implementation.

Intel adaptation remains separate from the shared runtime, worker, manifest, staging, sandbox, ARM64 bootstrap/settings/CI, dependency lockfile and tests. The reviewed shared-code snapshot is based on upstream `61cffec` and includes its topology hub navigation plus the stored user-request report feature. No shared source imports the Intel modules. The default `orca-plugin.json` still selects `src/worker.ts`, and the default `node scripts/stage.mjs` still builds the shared package.

`test/fixtures/apple-silicon-baseline.json` records SHA-256 hashes for 199 reviewed shared code/configuration files, including the one-minute refresh, stored-result reports and instance-bound TUI view module. The shared-feature refresh updates intentional topology/report changes, their scoped security/loader regressions and the generated chunk name, retains unchanged protected hashes, and adds the three new report implementation/test files. `test/intel-mac.test.mjs` still fails if any protected byte changes. Future baseline changes require review; updating it merely to hide an Intel-specific regression defeats the preservation contract. The original historical baseline was `dbf7191`; shared product evolution is distinct from Intel adaptation.

## Separate Intel entry points

| Additional file | Responsibility |
| --- | --- |
| `src/intel/worker.ts` | Calls the original worker through the optional Intel host adapter |
| `src/intel/runtime.mjs` | Adds `/opt/local/bin` to the existing `extraPath` mechanism on `darwin/x64` only |
| `scripts/stage-intel.mjs` | Calls original staging, adds the two Intel runtime files, selects the additional worker only in the output manifest |
| `ci/intel/settings.mjs` | Separate official x64 Orca asset and checksum; imports original publisher/version metadata without modifying it |
| `ci/intel/bootstrap-orca.mjs` | Intel-only download/hash/system codesign/architecture/version verification |
| `ci/intel/ensure-tmux.mjs` | Intel-only, verify-only tmux preflight using the original probe |
| `ci/intel/run-ci.mjs` | Separate Intel validation runner; reuses original reporting/cell/cleanup helpers |
| `scripts/intel/sandbox.mjs` | Opt-in Intel staging/architecture-evidence driver around the unchanged original live harness |
| `scripts/intel/support.mjs` | Adds native Intel/SQLite evidence requirements without changing original report validation |
| `scripts/intel/cancellation.mjs` | Stops normal command work on cancellation and waits for owned command groups and cleanup |

The adapter does not mutate process PATH, change Node/provider policies, install software, write storage on activation/read, add capabilities or replace operations. It exposes an in-memory configuration default through a separate facade compatible with Orca's frozen API objects. Explicit extra paths stay first. Non-configuration storage and receiver binding are preserved. On ARM64, Linux or other non-Intel hosts it returns the original host unchanged.

All setup, consent, plan expiry, targeting, daemon, terminal, pod, relationship, instruction and task logic continues to run in the **original worker and original modules**. There is no reduced Intel feature mode and no duplicated provider/seat implementation.

### Install the Intel package

```sh
node scripts/stage-intel.mjs
# Inspect the printed path and follow the printed install command.
```

Use the produced directory, not the source checkout, to install the additive Intel variant. Loading the repository root directly still loads the unchanged original worker; it does not silently opt into the Intel adapter. Both variants retain the same plugin identity: install the one intended for that host, not two copies side by side. Orca's exact approval fingerprint still applies; the stager never approves grants itself.

Apple Silicon commands remain unchanged:

```sh
node scripts/stage.mjs
node ci/run-ci.mjs --suite orca --node-version 22.23.4
```

## Intel validation

Tested physical host: Intel Core i9-9880H (2.30 GHz), macOS 26.7.3 / Darwin 25.6.0, `uname -m = x86_64`. Native Node 22.23.4 (`x64`), Orca 1.4.258 x64, OpenRig 0.7.13 and tmux 3.8 are the live target. The personal Orca app remains untouched; the test app and tmux use private temporary prefixes.

```sh
npm ci --ignore-scripts
node --test test/*.test.mjs
"$ORCA_CLI_COMMAND" plugin types . --json
node node_modules/typescript/bin/tsc --noEmit -p .
"$ORCA_CLI_COMMAND" plugin test . --json
node scripts/intel/sandbox.mjs --install --approve-plugin --output ci-results/intel-additive/live
```

Set `ORCA_CLI_COMMAND` to the exact pinned x64 CLI. `--install` permits public package downloads/install scripts; `--approve-plugin` approves only the staged plugin's existing grants in an isolated profile, not model login or agent execution. The Intel driver requires `--output` and cleanup; it refuses `--keep` for evidence runs.

The driver creates a disposable copy of the original test harness **outside the repository**, with absolute imports, Intel staging selection and architecture assertions. It imports that harness into the wrapper process so it cannot survive the wrapper timeout as a separate child. Cancellation blocks new normal commands and waits for owned command termination and the original cleanup; cleanup commands remain allowed. It does not edit the original harness or generate a product-code fork. Exact anchor checks fail closed if the original harness changes. The original install/lifecycle/browser/cleanup assertions still run. The additional report requires matching native x64 Node/worker and a successful real SQLite probe.

For the combined Intel pipeline, use a committed disposable source snapshot so the final tracked-clean gate is meaningful without committing the user's working tree:

```sh
node ci/intel/run-ci.mjs --suite orca --node-version 22.23.4 \
  --orca-cli "$ORCA_CLI_COMMAND" --output /absolute/path/to/intel-results
```

Omit `--orca-cli` to use the new Intel-only verified bootstrap. ARM64 installations continue using the original bootstrap. The hosted CircleCI matrix, Gitleaks bootstrap and automatic tmux installer are unchanged and ARM64-only. The Intel tmux preflight never installs packages automatically.

Official Intel asset: <https://github.com/stablyai/orca/releases/download/v1.4.258/orca-macos-x64.dmg>

SHA-256: `e28a685c42a62e0d9b35f3be3b41bde3db654342521d7194490b5ae37931cb3d`

Publisher: bundle `com.stablyai.orca`, Team ID `6CX3WHS9HZ`. Intel verification uses absolute system tools, not potentially shadowing conda/toolchain shims, and requires an x86_64 executable before invoking its CLI.

## Evidence and boundaries

The native Intel evidence below describes the earlier shared snapshot, not the subsequent topology/report integration. The refreshed shared snapshot is validated on Apple Silicon with platform-conditional Intel unit/staging tests; a fresh native Intel live run or hosted pass is not claimed for it.

Before the upstream refresh, the additive runtime/package's full local pipeline passed all 13 steps and 21 real no-model lifecycle checks. After integrating upstream `dbf7191` (one-minute refresh), local regressions passed 176 core / 209 Orca tests, including the controller/offline-failure tests; these totals include the core suite rather than adding to it. Typechecking and workflow lint passed. The refreshed baseline intentionally incorporates the upstream changes rather than restoring older Apple Silicon code. The subsequent PR lifecycle fixes passed 184 core / 217 Orca tests and a fresh native Intel pipeline (14 steps, 23 live checks), including explicit cleanup confirmation and verified removal of the staging directory. No hosted workflow pass is implied; see [manual Intel CI](INTEL-CI.md).

[verification/intel-macos.json](verification/intel-macos.json) identifies the tested additive structure, preserved originals and actual latest results. Detailed generated logs, JUnit and reports live under `ci-results/intel-additive/` and are intentionally ignored by Git. Earlier `ci-results/intel-macos/` results describe the superseded shared-code approach and are **not evidence for this additive implementation**.

The full no-model live path covers fresh installation, real SQLite, a no-agent daemon, both terminal-only demo seats, PTY attach/detach/stop, native pod/relationship reads, template validation and frozen terminal-only launch, LR/TB geometry, bounded outbox hover previews, two-view navigation, light/dark panel capture and owned-process cleanup. Fixtures are labelled simulation, not AI work. Browser interaction uses a task-owned native snapshot with no worker bridge; native captures can include an in-progress environment scan. Screenshots prove rendering, not completion of every operation.

Retained visual evidence: [dashboard](images/intel-macos-dashboard.png), [narrow dark preparation panel](images/intel-macos-preparation.png).

**Not established:** actual provider authentication, paid-agent startup/model responses, real-agent instruction delivery or durable-task processing, native OS SVG save-dialog interaction, real package-manager installation, every macOS/Node version, or hosted Intel CI. Their automated fixture coverage is not equivalent to successful real-provider execution. Preserving the Apple Silicon bytes is independently tested; an ARM64 hardware rerun is not claimed from an Intel host.
