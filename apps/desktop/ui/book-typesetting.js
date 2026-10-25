import { justify } from './vendor/justif/index.js';
import { hyphenateEnUS } from './vendor/justif/hyphenate/en-us.js';

export function justifyBookParagraph(paragraph, onSkip) {
  const options = {
    hyphenate: hyphenateEnUS,
    hangingPunctuation: 'all-lines',
    lastLineMinWidth: 0.5,
    onSkip,
  };
  if (paragraph.matches('.detail-note-content')) options.pretolerance = -1;
  return justify(paragraph, options);
}
