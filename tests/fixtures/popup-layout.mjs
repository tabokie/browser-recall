import { writeFile } from 'node:fs/promises';
import { withCleanup } from '../smoke/desktop-test-cleanup.mjs';

export async function withPopupLayout(testInfo, name, run, getLayout) {
  await withCleanup(run, [
    async () => {
      const output = testInfo.outputPath(`${name}.json`);
      await writeFile(output, JSON.stringify(getLayout() ?? null, null, 2));
      await testInfo.attach(name, {
        path: output,
        contentType: 'application/json',
      });
    },
  ]);
}
