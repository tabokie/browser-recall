import { createHighlightLifecycle } from '../../packages/core/highlight-lifecycle.js';

const surface = globalThis.browserRecallExtensionSurface;
const note = {
  slug: 'website-sample-note',
  excerpt: ['Leave room for the unfinished things.'],
  cssPath: ['p:nth-of-type(2)'],
  note: 'Leave a little room for curiosity.',
};
const status = (text) =>
  parent.postMessage({ type: 'note-status', text }, location.origin);
const lifecycle = createHighlightLifecycle({
  document,
  onMark(mark) {
    mark.tabIndex = 0;
    mark.setAttribute('role', 'button');
    mark.setAttribute('aria-label', 'Edit highlighted passage');
    const edit = () => {
      surface.createHighlightEditOverlay({
        doc: document,
        view: window,
        rect: mark.getBoundingClientRect(),
        note,
        placeholder: 'Add a note…',
        confirmTitle: 'Save note',
        editTitle: 'Edit note',
        deleteTitle: 'Delete highlight',
        save: async () => {},
        onSaved: () =>
          status('Note saved in this demo. Click the highlight to edit again.'),
        onDelete: () => {
          lifecycle.remove({ noteSlug: note.slug });
          status('Highlight removed in this demo. Reload to start again.');
        },
        onError: (error) => status(error.message),
      });
    };
    mark.addEventListener('click', edit);
    mark.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        edit();
      }
    });
  },
});
lifecycle.applySaved([note]);
