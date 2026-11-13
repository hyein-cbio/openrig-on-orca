# CircleCI macOS and ordinary local tests

## Two distinct test paths

Ordinary core tests use Node and Git for publication-policy fixtures, not CircleCI, Orca, tmux or an agent login:

```sh
node --test test/*.test.mjs
```

Panel/worker tests additionally use the installed Orca's own test kit:

```sh
orca plugin types . --json
./node_modules/.bin/tsc --noEmit -p .
orca plugin test . --json
orca plugin check . --json
```

CircleCI runs these gates on managed macOS VMs and adds the real first-install/example/PTY lifecycle. It is not needed to run ordinary tests locally.

## Matrix

Following `~/orca/projects/dsh-session-cleanup/.circleci/config.yml` and its shared-worker approach:

| Job | Executor | Node | Scope |
|---|---|---|---|
| macos-secret-scan | Xcode 26.4.1 / m4pro.medium | 22.23.4 | Pinned Gitleaks history/candidate gate and location-only findings |
| macos-core-node22 | Xcode 26.4.1 / m4pro.medium | 22.23.4 | Core regressions and shipping allowlist |
| macos-core-node24 | Same | 24.22.1 | Core regressions, not a live OpenRig support claim |
| macos-orca-live-node22 | Same | 22.23.4 | Independent core gate, Orca type/panel/worker checks, staging, first install and example lifecycle |

Apple Silicon live OpenRig uses Node 22, matching the plugin's compatibility policy. Node 24 is never substituted for the live job. No self-hosted runner, model account, secret context, deployment or publication is configured.

The three core/live jobs require `macos-secret-scan` to pass. Gitleaks 8.24.3 is downloaded from its official release into a private temporary directory, verified against a pinned SHA-256, and removed afterward. Both reachable Git history and a private copy of current Git candidates are checked; untracked first-commit files are included, ignored dependency/profile trees are not copied, and force-tracked credential files are blocked. Raw scanner streams and reports are withheld and deleted. Only locations/rule IDs are uploaded. Failure to complete either scan is not a pass.

The config pins `circleci/node@7.2.1`. Only npm downloads are cached, keyed by macOS/ARM64/Node/lockfile. Profiles, accounts, app runtime state and native SQLite installations are not cached across jobs.

## Pinned Orca bootstrap

`ci/settings.mjs` pins:

- Orca **1.4.258**, official `orca-macos-arm64.dmg` GitHub release asset.
- SHA-256 `101a3452097ec303ef43b5e5ff06a86dfa8c534e17154c85be0a9297eba55199`.
- Bundle ID `com.stablyai.orca`, signing Team ID `6CX3WHS9HZ`.

`ci/bootstrap-orca.mjs` verifies the DMG hash **before mounting**, copies the app into a disposable user-owned directory, verifies its code signature and publisher, checks its CLI version, and detaches the DMG. It never replaces `/Applications/Orca.app`, installs a latest cask, or disables Gatekeeper/SIP. The runner records its owned download directory and removes it in `finally` after success or failure. An externally supplied `--orca-cli` path is not owned and is never removed.

macOS VM tmux is reused or installed using its existing Homebrew. There is no provider CLI installation or login. The full job deliberately starts with a fresh plugin-managed OpenRig prefix and exercises its installer through an actual Orca terminal.

## Onboarding: no computer use required for the pinned release

No public packaged `--skip-onboarding` switch was found for Orca 1.4.258. Its **own E2E helper seeds `orca-data.json` before the first launch**:

