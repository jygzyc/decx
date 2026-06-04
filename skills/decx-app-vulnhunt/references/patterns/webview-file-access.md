# Pattern: WebView File Access

## When To Use

Use this reference when attacker-controlled WebView content interacts with `file://`, `content://`, universal file URL access, asset loaders, local HTML, or URI grants.

## Core Concept

Untrusted web content gains script or navigation access to local app/private resources because WebView file/content access is enabled without strict origin separation.

**Sources**
- deep link, scan result, redirect, external Intent, or remote config controlling URL/HTML/base URL; `loadUrl("file://...")`, `loadDataWithBaseURL`, `WebViewAssetLoader`; `setAllowFileAccess`, `setAllowContentAccess`, `setAllowUniversalAccessFromFileURLs`, `setAllowFileAccessFromFileURLs`.

**Sinks**
- file/content reads from WebView renderer; JavaScript exfiltration to attacker-controlled network origin; bridge calls using data loaded from local files.

## Guards & Rejection

Safe when: file/content access is disabled for untrusted content, local assets are served through constrained loaders, external navigation is blocked before local access, and sensitive cookies/bridges are unavailable.

Reject when: only trusted packaged assets load, attacker cannot inject script or choose a local target, exposed files are public/non-sensitive, or origin policy prevents exfiltration and bridge access.

## Rating

- HIGH: app-private file/token/session disclosure or bridge chain.
- MEDIUM: bounded local file disclosure requiring local malicious app/user interaction.
- LOW: low-value local metadata exposure.
- IGNORED: setting is enabled but no attacker-controlled content reaches it.

## Trace Commands

```bash
decx code xref-method "android.webkit.WebSettings.setAllowFileAccess(boolean):void" -P <port>
decx code method-context "<webviewSetupOrLoadMethod>" -P <port>
```

## Example Shapes

Suspicious:

```text
external URL -> loadDataWithBaseURL(file://app/) -> attacker JS -> read local content
```

Safe:

```text
trusted asset loader -> no external script -> file/content access disabled for external pages
```

Report guidance -- Use: "Attacker-controlled WebView content can access local app resources because file/content access is enabled without origin isolation." Avoid: "file access is enabled" without proving attacker-controlled content can read local files.
