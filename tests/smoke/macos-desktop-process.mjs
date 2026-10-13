import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export const macosAppRegistrar =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

export function unregisterMacosTestApp(app) {
  // Setup can fail before copying the bundle. LaunchServices cannot scan a
  // missing app; existing but invalid bundles must still report cleanup errors.
  if (!existsSync(app)) return;
  execFileSync(macosAppRegistrar, ['-u', app], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
