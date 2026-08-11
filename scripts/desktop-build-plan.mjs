import process from 'node:process';

function artifactPlatform(platform) {
  if (platform === 'darwin' || platform === 'macos') return 'macos';
  if (platform === 'win32' || platform === 'windows') return 'windows';
  return platform;
}

export function desktopBuildPlan(platform = process.platform) {
  const normalizedPlatform = artifactPlatform(platform);
  const isMacos = normalizedPlatform === 'macos';
  return Object.freeze({
    artifactPlatform: normalizedPlatform,
    bundles: Object.freeze(isMacos ? ['app'] : []),
    finalizeMacosApp: isMacos,
    tauriArgs: Object.freeze(
      isMacos ? ['build', '--bundles', 'app'] : ['build', '--no-bundle'],
    ),
    verifyMacosApp: isMacos,
  });
}
