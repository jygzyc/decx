# PoC Spec

Build one spec before writing code.

## Required Fields

- findingId
- targetKind
- entry
- impact
- trigger
- controllableInput
- guardOutcome
- sink
- impact
- successSignal
- requirements
- pocShape
- supportComponents
- exploitId

## Rules

- Every field must come from the finalized finding writeup or its evidence artifacts.
- Stop before project creation if any required field is missing.
- One spec maps to one exploit id.
- Do not infer helper components or acquisition steps.
