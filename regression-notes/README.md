# Regression notes tooling (vendored)

`scripts/verify-notes.py` and `scripts/new-note.py` (plus `templates/`) are
vendored from the `regression-notes` skill:

- Source: <https://github.com/meimingqi222/my-agent-skills/tree/main/regression-notes>
- Version: 0.7.0 (commit `e5c6d1f`; this version adds the duplicate guard,
  `spec-change`, `--metrics` and `--bound-changes`)
- License: Apache-2.0

The notes live in `.agents/notes/`; red-run evidence lives in
`.agents/notes-evidence/`. The standing rule and the edit-time reverse lookup
are in `AGENTS.md` under "Regression Notes".

Useful commands:

```bash
python3 regression-notes/scripts/verify-notes.py --notes-dir .agents/notes
python3 regression-notes/scripts/verify-notes.py --notes-dir .agents/notes --for-path src/lib/quota/refresh.ts
python3 regression-notes/scripts/verify-notes.py --notes-dir .agents/notes --find "rest registry"
python3 regression-notes/scripts/verify-notes.py --notes-dir .agents/notes --metrics
python3 regression-notes/scripts/verify-notes.py --notes-dir .agents/notes --bound-changes --base origin/master
python3 regression-notes/scripts/new-note.py --status implemented --test tests/foo.test.ts some-slug
```

To update, copy the same files from the source skill, bump the version above,
then run the verifier and its tests.
