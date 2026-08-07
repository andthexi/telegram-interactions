# Migration inventory scaffolding

No production inventory or migration has been run.

`pre-cutover-inventory.json` is a non-operational placeholder. The exported
`createSnapshotInventory` helper accepts only caller-supplied source paths and selectors, refuses
to overwrite a manifest, creates read-only copies, hashes them, records counts rather than row
bodies, and restore-checks SQLite snapshots. It has no built-in Hermes paths.

Before any future live capture, pause the owning workflow, review exact sources and closed-graph
selectors, choose a new manifest path (the placeholder is intentionally non-overwritable), and
obtain separate cutover approval.
