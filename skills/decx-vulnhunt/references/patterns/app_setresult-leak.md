---
name: setresult-leak
track: app
---

# setresult-leak

## Match
Externally triggered Activity returns sensitive data/URI/grant flags/internal state through `setResult` or finish helper.

## Non-obvious
- `setResult` is "Intent redirect in reverse" — same primitive, opposite direction; cross-check `startActivityForResult` entry
- Identity page calling `setResult(RESULT_OK, sensitiveIntent)` on EVERY exit path (cancel/back/finish) leaks on any caller
- Caller-supplied Intent returned verbatim — caller pre-loads `FLAG_GRANT_*` and `content://` URI; result grants victim's FileProvider
- **RequestCode branch as permission router** — attacker routes through victim's `READ_CONTACTS`/`SEND_SMS` permission via the vulnerable activity
- Caller inherits victim's runtime permissions for duration of result path
- Helper methods named `finishXxx()` may call `setResult` even when the Activity method looks harmless

## Reject
Result data non-sensitive, activity not externally reachable for result, or success path has non-bypassable trust check.
