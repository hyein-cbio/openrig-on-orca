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

- **108 core, native-panel, and worker tests passed**, with no failures or skips.
- TypeScript strict checking passed.
- **Eight panel scenarios passed:** three Example Window scenarios and five existing Setup/Teams/Paths scenarios.
- No rendering errors, dropped-prop warnings, or refused host calls.
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
11. Drive a walkthrough button and capture Example Window at 440 px in the light theme and 320 px in the dark theme.
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

## Single-seat instruction GUI

The Teams instruction form reuses native `rig send`, not a new RPC adapter. Isolated tests cover exact recipient/text review, cancel/confirm behavior, disabled shell/busy/attention targets, immutable one-use plans, stopped or retargeted seats, literal argument quoting, control-input rejection and explicit local-instance routing. A harmless executable CLI fixture records the actual generated argv without a model or shell-command injection. Real OpenRig 0.7.12 and 0.7.13 were also run against a task-owned mock HTTP endpoint: each produced exactly one guarded `/api/transport/send` request for the synthetic recipient, preserving the exact text and 1000 ms idle condition.

These checks do not send to a real agent or prove model acknowledgment/completion. Existing live teams, kernel, account settings and instance selection were not changed. No paid-model smoke run is part of this verification; obtain approval before one. CI monitoring was not resumed.

## Single-seat start and durable task registration

Offline coverage includes never-started registrations without fabricated session addresses; start consent; already-running no-op behavior; model/cwd changes; shell/kernel/unknown targets; busy-agent durable destinations; private exclusive body staging; literal title/body argv; fixed request IDs; and read-only registration checks for matching, missing, changed-content and changed-instance responses. Native panel tests exercise startup acknowledgment and registration snapshots without resubmitting work.

Real OpenRig 0.7.12 and 0.7.13 were each connected only to an isolated mock HTTP server: the generated start command made one single-node launch POST (no subset/fresh/stop/model fields), queue creation made one POST preserving its ID, destination, declared external source and multiline body, and registration readback added no POST. These are native CLI/API contract checks, not live-agent startup or model-work validation. Existing live teams, kernel, accounts and global settings were not modified; CI was not monitored.

## Unverified behavior

- Compatibility with Orca/OpenRig/macOS versions outside the pinned hosted and local targets. Hosted workload success and JUnit ingestion are separate acceptance checks; see the reporting history above.
- Real Linux package-manager installation and terminal UI.
- Manual tmux installation on macOS without a package manager.
- Actual Claude/Codex sign-in, paid-agent work quality, and handoffs.
- Operational migration of an existing daemon after account-path changes.
- Orca-managed account export: not provided because the current host API does not support it.
- Remote/WSL host connections: explicitly refused as outside v0.1's scope.
- Full pixel-baseline UI regression testing. Current coverage uses native-component tests and real panel captures.

## Integration issues resolved

- OpenRig's actual `entries` JSON envelope and truncated-list handling.
- The literal command name required by `op plugin run -- npm`.
- Keeping active sandbox state outside the source tree to avoid development watcher/approval conflicts.
- Orca's **4096-character terminal-command limit**: stage the reviewed command after confirmation as a private `0600` script and pass a short invocation.
- Separating a pure walkthrough module so panels do not import Node-dependent modules.
- Observing macOS `?E (Orca)` exit transitions with bounded waits. Never signal an unproven PID or interpret observation failures as successful termination.
