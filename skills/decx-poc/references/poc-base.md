# Base PoC Contract

## Template Contract

- Android template: `assets/poc-template-app/`
- Server template: `assets/poc-template-server/`
- Setup: `node skills/decx-poc/scripts/setup-poc.mjs <target>`

## Registration Shape

Register exactly one `exploitId` from the PoC Spec in `ExploitRegistry`.

## Required Edits

- replace package/action/URI/extra/Binder placeholders from PoC Spec;
- register exactly one exploit id for one finding;
- log the spec success signal;
- add helper Manifest components only if `supportComponents` requires them.

## Success Signal

Log the observed effect named by the PoC Spec. Do not log theory-only success.
