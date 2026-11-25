import { writeFile } from 'node:fs/promises';
import { withCleanup } from '../smoke/desktop-test-cleanup.mjs';

export const popupNoteSpacing = {
  buttonToSeparator: 14,
  separatorToHighlight: 10,
  separatorWidth: '1px',
  separatorStyle: 'dotted',
};

export function measurePopupNoteSpacing(section) {
  const button = section.querySelector('#hideMarkupBtn');
  const item = section.querySelector('#highlightList .highlight-item');
  const quote = item.querySelector('.highlight-quote');
  const itemTop = item.getBoundingClientRect().top;
  const style = getComputedStyle(item);
  return {
    buttonToSeparator: itemTop - button.getBoundingClientRect().bottom,
    separatorToHighlight: quote.getBoundingClientRect().top - itemTop,
    separatorWidth: style.borderTopWidth,
    separatorStyle: style.borderTopStyle,
  };
}

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
