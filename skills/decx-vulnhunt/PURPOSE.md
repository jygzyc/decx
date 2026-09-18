# PURPOSE.md — decx-vulnhunt

Maintenance metadata for `decx_maintain` / `decx_propose`; not read during execution (see `skills/AGENTS.md`).

## Motivating patterns

- App track (`wiki/patterns/android-app-*.md`, e.g. `android-app-exported_access`,
  `android-app-intent_redirect`, `android-app-uri_grant`, `android-app-webview-*`, `android-app-pendingintent`):
  APK hunting fails on permission/identity defaults and on component binding rules,
  not on missing Android API knowledge, so each card pins one non-obvious default
  plus its reject rule.
- Framework track (`wiki/patterns/android-framework-*.md`, e.g.
  `android-framework-pendingintent`, `android-framework-identity_confusion`,
  `android-framework-content_provider_proxy`, `android-framework-native_surface`): Binder
  trust-boundary semantics — caller identity, appop vs permission, user binding —
  are the main source of both false positives and false negatives, so the cards pin
  the boundary check and the evidence a finding needs.
- Native track (`wiki/patterns/native-*.md`, currently `native-kernel_modules`):
  a `.ko` ET_REL object has no manifest and no component registry, so routing starts from
  the dispatch a caller can reach (`ioctl` / `file_operations`) and from what kuna reports
  for that object; the card pins the empty-result meanings that otherwise read as dead ends.
- No process track: stage order, artefact identity, the second-source-of-truth rule and the
  handoff contract are this skill's own `## Process Discipline` section, not cards.

## What the skill must keep

- The evidence gates and the `## Finding Writeup` field contract in `SKILL.md`:
  they are the interface consumed by `decx-report` and `decx-poc`.
- Separation of authority: routing in `<track>-chains.md`, rating in
  `risk-rating.md`, per-signal quirks in the runtime cards
  `references/patterns/<track>-*.md`, execution in `SKILL.md`.
- Stateless native tool usage: every command carries the artifact path; no session
  state is assumed.

## Duplicated runtime cards

`references/patterns/android-app-*.md`, `references/patterns/android-framework-*.md` and
`references/patterns/native-*.md` are runtime
copies of the 27 wiki pages (16 app, 10 framework, 1 native): the wiki page is the maintenance record
(evidence and history) and the card is the tripwire the agent loads. Editing a card
without its wiki page — or retiring a wiki page without its card — is the trigger
to regenerate the other.

## Current state

Bootstrap: the 27 runtime cards came from authored cards and a few traced hunts — no measured rollout score, no gated proposal.
