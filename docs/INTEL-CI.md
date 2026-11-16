# Manual self-hosted Intel Mac CI

## Entry point

Run **Intel Mac CI** (`.github/workflows/intel-mac-test.yml`) from GitHub Actions, or after both workflows have been published on the repository's default branch:

```sh
gh workflow run intel-mac-test.yml --ref main
```

This is manual-only. There are no push, pull-request, fork or scheduled triggers. Run reviewed, trusted commits only: a self-hosted runner executes repository code with its local user's permissions, not in an OS security sandbox.

The original Apple Silicon code, ARM64 CircleCI configuration and existing CI commands are unchanged. This workflow runs the additional `ci/intel/run-ci.mjs` entry.

## Why there are two workflow files

A self-hosted job's `timeout-minutes` does not bound the time it spends waiting for a runner. A workflow containing only `runs-on: [self-hosted, macOS, X64, intel-mac-lab]` can remain queued while the lab is offline.

The public **Intel Mac CI** workflow is the entry point and starts a **GitHub-hosted Ubuntu controller**. It dispatches **Intel Mac CI helper (for Intel Mac CI)** (`intel-mac-worker.yml`), records its exact run ID, checks its job metadata and reports the helper's actual result. The helper is an internal implementation detail of Intel Mac CI, not a second independent CI entry point. Do not launch the helper directly: the parent supplies the queue deadline and cancellation supervision. Workflow filenames remain unchanged so existing dispatch commands and links still work.

- Required worker labels: `self-hosted`, `macOS`, `X64`, `intel-mac-lab`.
- Acquisition deadline: **120 seconds**. Busy and offline runners are treated alike if no matching runner actually claims the job in that time.
- Merely seeing a workflow marked `in_progress` is not acquisition proof. The controller requires the named job to have a real runner ID/name and all required labels.
- Worker execution timeout: **30 minutes**. The controller independently bounds observed execution time.
- On timeout, failed tests, API failure or source mismatch: cancel the owned helper, verify completion, and fail the controller. If normal cancellation stalls, request force-cancellation. No fallback runner, automatic redispatch or skipped-as-success outcome is used.
- The controller's monitoring step is capped at 34 minutes, with an `always()` cleanup step and a 38-minute overall job cap. API calls have 20-second limits; queue deadlines can include bounded API/poll/cancellation overhead.
- If GitHub itself is unavailable, cancellation may remain unverified. The controller still fails and reports that uncertainty; it never treats inability to contact GitHub as success.

The API client pins GitHub REST version `2026-03-10`, whose workflow-dispatch response includes `workflow_run_id`. An ambiguous dispatch is not replayed automatically. GitHub can briefly return HTTP 404 or the unevaluated workflow title (`Intel Mac CI helper (for Intel Mac CI)`) for that exact new ID. Monitoring and cleanup retry only these publication states, up to ten reads separated by two seconds (18 seconds of delay plus bounded API time). The placeholder never counts as verified identity. Run ID, event, workflow path, correlation title and source SHA are checked; a different request title/path or a moved source fails immediately. Cleanup never guesses another run from a similar title or runner label.

The controller uses job-scoped **`actions: write`** solely to dispatch and cancel its separate worker; both workflows default to `contents: read`, and the self-hosted worker has no Actions write permission. No runner-administration token or additional repository secret is needed. The normal `GITHUB_TOKEN` must be allowed to dispatch/cancel Actions runs. Checkout credentials are not persisted, and all third-party actions are commit-pinned.

## What the worker runs

1. Verify macOS, `uname -m = x86_64` and the CPU model.
2. Checkout the controller's exact source SHA, not an interpolated shell branch command.
3. Select native Node **22.23.4 x64** and verify its architecture/version.
4. Run `node ci/intel/run-ci.mjs --suite orca --node-version 22.23.4`.
5. Upload only the generated CI evidence/JUnit directories, even after failure.

The combined runner performs the candidate secret scan, functional tmux preflight, dependency installation, complete core and Orca tests, strict typecheck, Intel package staging/inspection, and the isolated first-install/SQLite/daemon/terminal/UI lifecycle. Its new Intel bootstrap downloads the pinned official x64 Orca into a private temporary directory, verifies checksum/signature/architecture/version, and removes its owned application download afterward. It does not replace the personal Orca app, authenticate providers or launch paid models.

The reviewed shared-source SHA-256 regression gate also runs, covering 199 code/configuration files, including the shared report/TUI controls and refreshed generated assets. The manifest identifies its reviewed base and shared-feature evolution; the additional Intel implementation remains separate and must not alter the protected shared bytes.

### Cancellation and persistent-runner cleanup

The generated live harness runs inside its Intel wrapper rather than in a surviving child Node process. SIGTERM/SIGINT/SIGHUP block new test commands, abort in-flight work, terminate only command groups created by the harness (with bounded SIGKILL escalation), and unwind the original owned-resource cleanup before the wrapper returns. Cleanup commands are allowed to finish even after repeated cancellation. The runner removes any previous cleanup receipt before starting; it removes its downloaded app only after the current harness explicitly confirms cleanup. Missing/failed cleanup remains a CI failure and retains the owned download for inspection. Uncatchable SIGKILL or machine loss cannot run JavaScript finally blocks and is never represented as verified cleanup.

