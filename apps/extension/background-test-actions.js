export const BACKGROUND_TEST_ACTIONS = [
  'resetForTest',
  'flushDesktopQueueForTest',
  'seedTestData',
  'getDesktopQueueForTest',
];

globalThis.browserRecallBackgroundTestActions = new Set(
  BACKGROUND_TEST_ACTIONS,
);
