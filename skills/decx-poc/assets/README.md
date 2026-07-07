# PoC Assets

Source templates only. Do not store generated build/cache output here.

## Templates

- `poc-template-app/` → copied to `poc-<target>/app/`
- `poc-template-server/` → copied to `poc-<target>/server/`

## Edit Rules

- Replace placeholders only from accepted DAG evidence or PoC Spec.
- Keep one exploit id per finding.
- Add helper components only when the finalized finding requires them.
- Do not commit generated `.gradle/`, `build/`, or output APK files.
