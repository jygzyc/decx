# Provider - Overview - Security Review

Use this overview for ContentProvider CRUD, `call()`, file, batch, and FileProvider targets. For signal-to-pattern routing, start with `vulnerability-router.md`.

## Analysis Flow

```text
1. decx ard exported-components -P <port>
   -> locate exported providers and authorities
2. decx code class-context "<ProviderClass>" -P <port>
   -> quick overview of overridden CRUD methods, call(), openFile
3. decx code class-source "<ProviderClass>" -P <port>
   -> inspect query / insert / update / delete / openFile / call / applyBatch / bulkInsert
4. Check:
   -> manifest permission on the provider
   -> per-method caller validation
   -> per-URI and per-row validation
   -> path normalization and root confinement
5. Track whether the provider can expose:
   -> account rows, tokens, chat history, files, config data
   -> attacker-controlled writes into sensitive tables
```

## Promotion Signals

- attacker can reach the authority/method
- provider-level permission or per-method guard is missing or bypassable
- untrusted URI, selection, projection, values, path, or method args reach sensitive data/action
- returned rows/files/oracles have security value
- provider configuration and oracles often support another chain; promote standalone only when attacker reachability and direct security value are proven

## Common False Positives

- Provider is exported but all sensitive methods enforce a non-bypassable signature permission
- `getType()` only reveals a generic MIME type with no file-existence oracle
- Batch support exists but every operation is revalidated per caller and per target URI
