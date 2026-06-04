# DECX Agent Templates

These templates turn DECX skill workflows into `decx-agent` task configs.

Copy one template directory into a session workspace, edit `task.json`, then run:

```bash
decx-agent run .decx/agent_tasks/<session>/task.json --worker codex --max-steps 8
```

Each template keeps the workflow inside `task.json` and `prompts/` instead of relying on a live skill loader. The `skills` array is retained as reference context for workers that can read the repository, but the actionable contract is in the role prompts.

## Templates

- `app-vulnhunt`: Android APK exported component, deep link, Provider, Receiver, Service, WebView, and app IPC vulnerability hunting.
- `framework-vulnhunt`: Android framework, `system_server`, Binder service, AIDL implementation, and privileged IPC vulnerability hunting.

## Required Edits

Before running, update these fields in `task.json`:

- `task.session`
- `task.target`
- `task.goal`, if the default goal is too broad
- prompt placeholders such as `<apk-path>`, `<processed-framework-dir>`, `<target-name>`, `<port>`, `<adb>`, and `<serial>`
- worker selection if `codex` is not the desired backend
