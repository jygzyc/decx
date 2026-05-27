# Pattern: WebView Cookie Theft

## When To Use

Use this reference when attacker-controlled WebView content can receive, set, sync, or exfiltrate authentication cookies, session headers, tokens, or trusted account state.

## Vulnerability Essence

Untrusted content enters a WebView that shares sensitive cookie/session state with trusted origins or native bridge workflows.

## Sources

- attacker-controlled URL/redirect/HTML
- weak domain matching, cookie injection, third-party cookie policy, shared CookieManager state
- deep link or scan result controlling authenticated WebView navigation

## Sinks

- `CookieManager.getCookie`, `setCookie`, third-party cookie access
- authenticated WebView page load on attacker-controlled domain
- bridge/native action using session-bound WebView state

## Required Trace Evidence

- Reachability: attacker controls or influences loaded WebView content/domain.
- Controllability: attacker can receive cookie-bearing requests, inject cookie state, or trigger session-bound actions.
- Sink: sensitive cookie/token/session state is exposed or used for unauthorized action.
- Missing or bypassable guard: no exact origin isolation, cookie partitioning, trusted-domain pinning, or logout/session scoping blocks the path.
- Visible impact: account/session theft, authenticated action, or credential leakage.

## Guard Checklist

Consider safe when attacker content never shares the authenticated WebView profile, cookies are scoped to exact trusted domains, third-party cookies are disabled where needed, and native actions do not trust web session state alone.

## Rejection Rules

Reject when only public cookies are involved, attacker cannot control the loaded origin, session cookies are not sent or readable, or no authenticated state/action is reachable.

## Rating Mapping

- HIGH: no-interaction credential/session theft or authenticated native action.
- MEDIUM: session abuse requiring stronger interaction or bounded scope.
- LOW: low-value cookie metadata only.
- IGNORED: cookie APIs exist but no attacker-controlled origin receives sensitive state.

## Trace Commands

```bash
decx code xref-method "android.webkit.CookieManager.getCookie(java.lang.String):java.lang.String" -P <port>
decx code method-context "<webviewNavigationMethod>" -P <port>
```

## Example Shapes

Suspicious:

```text
authentication cookies shared across WebView -> attacker-controlled page loaded in same WebView instance -> cookies sent to attacker domain
```

Safe:

```text
WebView uses isolated session or separate CookieManager -> no shared auth cookies with external content
```

## Report Snippet

Use: "Attacker-controlled WebView content can access or receive authentication cookies from a trusted session context."

Avoid: "WebView has cookies enabled" without proving authentication cookies reach attacker-controlled content.
