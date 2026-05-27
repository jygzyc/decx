# Pattern: setResult Leak

## When To Use

Use this reference when an Activity returns sensitive extras, file/content URIs, grant flags, tokens, account data, scan output, or internal state through `setResult`.

## Vulnerability Essence

An externally triggered Activity returns sensitive data or grants to an attacker-controlled caller without proving the caller is trusted.

## Sources

- exported Activity launch by attacker
- activity-for-result or Activity Result API callback controlled by caller
- caller-supplied request, URI, account, file, or object that selects returned data

## Sinks

- `setResult(RESULT_OK, intent)`
- returned extras, `data`, `ClipData`, grant flags
- indirect result helpers or finish flows that preserve attacker-selected content

## Required Trace Evidence

- Reachability: attacker can start the Activity for result or receive its result path.
- Controllability: attacker can select the returned data, URI, account, action, or result branch.
- Sink: `setResult` returns sensitive data or usable grant to the caller.
- Missing or bypassable guard: no caller/package/signature/session validation or meaningful user consent.
- Visible impact: data disclosure, URI grant leak, credential/session exposure, or protected workflow bypass.

## Guard Checklist

Consider safe when caller identity is verified, returned data is public/bounded, user confirmation is meaningful and non-bypassable, grants are stripped, and target package is pinned.

## Rejection Rules

Reject when result data is non-sensitive, the Activity is not externally reachable for result, caller cannot influence protected data selection, or a non-bypassable trust check gates the result.

## Rating Mapping

- HIGH: credentials, tokens, private files, or high-value account data returned.
- MEDIUM: bounded sensitive user data or URI grant returned to local attacker.
- LOW: low-value metadata or weak UI result.
- IGNORED: no sensitive output or no attacker-visible result.

## Trace Commands

```bash
decx code xref-method "android.app.Activity.setResult(int,android.content.Intent):void" -P <port>
decx code method-context "<activityFinishFlow>" -P <port>
```

## Example Shapes

Suspicious:

```text
malicious app -> exported picker Activity -> attacker-selected account -> setResult(tokenIntent)
```

Safe:

```text
trusted caller check -> user confirms exact disclosure -> no grants/extras beyond public value
```

## Report Snippet

Use: "The exported Activity returns sensitive result data to an untrusted caller without caller validation."

Avoid: "setResult returns data" without proving the returned data contains sensitive or grant-bearing values visible to the caller.
