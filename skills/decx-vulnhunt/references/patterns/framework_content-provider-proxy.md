---
name: content-provider-proxy
track: framework
---

# content-provider-proxy

## Match
Binder input reaches `ContentResolver`/provider proxy/URI grant/FD/`call`/stored grant under system/cleared/framework identity.

## Non-obvious
- `applyBatch`/`call()` per-operation guard bypass: See [[framework_permission-missing]]
- `openFileDescriptor` returns `ParcelFileDescriptor` to caller-influenced path — FD usable across process boundaries
- `FileProvider` with broad `<root-path>` is the leak primitive — path scope matters, not provider presence
- Persistent grant via `grantUriPermission` + `takePersistableUriPermission`: See [[app_uri-grant]]
- `Uri.getUserInfo()` and `Uri.getQueryParameter` are attacker control surfaces even with safe-looking authority
- Cross-user content URI `content://<userId>@authority/path`: See [[framework_identity-confusion]]
- Authority allowlist must be constant (`Settings.AUTHORITY`, `Telephony.Carriers.AUTHORITY`), not substring check
- Original-caller provider permission requires `enforceCallingOrSelfPermission` on provider's own gate, not just proxy caller

## Reject
Provider data is public/caller-owned, URI is trusted constant, provider enforces original-caller permission at URI path level, returned data fully filtered, or authority/path/user allowlisted.
