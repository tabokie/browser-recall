export function extensionBrowserChannel() {
  const channel = process.env.BROWSER_RECALL_PLAYWRIGHT_ENGINE;
  if (!channel) return 'chromium';
  // Google Chrome and Microsoft Edge no longer support the command-line flags
  // that load unpacked extensions. Reject them before allocating browser resources.
  throw new Error(
    `Extension browser checks do not support ${channel}; use pinned Chromium`,
  );
}
