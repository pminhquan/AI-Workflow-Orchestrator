# Sanitized foundation review snapshot

Canonical source → sanitized export → private GitHub review. Edit the canonical project only; this directory is disposable publication output.

Source implementation and test files are copied byte for byte. The deployment manifest intentionally has no installed machine targets or private baseline hashes. Two private legacy JSON snapshots are omitted. Machine-specific audit documents are replaced with omission notices; README checkout paths are placeholders. See PUBLICATION-MANIFEST.json for projections and exact output hashes.

Run node src/cli.mjs test and node src/cli.mjs validate. The V1 checksum test and node src/cli.mjs verify-v1 cannot validate a live installation from this snapshot: the private V1 baseline is deliberately absent. Report that failure; never insert an empty or synthetic passing baseline. Other tests still run. Historical acceptance documents describe the original foundation, not a new verification of this snapshot.

No original .git directory, author email, private runtime state or V1 settings are exported. No integration has been activated. package.json retains its existing license declaration; upstream attribution and pinned research are preserved.

Update and pre-push procedure: docs/operations/private-publication.md.
