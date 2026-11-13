# Security Policy

This is an early-release, trusted-worker Orca plugin, not a security sandbox. Approving it grants code execution with your user account's access. Agent roles, read-only terminal views, and native permission settings are distinct controls; none should be described as universal containment.

## Reporting a vulnerability

Use the repository's private vulnerability reporting channel when enabled. Do not post credentials, private project contents, or working exploit details in a public issue. If private reporting is unavailable, request a private contact channel without disclosing the sensitive details. Do not include real model-provider credentials in reproductions.

## Verified launch boundary

- Automated agent launches require an absolute local YAML spec and the supported OpenRig version. Export library specs locally or use an example template; unresolved library names are blocked.
- Preparing a launch uses OpenRig's assembler to freeze the declared spec and resources in a private bundle. This preparation writes local review files but starts no team.
- Integrity checks, a read-only archive, a private directory, and hash checks before preview and execution bind launch to the frozen bytes. Changing the original YAML or role files does not change that launch. A changed or expired bundle requires a new review.
- The review displays bundle-derived runtime/model/permission declarations. Native model defaults, host settings, installed integrations and effective native permission enforcement may remain unverified. They are labelled explicitly; `ACCEPT UNVERIFIED SETTINGS` is required before `LAUNCH` when uncertainties remain.
- This does not protect against a malicious process already controlling the same user account, which could modify the plugin or other execution components. Only use trusted runtimes and review the disclosed host/native uncertainties.
- No automatic permission bypass, model substitution or extra kernel launch is requested. An unsuccessful launch can leave some seats running; inspect OpenRig before retrying.

Private review bundles can contain sensitive resources explicitly referenced by a selected spec. Treat `<data>/launches/`, `<data>/actions/`, instance state and account directories as private. Do not upload them as CI evidence or commit them. Do not remove a materialized bundle while a running team still needs its resources.

## Credential and publication safeguards

- The plugin reuses supported CLI authentication environments; it does not export Orca-managed accounts or print authentication-check output.
- Ignore rules cover common local credential files, keys, databases, bundles and generated state. Ignore rules alone are not secret detection, especially for force-staged files or prior commits.
- `node scripts/scan-secrets.mjs` checks Git candidates, including untracked first-commit files. Findings contain locations and rule IDs, never matched credential values.
- `node ci/check-secrets.mjs --bootstrap` additionally uses checksum-pinned Gitleaks for all reachable Git history and a private copy of the current Git candidate set. Raw scanner output and reports are not uploaded; only location-only results survive cleanup.
- The CircleCI secret gate must pass before core/live jobs proceed. Scanner failures or incomplete reports are failures, not clean results.
- Secret scanners are defense in depth, not a guarantee. If a real credential was committed or published, revoke/rotate it first; deleting the file or rewriting history alone is insufficient.

## Remote settings requiring an administrator

Before public release, enable and verify GitHub secret scanning/push protection where available, private vulnerability reporting, dependency alerts, trusted-PR trigger policy, and branch protection for the actual hosted CI checks. These repository-side changes do not enable remote settings or establish a hosted CircleCI pass. No Git remote or repository visibility is changed automatically.
