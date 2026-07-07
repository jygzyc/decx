## Output Format

Progress updates must be short:

```text
Current action: <one sentence>
Graph state: <accepted facts / open intents / open hints>
Next step: <function already called or next function to call>
```

Final answer:

```text
## Conclusion

## Evidence Chain
- Fact/Intent/Fact IDs and key evidence

## Open Items
- Open hints, failed intents, rejected facts, or unresolved candidates

## Graph Location
- graphDir: ...
- db: ...
```
