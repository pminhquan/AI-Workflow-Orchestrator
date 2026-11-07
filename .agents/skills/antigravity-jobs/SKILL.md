---
name: antigravity-jobs
description: Submit briefs in the selected Antigravity GUI chat in the background and follow their per-job status files.
---

# Antigravity jobs

Use `antigravity_gui.submit_job` with the current absolute `workspace_root` and the full `request`. Choose a UUID as `job_id` before sending so a retry refers to the same job. The user chooses the chat, project and model on the Antigravity GUI. The sender uses that selection and preserves unrelated drafts.

Confirm `delivery.status` is `submitted`. The delivery record shows the project, selected model and foreground check. If the sender reports `not_sent`, resolve the stated issue and retry with the same UUID and brief. If it reports `uncertain`, inspect the chat or job status before another submission.

Keep the returned `job_path`. Work on an independent part of the request and use `antigravity_gui.job_status` with the same workspace and exact job path every five minutes. The job file carries progress and the final summary, changed files and checks.

If this Codex session has not loaded the MCP tools yet, use the same sender through its CLI. Save the full brief to an ignored request file first.

```text
node "{{WORKFLOW_ROOT}}/src/chat-jobs.mjs" submit --workspace "<absolute workspace>" --request-file "<brief file>" --job-id "<UUID>"
node "{{WORKFLOW_ROOT}}/src/chat-jobs.mjs" status --workspace "<absolute workspace>" --job "<job_path>"
```

`inspect_gui` (or CLI `inspect`) reads the GUI selection without sending. If the GUI project label differs from the folder name, use `project_name` (CLI `--project-name`) only after verifying that label belongs to this workspace.
