# Private publication workflow

Canonical project → sanitized export → GitHub PRIVATE. The canonical project remains the only place to edit source. Publication output is derived and must not become another development branch or source of truth. The export commands perform local file operations only: they do not initialize a repository, add a remote, create GitHub resources or push.

## Export and freshness

Run from the canonical project, supplying a separate directory outside it or the guarded ignored staging directory described below:

```powershell
node scripts/publication.mjs export '<PUBLICATION_DIRECTORY>'
node scripts/publication.mjs verify '<PUBLICATION_DIRECTORY>'
```

`config/publication/allowlist.json` explicitly classifies required source files, optional license/notice files, exclusions and copy/projection modes. New tracked or non-ignored untracked files block export until reviewed and classified. Ignored files inside source/config/docs/test areas also require explicit classification: for example, a new JSONL fixture must not silently vanish from review. Root runtime/cache directories are excluded, and nothing is copied merely because it exists or Git ignores it. Required files may not disappear silently. Symlinks, traversal, binary files, oversized files, credential patterns, unclassified opaque values and personal paths/emails fail closed. The scan runs on approved inputs before redaction and on final output; findings contain paths/rules only. The conservative built-in scanner has finite coverage and complements GitHub push protection; it does not prove all possible secret formats are absent.

Source, tests, roles, recipes, generated compiler artifacts, pinned research and attribution are copied byte for byte. README checkout paths become `<REVIEW_CHECKOUT>`. The publication deployment manifest has null installed targets, and non-staged machine baseline references/hashes are removed. Two machine-audit documents become omission notices. The two legacy JSON snapshots are excluded. No copied `.git`, local auth, runtime state, private audit logs or original commit identity is part of the export. No new license is granted: preserve package.json's existing declaration and any reviewed LICENSE/NOTICE files.

The exported `.gitattributes` appends `* -text` so Git preserves the exact verified bytes instead of normalizing CRLF/LF during commit or checkout. The canonical `.gitattributes` is unchanged. This is a publication Git-storage rule, not a source-code transformation.

`PUBLICATION-MANIFEST.json` records output hashes, projections, exclusions, canonical base commit and a fingerprint of approved working-tree inputs. A base commit is provenance; uncommitted source changes are captured explicitly by their bytes/fingerprint. Export is deterministic for the same inputs and base commit: no current timestamp, absolute source path or random identifier is written to final files. Runtime/ignored changes do not make source stale. `verify` rebuilds the plan from the current canonical source and rejects stale, edited or extra files. It also rechecks inputs after the operation to detect concurrent edits. This is a local consistency check, not OS isolation against hostile concurrent processes.

Refresh uses the same export command. It verifies ownership and all existing output hashes first, refuses manual edits/unclassified files, updates only derived files and deletes only individually verified obsolete owned paths. An interrupted write leaves verification failing; rerun/recover locally before publication. Keep test logs outside the export. `.git` is preserved only for an already-owned publication directory; local branch/tag history must contain publication manifests, matching file hashes, no secrets/private paths and ID+login GitHub noreply identities. Original canonical history fails this gate. Other internal refs are not approved for push.

## Checks and honest limitations

Run the full suites in both trees and report them separately:

```powershell
node src/cli.mjs test
node src/cli.mjs validate
node src/cli.mjs verify-v1
```

On the canonical machine, `verify-v1` compares the unchanged private baseline. If a live file drifts, investigate it without updating the baseline or weakening checks. In publication output, the V1 baseline is intentionally unavailable, so its test and command fail. Do not fake a passing baseline, skip that test or report the entire suite green. Remaining offline tests still run. Null deployment targets intentionally prevent machine-specific inventory/install references; routing, scheduling, compiler and verification code are unchanged. `validate` must pass. Compiler changes must still go through the canonical compiler, never handwritten generated output.

Portability improvements, if desired later: accept an explicitly supplied local V1 inventory and deployment-target configuration, distinguish `UNAVAILABLE` from `DRIFT`, and separately label host-integration tests. That is a scoped future implementation requiring tests; this export does not refactor the deployment or verification implementation.

## Future approved publication

First review fresh canonical/export test results and security scan. Obtain the account ID/login through the read-only official GitHub CLI and derive the GitHub-provided `ID+USERNAME@users.noreply.github.com` format. Confirm the actual noreply address in GitHub email settings when needed. Do not copy original author/committer metadata or change global Git identity. GitHub reference: https://docs.github.com/en/account-and-profile/reference/email-addresses-reference

Only after explicit publication approval, initialize the exported directory with clean history, configure its local identity, add the verified export files and commit. Use command-scoped ID+login noreply author/committer identity as well so environment overrides cannot leak another email. Run canonical `verify` again; it checks publication branch/tag history. Create the remote explicitly PRIVATE, inspect the GitHub API visibility before pushing only `refs/heads/main:refs/heads/main`, with followTags disabled. Verify remote HEAD, file inventory and visibility after push. Never mirror or push all refs; preserve GitHub secret-protection failures. Creating or pushing remains a separate approval gate.

For later updates: edit canonical → tests/validate → commit reviewed canonical changes if desired → export into the owned publication directory → full tests with known environment limitations reported → fresh `verify` → inspect export diff → commit only the derived changes using local noreply identity → fresh `verify` of snapshot and publication history → explicitly approved push of main → verify remote SHA. No GitHub-to-canonical or publication-to-canonical source sync is permitted. A new source file requires a policy decision, not automatic wildcard inclusion.

## V2.2 local review staging

For this release all writes stay in canonical root. Export to guarded ignored `state/publication/v22-review` with the existing exporter, then run verify and security/freshness checks. Only a single lowercase named child of `state/publication/` is permitted inside canonical; source paths, the root and nested destinations remain forbidden. The directory is excluded from publication inventory by the existing state ignore rule. It is a sanitized review artifact, not an installed project or an automatic GitHub update. Keep a before/after manifest diff in ignored state. No remote or push is created.
