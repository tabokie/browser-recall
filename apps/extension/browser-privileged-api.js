export function requirePrivilegedBrowserApis(requiredNamespaces) {
  // Firefox content contexts intentionally omit privileged namespaces. Keep
  // this validation at privileged entry points, never in the shared adapter.
  const adapter = globalThis.browserRecallWebExtension;
  if (!adapter) {
    throw new Error('Browser Recall WebExtension adapter is not installed');
  }
  if (adapter.executionContext === 'content') {
    throw new Error('Privileged WebExtension APIs are unavailable in content');
  }
  for (const namespace of requiredNamespaces) {
    if (!adapter.api?.[namespace]) {
      throw new Error(
        `Browser Recall requires the privileged ${namespace} API in ${adapter.executionContext}`,
      );
    }
  }
  return adapter.api;
}
