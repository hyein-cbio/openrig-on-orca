# Manual self-hosted Intel Mac CI

## Entry point

Run **Intel Mac experiment** (`.github/workflows/intel-mac-test.yml`) from GitHub Actions, or after both workflows have been published on the repository's default branch:

```sh
gh workflow run intel-mac-test.yml --ref main
```

This is manual-only. There are no push, pull-request, fork or scheduled triggers. Run reviewed, trusted commits only: a self-hosted runner executes repository code with its local user's permissions, not in an OS security sandbox.

The original Apple Silicon code, ARM64 CircleCI configuration and existing CI commands are unchanged. This workflow runs the additional `ci/intel/run-ci.mjs` entry.

## Why there are two workflow files

A self-hosted job's `timeout-minutes` does not bound the time it spends waiting for a runner. A workflow containing only `runs-on: [self-hosted, macOS, X64, intel-mac-lab]` can remain queued while the lab is offline.

The public manual entry therefore starts a **GitHub-hosted Ubuntu controller**. It dispatches the separate `intel-mac-worker.yml` helper, records its exact run ID, checks its job metadata and reports the helper's actual result. Do not launch the helper directly: the controller supplies the queue deadline and cancellation supervision.

- Required worker labels: `self-hosted`, `macOS`, `X64`, `intel-mac-lab`.
- Acquisition deadline: **120 seconds**. Busy and offline runners are treated alike if no matching runner actually claims the job in that time.
- Merely seeing a workflow marked `in_progress` is not acquisition proof. The controller requires the named job to have a real runner ID/name and all required labels.
- Worker execution timeout: **30 minutes**. The controller independently bounds observed execution time.
- On timeout, failed tests, API failure or source mismatch: cancel the owned helper, verify completion, and fail the controller. If normal cancellation stalls, request force-cancellation. No fallback runner, automatic redispatch or skipped-as-success outcome is used.
- The controller's monitoring step is capped at 34 minutes, with an `always()` cleanup step and a 38-minute overall job cap. API calls have 20-second limits; queue deadlines can include bounded API/poll/cancellation overhead.
- If GitHub itself is unavailable, cancellation may remain unverified. The controller still fails and reports that uncertainty; it never treats inability to contact GitHub as success.

The API client pins GitHub REST version `2026-03-10`, whose workflow-dispatch response includes `workflow_run_id`. An ambiguous dispatch is not replayed automatically. Run identity, correlation title and source SHA are checked; cleanup never guesses another run from a similar title or runner label.

The controller uses job-scoped **`actions: write`** solely to dispatch and cancel its separate worker; both workflows default to `contents: read`, and the self-hosted worker has no Actions write permission. No runner-administration token or additional repository secret is needed. The normal `GITHUB_TOKEN` must be allowed to dispatch/cancel Actions runs. Checkout credentials are not persisted, and all third-party actions are commit-pinned.

## What the worker runs

1. Verify macOS, `uname -m = x86_64` and the CPU model.
2. Checkout the controller's exact source SHA, not an interpolated shell branch command.
3. Select native Node **22.23.4 x64** and verify its architecture/version.
4. Run `node ci/intel/run-ci.mjs --suite orca --node-version 22.23.4`.
5. Upload only the generated CI evidence/JUnit directories, even after failure.

The combined runner performs the candidate secret scan, functional tmux preflight, dependency installation, complete core and Orca tests, strict typecheck, Intel package staging/inspection, and the isolated first-install/SQLite/daemon/terminal/UI lifecycle. Its new Intel bootstrap downloads the pinned official x64 Orca into a private temporary directory, verifies checksum/signature/architecture/version, and removes its owned application download afterward. It does not replace the personal Orca app, authenticate providers or launch paid models.

The original-source SHA-256 regression gate also runs, covering 195 upstream code/configuration files at refreshed main commit `dbf7191`. The upstream refresh is preserved; the additional Intel implementation does not modify those files.

### Cancellation and persistent-runner cleanup

