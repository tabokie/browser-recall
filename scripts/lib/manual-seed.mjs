import { buildSeedFiles } from './seed-builder.mjs';

export async function buildManualSeedFiles(
  events,
  { currentSettings, settings = {}, ...options } = {},
) {
  if (
    !currentSettings ||
    typeof currentSettings !== 'object' ||
    Array.isArray(currentSettings)
  ) {
    throw new Error('buildManualSeedFiles: currentSettings is required');
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('buildManualSeedFiles: settings must be an object');
  }
  return buildSeedFiles(events, {
    ...options,
    baseSettings: currentSettings,
    settings,
  });
}

export async function flushManualSeed(sendMessage) {
  const response = await sendMessage({ action: 'flushDesktopQueueForTest' });
  if (!response?.success) {
    throw new Error(
      `flushDesktopQueueForTest failed: ${JSON.stringify(response)}`,
    );
  }
}

export async function seedManualData({
  events,
  currentSettings,
  deviceId,
  settings,
  entities,
  sendMessage,
}) {
  if (typeof sendMessage !== 'function') {
    throw new Error('seedManualData: sendMessage is required');
  }
  const files = await buildManualSeedFiles(events, {
    currentSettings,
    deviceId,
    settings,
    entities,
  });
  const response = await sendMessage({ action: 'seedTestData', files });
  if (!response?.success) {
    throw new Error(`seedTestData failed: ${JSON.stringify(response)}`);
  }
  await flushManualSeed(sendMessage);
  return files;
}
