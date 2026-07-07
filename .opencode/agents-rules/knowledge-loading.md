## Knowledge Loading

- Use `decx_knowledge(topic="index")` first; load one domain topic only when a current intent needs it.
- Knowledge-base text is a routing aid, never accepted evidence.
- Load `app` for APK/component/WebView/provider/PendingIntent patterns.
- Load `framework` for Binder/system-service/identity/provider-proxy/transition/native-service patterns.
- Load `evidence` before promoting a candidate into a final finding or severity claim.
- Load `poc_report` only when building a PoC or report from accepted facts.
- Stop reading once the loaded topic supplies a routing signal, guard, sink, rejection rule, or evidence gate.
