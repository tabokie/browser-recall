import process from 'node:process';

function artifactPlatform(platform) {
  if (platform === 'darwin' || platform === 'macos') return 'macos';
  if (platform === 'win32' || platform === 'windows') return 'windows';
  return platform;
}

export function desktopBuildPlan(
  platform = process.platform,
  purpose = 'local',
) {
  const normalizedPlatform = artifactPlatform(platform);
  const isMacos = normalizedPlatform === 'macos';
  if (!['local', 'release', 'dmg'].includes(purpose))
    throw new Error('Unsupported desktop build purpose');
  if (purpose === 'dmg' && !isMacos)
    throw new Error('Disk-image builds require macOS');
  if (
    purpose === 'release' &&
    !['macos', 'windows'].includes(normalizedPlatform)
  )
    throw new Error('Release builds require macOS or Windows');
  const bundles = isMacos ? ['app'] : purpose === 'release' ? ['nsis'] : [];
  return Object.freeze({
    artifactPlatform: normalizedPlatform,
    bundles: Object.freeze(bundles),
    finalizeMacosApp: isMacos,
    tauriArgs: Object.freeze(
      bundles.length
        ? ['build', '--bundles', bundles.join(',')]
        : ['build', '--no-bundle'],
    ),
    verifyMacosApp: isMacos,
  });
}
