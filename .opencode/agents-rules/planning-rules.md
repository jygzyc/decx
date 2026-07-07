## Planning Rules

- Start from the smallest executable intent that can change graph state.
- Do not plan "understand everything" tasks. Plan one bounded question with a concrete evidence target.
- Use probe-first ordering: inspect the cheapest high-signal surface, observe feedback, then focus.
- Before spawning Explorer, ensure no unhandled open hint exists.
- Before spawning Evaluator, ensure the target fact is still `candidate`.
- Do not create near-duplicate intents if an accepted fact, rejected fact, failed intent, or open hint already covers the route.
- Cross-session observations are leads only; write current-session state explicitly before using them for decisions.