The generated live harness runs inside its Intel wrapper rather than in a surviving child Node process. SIGTERM/SIGINT/SIGHUP block new test commands, abort in-flight work, terminate only command groups created by the harness (with bounded SIGKILL escalation), and unwind the original owned-resource cleanup before the wrapper returns. Cleanup commands are allowed to finish even after repeated cancellation. The runner removes any previous cleanup receipt before starting; it removes its downloaded app only after the current harness explicitly confirms cleanup. Missing/failed cleanup remains a CI failure and retains the owned download for inspection. Uncatchable SIGKILL or machine loss cannot run JavaScript finally blocks and is never represented as verified cleanup.

The runner allocates its own `openrig-intel-plugin-*` staging directory, passes it explicitly to staging/inspection, and removes it in finally after success, partial staging or inspection failure. Removal failure is a failed JUnit step, not a successful cleanup. No externally supplied app directory is deleted.

`test/intel-lifecycle.test.mjs` includes a real execFile timeout with a signal-resistant command and grandchild: it verifies that no further work starts and that cleanup finishes before the wrapper returns. It also covers repeated/cleanup-phase signals, command timeout, staging failure paths and current cleanup receipts.

## Lab prerequisites and failures

The selected runner must be online, accept this repository's jobs, and have:

- A normal non-root user, network access to GitHub/npm/Node downloads and sufficient free space.
- A working native tmux on PATH or `/opt/local/bin`; the Intel preflight is verify-only and will not silently install system packages or ask for administrator access.
- A working macOS graphical/login session capable of running the isolated Orca app and captures. A service with no usable GUI is not a passing live-test environment.
- GitHub Actions runner software compatible with the pinned checkout/setup-node/upload-artifact actions.

Missing prerequisites, dependency/GUI failures and incomplete cleanup fail the job. Runner registration or an `online` API status is not proof of a successful test run. On forced interruption, inspect the task-owned sandbox report/processes before retrying; never terminate unrelated user sessions to clean up a failed test.

At setup inspection, GitHub reported three online/idle runners with the required label (`actions-runner1`, `actions-runner2`, `actions-runner3`). This is only a point-in-time registration observation, not a hosted CI pass.

## Validation and status

`test/intel-github.test.mjs` covers offline/busy queues despite workflow-level `in_progress`, successful acquisition, hung execution, wrong labels, failed tests, API errors, moved refs, unrelated-run refusal, force-cancel/unverified cleanup, ambiguous dispatch, token-safe API diagnostics and manual-only permission/trigger contracts. These tests use mocked GitHub responses and a simulated clock: they do not deliberately take your real lab offline or cancel unrelated runs.

Both workflows are checked with **actionlint 1.7.12**, with the custom label declared in `.github/actionlint.yaml`; shellcheck is disabled for that local lint invocation. YAML parsing and project regressions are separate checks.

The latest PR lifecycle-fix verification is recorded in [verification/intel-macos.json](verification/intel-macos.json): 184 core / 217 Orca tests, typechecking and workflow lint passed, followed by a real native Intel pipeline with 14 successful steps and 23 live checks. The harness emitted an explicit successful cleanup receipt, no warnings, and the runner-owned staging directory was verified absent afterward. The eight added lifecycle regressions include a real timeout, signal-resistant descendants, cleanup-phase cancellation and failed-staging/inspection cleanup. The feature branch was published and an actual `workflow_dispatch` request returned HTTP 404: the new workflow is not yet registered on the default branch. No self-hosted job started. Both workflow files need a reviewed default-branch merge before retrying dispatch. A real hosted pass and an actual offline-lab run are never inferred from local mocks.

Artifacts:

- Controller: `intel-controller-<run-id>-<attempt>`, containing child identity and success/failure summary without tokens.
- Worker: `intel-mac-lab-<child-run-id>`, containing allowlisted Intel logs/reports/images and JUnit.

The controller is the failure-reporting entry: an unavailable lab produces a **failed Intel Mac experiment**, even though its separately cancelled helper is displayed as cancelled.

References: [GitHub Actions limits](https://docs.github.com/en/actions/reference/limits), [dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event), [workflow cancellation API](https://docs.github.com/en/rest/actions/workflow-runs#cancel-a-workflow-run).