The runner allocates its own `openrig-intel-plugin-*` staging directory, passes it explicitly to staging/inspection, and removes it in finally after success, partial staging or inspection failure. Removal failure is a failed JUnit step, not a successful cleanup. No externally supplied app directory is deleted.

`test/intel-lifecycle.test.mjs` includes a real execFile timeout with a signal-resistant command and grandchild: it verifies that no further work starts and that cleanup finishes before the wrapper returns. It also covers repeated/cleanup-phase signals, command timeout, staging failure paths and current cleanup receipts.

## Lab prerequisites and failures

The selected runner must be online, accept this repository's jobs, and have:

- A normal non-root user, network access to GitHub/npm/Node downloads and sufficient free space.
- A working native tmux on PATH, `/opt/local/bin` or `$HOME/.local/bin`; the Intel preflight is verify-only and will not silently install system packages or ask for administrator access. The per-user directory is searched explicitly because launchd runners do not source interactive shell profiles.
- A working macOS graphical/login session capable of running the isolated Orca app and captures. A service with no usable GUI is not a passing live-test environment.
- GitHub Actions runner software compatible with the pinned checkout/setup-node/upload-artifact actions.

### One-time user-local tmux provisioning

Provision tmux as the runner account before dispatch. For a lab that already has conda, one option is a dedicated persistent prefix, separate from its base environment and from temporary test outputs:

```sh
conda create --prefix "$HOME/.local/share/openrig-ci/tmux" \
  --override-channels --channel conda-forge "tmux=3.8" --yes
mkdir -p "$HOME/.local/bin"
# Only create this link if no existing user tmux occupies the path.
ln -s "$HOME/.local/share/openrig-ci/tmux/bin/tmux" "$HOME/.local/bin/tmux"
node ci/intel/ensure-tmux.mjs
```

Alternatively, provision tmux with the lab administrator’s chosen package manager. Do not rely on `/tmp` tool prefixes: earlier local validation used one, but the Actions service could not discover it and temporary prefixes may disappear. The preflight validates an actual detached session on a private socket, not just a version string. No runner restart or global shell-profile edit is required for `$HOME/.local/bin` discovery.

Missing prerequisites, dependency/GUI failures and incomplete cleanup fail the job. Runner registration or an `online` API status is not proof of a successful test run. On forced interruption, inspect the task-owned sandbox report/processes before retrying; never terminate unrelated user sessions to clean up a failed test.

At setup inspection, GitHub reported three online/idle runners with the required label (`actions-runner1`, `actions-runner2`, `actions-runner3`). This is only a point-in-time registration observation, not a hosted CI pass.

## Validation and status

`test/intel-github.test.mjs` covers offline/busy queues despite workflow-level `in_progress`, successful acquisition, hung execution, wrong labels, failed tests, API errors, moved refs, unrelated-run refusal, force-cancel/unverified cleanup, ambiguous dispatch, token-safe API diagnostics and manual-only permission/trigger contracts. These tests use mocked GitHub responses and a simulated clock: they do not deliberately take your real lab offline or cancel unrelated runs.

Both workflows are checked with **actionlint 1.7.12**, with the custom label declared in `.github/actionlint.yaml`; shellcheck is disabled for that local lint invocation. YAML parsing and project regressions are separate checks.

The latest PR lifecycle-fix verification is recorded in [verification/intel-macos.json](verification/intel-macos.json): 184 core / 217 Orca tests, typechecking and workflow lint passed, followed by a real native Intel pipeline with 14 successful steps and 23 live checks. The harness emitted an explicit successful cleanup receipt, no warnings, and the runner-owned staging directory was verified absent afterward. The eight added lifecycle regressions include a real timeout, signal-resistant descendants, cleanup-phase cancellation and failed-staging/inspection cleanup. Historically, feature-branch dispatch returned HTTP 404 before the workflows were registered on the default branch. After merging to main, the first actual hosted run dispatched its worker but failed controller verification on GitHub’s temporary unevaluated title; the worker separately failed because no tmux was discoverable. The publication retry and user-local tmux discovery address those observed failures. A real hosted pass and an actual offline-lab run are never inferred from local mocks.

Artifacts:

- Controller: `intel-controller-<run-id>-<attempt>`, containing child identity and success/failure summary without tokens.
- Worker: `intel-mac-lab-<child-run-id>`, containing allowlisted Intel logs/reports/images and JUnit.

The controller is the failure-reporting entry: an unavailable lab produces a **failed Intel Mac CI**, even though its separately cancelled helper is displayed as cancelled.

References: [GitHub Actions limits](https://docs.github.com/en/actions/reference/limits), [dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event), [workflow cancellation API](https://docs.github.com/en/rest/actions/workflow-runs#cancel-a-workflow-run).
