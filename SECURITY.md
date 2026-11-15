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

## Native inventory and untrusted visualization

Seat observations use a bounded native CLI field projection. Selected-pod relationships additionally use direct loopback GET `/api/whoami?compact=1&sessionName=…`, never full graph/spec/runtime-token or transcript-content endpoints. Requests do not follow redirects, use proxies, load credentials or send cookies; authentication failures remain unavailable. Compact API metadata is allowlist-projected into endpoint identities and relationship kinds, with no raw response/error retained. Limits are four concurrent reads, 2.5 seconds/256 KiB each, 80 selected seats and 160 displayed relationships. Missing identity/session data stays unknown; disagreement and membership drift remain partial. Default-local discovery refuses daemon records larger than 16 KiB under the effective HOME, accepts only local loopback metadata and pins the observed port without changing global settings. A different instance is read-only until explicit plugin-owned connection consent. Its key is checked at connection/review/view time and the saved scoped plan is checked again at confirmation; matching rig IDs in another instance do not authorize retargeting. Existing-home connections refuse managed daemon startup. Missing/truncated/malformed inventory never becomes an empty list or demo.

The optional Dashboard YAML preview parses only an explicitly selected/pasted document or explicitly requested labelled example; entering it invalidates pending reviews and locks pod operations/views until the native inventory is restored. The standalone development page also has a labelled example. That YAML parser/renderer makes no worker/daemon request and does not persist source or resolve AgentSpec/resource paths. The containing panel separately performs read-only environment discovery and offers explicit reviewed operations; internal navigation itself never executes an operation. YAML aliases, duplicate keys, custom tags, multiple documents and excessive input/nesting/topology sizes are refused. Only a bounded projection of declared pods/members/edges becomes generated Mermaid flowchart syntax; labels cannot supply directives, raw Mermaid, HTML or math. Strict Mermaid rendering is followed by SVG sanitization that removes executable/linked/image/foreign-object content. A content policy blocks network connections and images. This is defense in depth, not a claim that third-party renderers are vulnerability-free.

Generated local assets are pinned to the lockfile and covered by source/content hashes in `src/visualizer/assets.json`. Keep the dependency audit and asset-integrity tests passing when updating them; copied prebuilt Mermaid modules must also be updated, not merely the npm dependency tree. Explicit SVG export contains displayed topology and may expose private names or model declarations. Native save-dialog consent remains with the user.

## Outbound report previews

The explicit report-preview feature reads message content only from the bounded native sender outbox, on native-node hover/focus. It does not read transcript files, capture a pane, follow report paths, ask an agent to report, invoke a model or deliver anything. The shared HTTP reader permits only compact whoami and outbox-list GET routes on the observed loopback endpoint, with no redirects/proxies/cookies/credential lookup. Outbox bodies are bounded to a 1 MiB response and a 20-row window; native identities and pod/instance context are rechecked.

The worker returns at most 500 valid UTF-8 bytes of one body with provenance and delivery uncertainty, never the full response. Outbox attribution is a recorded claim, not authenticated authorship or proof that the current occupant sent it. Explicit automated wake entries and external/system/self recipients are excluded; an untyped notification is not semantically classified as a report. Preview cache and DOM are panel-memory only. The body is rendered with textContent in a tooltip outside the SVG; tooltip DOM is cleared on dismissal and cache entries expire or are invalidated on pod/inventory changes. Raw content is never executed, interpreted as instructions, logged or written to plugin storage. Sensitive message text can still be visible to someone looking at the local panel.

## Credential and publication safeguards

Repository ignore rules exclude developer/test scratch, local profiles/captures, private runtime/provider/instance/action/launch directories, logs/PIDs/sockets, SQLite sidecars and browser/CLI session exports. They deliberately retain the prebuilt `src/visualizer/` bundle, its integrity/notice files, public specs and reviewed documentation images. `test/ignore.test.mjs` checks this distinction in an isolated Git repository. The code-index directory remains covered by the user's global ignore, not a repository rule. Ignore rules do not protect already tracked files; candidate/history scanning remains mandatory before publication.

- The plugin reuses supported CLI authentication environments; it does not export Orca-managed accounts or print authentication-check output.
- Ignore rules cover common local credential files, keys, databases, bundles and generated state. Ignore rules alone are not secret detection, especially for force-staged files or prior commits.
- `node scripts/scan-secrets.mjs` checks Git candidates, including untracked first-commit files. Findings contain locations and rule IDs, never matched credential values.
- `node ci/check-secrets.mjs --bootstrap` additionally uses checksum-pinned Gitleaks for all reachable Git history and a private copy of the current Git candidate set. Raw scanner output and reports are not uploaded; only location-only results survive cleanup.
- The CircleCI secret gate must pass before core/live jobs proceed. Scanner failures or incomplete reports are failures, not clean results.
- Secret scanners are defense in depth, not a guarantee. If a real credential was committed or published, revoke/rotate it first; deleting the file or rewriting history alone is insufficient.

## Remote settings requiring an administrator

Before public release, enable and verify GitHub secret scanning/push protection where available, private vulnerability reporting, dependency alerts, trusted-PR trigger policy, and branch protection for the actual hosted CI checks. These repository-side changes do not enable remote settings or establish a hosted CircleCI pass. No Git remote or repository visibility is changed automatically.
