import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { launchMacosDocumentationApp } from '../../scripts/lib/macos-native-session.mjs';
import { withCleanup } from './desktop-test-cleanup.mjs';

export const macosAppRegistrar =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

// Own successful registrations so a failed preflight never unregisters a bundle
// merely because the build left the bundle on disk.
export class MacosAppRegistrations {
  #apps = new Set();

  register(app) {
    execFileSync(macosAppRegistrar, ['-f', app]);
    this.#apps.add(app);
  }

  launchDocumentation(app, environment) {
    launchMacosDocumentationApp(app, environment);
    this.#apps.add(app);
  }

  async cleanup() {
    await withCleanup(
      async () => {},
      [...this.#apps].reverse().map((app) => () => {
        unregisterMacosTestApp(app);
        this.#apps.delete(app);
      }),
    );
  }
}

export function unregisterMacosTestApp(app) {
  // Setup can fail before copying the bundle. LaunchServices cannot scan a
  // missing app; existing but invalid bundles must still report cleanup errors.
  if (!existsSync(app)) return;
  execFileSync(macosAppRegistrar, ['-u', app], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
