# Web Analysis Routing

## Probe-first surfaces

Start with the smallest observable surface: routes, parameters, auth/session state, static assets, API schema, redirects, upload points, webhooks, and cross-origin boundaries.

## High-signal chains

| Chain | Signal | Evidence target |
|---|---|---|
| Input -> template/script sink -> account/session impact | Reflected/stored/DOM input reaches HTML/JS/URL context | source, context, encoding, trigger, impact |
| URL/file parameter -> server-side fetch/read | backend fetches URL or reads path controlled by caller | parser, allowlist, scheme/host/path normalization, response leak |
| Auth confusion -> protected API | token, cookie, tenant, role, org, or user ID not bound to server-side identity | auth source, ownership check, protected data/action |
| Upload/import -> parser or storage sink | uploaded file controls parser, path, MIME, archive entries, metadata, or executable content | upload validation, storage path, parser behavior, sink |
| API object field -> privileged workflow | JSON/graphql/form field selects action, role, callback URL, template, command, or target object | schema, validation, guard, final side effect |
| OAuth/SAML/SSO redirect -> account takeover or token leak | redirect URI, state, audience, issuer, nonce, or callback host is weakly bound | redirect validation, token binding, replay path |

## Rejection rules

Reject when the exact route is unreachable, server-side authorization binds the object to caller identity, untrusted data is encoded for the exact sink context, SSRF is confined to harmless fixed hosts, upload content is never parsed/executed/exposed, or impact is only cosmetic.
