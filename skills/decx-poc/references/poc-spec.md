# PoC Spec

Build one spec before writing code.

Input: one finalized finding writeup following the `decx-vulnhunt` Finding Writeup contract; writeup field names are authoritative. Overlapping fields share names with the writeup: `trigger`, `impact`, `evidence`.

## Required Fields

- findingId
- targetKind
- entry
- impact
- trigger
- controllableInput
- guardOutcome (conclusion of the `guard` step in the writeup's `path`)
- sink
- evidence
- successSignal
- requirements
- pocShape
- supportComponents
- exploitId

## Rules

- Every field must come from the finalized finding writeup or its evidence artifacts.
- Stop before project creation if any required field is missing.
- Do not infer helper components or acquisition steps.
