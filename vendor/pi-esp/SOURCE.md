# pi-esp Native Chat view snapshot

This note and the MIT license accompany the browser view artifacts stored in `vendor/pi-esp` in the OpenRig source repository. The artifacts start from the locally built and verified `pi-esp` 0.1.0 private package. Source repository: <https://github.com/phiat/pi-esp>. The TypeScript view is from the integration handoff's working copy based on `a3eb313dd35844a3f0e4e8e75ca22a3a2fda7385`; it is not a release obtainable from that commit or from npm.

Provenance: the handoff built the package with `pnpm build` and `pnpm pack`. SHA-256 of that source package archive: `ad0b84956f99af74534c57aec95dff7a8b8817c25616a35ec7131bf0b5cb8940`. The included `LICENSE` is the archive's original MIT license.

Selected original archive entries:

- `package/dist/view.js` and `package/dist/view.d.ts` — `pi-esp/view` (`mountTranscript`).
- `package/dist/markdown.js` — safe DOM-based renderer; OpenRig bundles its pinned Marked 16.4.2 dependency.
- `package/dist/records.d.ts` — transcript event types only; no record parser executable.
- `package/dist/view.css` — `pi-esp/view.css`.
- `package/LICENSE` — copyright and license notice.

OpenRig applies local fixes to `markdown.js` (loose list paragraphs, inert task indicators, bounded tables, table alignment and entity decoding) and `view.js` (incremental trimming, scroll anchors and ResizeObserver lifecycle), plus `view.css` (tool run indicator, table alignment and list spacing). The declaration `records.d.ts` retains only the transcript type, not the unshipped parser; `view.d.ts` declares the renderer disposal method. The other extracted files remain unchanged. The sibling pi-esp checkout is not modified by these patches.

OpenRig builds from `vendor/pi-esp`, not from a sibling checkout, temporary directory, private registry, or the archive. The shipped plugin includes the bundled view and notices, not the vendor source directory, CLI, server, tailer, discovery code, or archive. OpenRig's asset inventory hashes the vendored build inputs and the staged browser output. To update this snapshot, verify a new package, review the local patches, and refresh the selected files in `vendor/pi-esp`, this provenance note, and the generated assets together.