- [upstream app fixture](https://github.com/stablyai/orca/blob/v1.4.258/tests/e2e/helpers/orca-app.ts)
- [upstream completed-profile fixture](https://github.com/stablyai/orca/blob/v1.4.258/tests/e2e/helpers/e2e-completed-onboarding-profile.ts)
- [onboarding visibility gate](https://github.com/stablyai/orca/blob/v1.4.258/src/renderer/src/components/onboarding/should-show-onboarding.ts)

`scripts/ci-support.mjs` uses that migration input in a **new empty, task-owned profile only**. It records onboarding as dismissed, disables telemetry, and suppresses first-use education overlays. Existing/nonempty profiles are refused. This is a version-pinned test fixture, not a stable public settings API or a product feature that bypasses normal onboarding.

It does not edit a running profile DB, grant TCC permissions, enable provider trust, or modify personal settings. Local real-app light/dark panel captures work without computer use. Updating Orca requires revalidating the fixture contract; a failed migration or capture is not silently skipped.

## Live suite and artifacts

`node scripts/sandbox.mjs --install --approve-plugin --output <directory>` stages only shipping files outside the source tree, starts an isolated Orca profile, and checks:

1. Plugin consent is for exactly the expected trusted-worker and three capabilities.
2. The fresh private prefix does not yet contain a working OpenRig.
3. Plugin install command downloads pinned OpenRig in an actual Orca terminal.
4. Node/tmux and a real SQLite query work; provider remains `none`.
5. The isolated daemon starts with no kernel or agent.
6. The plugin itself creates its two-seat terminal-only example.
7. Both seats show clearly labelled prerecorded simulation output in read-only Orca PTYs.
8. Closing the views preserves the tmux seats.
9. A separately confirmed Stop demo action stops that recorded team.
10. Claude-only and Codex-only templates are created; real OpenRig validates both RigSpecs and all AgentSpecs. No model process is launched.
11. Real OpenRig freezes both templates into integrity-checked bundles and generates declared-setting/uncertainty reviews. Mutating original role files does not change the archives.
12. The frozen-bundle confirmation program previews and launches a separate two-seat terminal-only fixture, with the explicit uncertainty acknowledgment. No model runtime is used.
13. Example Window renders in light/440 px and dark/320 px modes; a native walkthrough control is driven before capture.
14. Test-owned teams, daemon, plugin, terminals, desktop and terminal host are cleaned up.

Checks have stable IDs. The CI worker rejects missing/duplicate required checks, an error exit, missing capture evidence or incompatible runtime metadata. Cleanup errors fail the test. A macOS `?E` process-exit transition is observed within a bounded wait; an unrelated or uninspectable live PID is never treated as owned.

Artifacts:

```text
ci-results/orca/
  summary.json
  dependencies.log
  core-tests.log
  plugin-tests.log
  plugin-check.log
  ...other step logs...
  live/
    report.json
    examples-light.png
    examples-dark.png
test-reports/
  orca-core.xml
  orca-steps.xml
```

Partial summaries and completed step logs are kept after failure. Exceptions outside command steps, including bootstrap/version/report validation, are recorded as failed JUnit cases while retaining the nonzero exit. Upload is limited to these generated report/log/image directories, never the temporary profile/HOME, account files, checkouts or environment dumps. The child environment is allowlisted; CI tokens, SSH agent, provider variables and inherited Orca identities are not forwarded. On developer machines with 1Password npm integration, npm commands retain that integration; the hosted jobs attach no credentials/context and need only public packages.

The screenshots are evidence of rendered panels, not a pixel-baseline comparison or proof of paid-agent quality. Full external-provider behavior remains outside CI.

## Local worker reproduction

The provider-neutral runner needs a committed checkout, exact Node version, and an unprivileged macOS ARM64 user. Normal local tests above do not require a commit or exact patch version.

```sh
node scripts/scan-secrets.mjs
node ci/check-secrets.mjs --bootstrap
node ci/run-ci.mjs --suite core --node-version 22.23.4
node ci/run-ci.mjs --suite core --node-version 24.22.1
node ci/run-ci.mjs --suite orca --node-version 22.23.4
```

For local reproduction with an already verified Orca installation, `--orca-cli /absolute/path/to/orca` skips the download but still requires version 1.4.258. Hosted config does not use that shortcut.

Do not use `circleci local execute` as proof of macOS execution: its Docker execution path is not a managed macOS VM.

## Connecting CircleCI

The repository must first exist at its intended Git remote with this config committed/pushed. Configure the CircleCI GitHub App project with:

- Its own repository for **both config and checkout source**.
- Config type **CircleCI**, path `.circleci/config.yml` (not GitHub Actions).
- One `only-build-prs` trigger: PR opened/synchronize/reopened, default branch push, manual/API.
- Config/checkout refs following the triggering revision, not pinned to another branch.
- No secret context. Verify the GitHub App's fork-PR exclusion; workflow expressions alone are not a fork security gate.
- Enable and verify GitHub secret scanning/push protection, private vulnerability reporting and dependency alerts where available. These are administrator settings, not effects of this config.

Automatic tags and non-main ordinary pushes are excluded by the workflow expression. Confirm macOS credits and `m4pro.medium` availability. Add check names to branch protection only after real hosted runs succeed.

### Connection and first-push diagnostics

The macOS route is a native CircleCI GitHub App connection, not a GitHub Actions dispatcher. The reference project's Actions workflow and `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` are for its separate Modal Ubuntu route; those secrets do not subscribe CircleCI to GitHub events and are not needed by these macOS jobs.

The initial implementation push reached GitHub at **2026-11-13 15:56:38 UTC**, but this project's CircleCI pipeline/trigger were created at **16:00:51–52 UTC**. CircleCI cannot retroactively receive that earlier push. Once connected, use a new main-branch push or one explicit API run; do not launch both to diagnose the same revision.

The existing connection was verified and retained, not duplicated:

- Project: `7488aefc-b9ab-4810-a845-3fb1fb6a7575`.
- Pipeline definition: `e02de98b-6ed9-4941-9351-dcba583264f3`.
- Both config and checkout repository: `hyein-cbio/openrig-on-orca`; native config `.circleci/config.yml`.
- Existing trigger: `eb14f558-05f0-40ad-b99c-f5599026e919`, enabled, updated in place from `all-pushes` to the reference's `only-build-prs` preset. Config and checkout refs are unpinned.

For GitHub App projects, legacy `gh/owner/repo` lookup can return `project.not_found` even while the project exists. Discover it with `circleci project list --json`, then use its project ID or CircleCI project slug:

```sh
circleci pipeline list --project-id 7488aefc-b9ab-4810-a845-3fb1fb6a7575 --json
circleci project trigger list --project-id 7488aefc-b9ab-4810-a845-3fb1fb6a7575 --pipeline-definition-id e02de98b-6ed9-4941-9351-dcba583264f3 --json
circleci run list --project circleci/4b33f991-6901-4499-9855-5965f4396514/7488aefc-b9ab-4810-a845-3fb1fb6a7575 --branch main --json
```

Check that a received run names the intended commit and actually creates the four macOS jobs. A project connection, an empty GitHub commit-status response, or a pipeline record without workflows is not a passing test result. No secret values are needed for these metadata-only diagnostics.

## Validation status

Locally verified on macOS ARM64:

- CircleCI CLI config validation.
- Official DMG download, exact SHA-256, codesign/publisher and CLI version verification.
- The actual CI worker on pinned Node 22.23.4 and 24.22.1 in a disposable committed source snapshot.
- Node 22's full first-install, native Example Window, two-seat attach/detach/stop, template validation and cleanup path, with JUnit and artifact generation.
- The new publication gate was run locally with the pinned Gitleaks binary against both candidate files and reachable history. Frozen launch/input-consent regressions and real terminal-only bundle execution are covered separately from paid-provider behavior.

**This local evidence is not a hosted CircleCI pass.** The repository is now published and its CircleCI GitHub App connection has been inspected and aligned with the reference. Receiving a push and creating jobs is a separate checkpoint from successful managed-macOS execution. Inspect the actual revision's hosted job results before claiming that acceptance gate or making its checks mandatory.
