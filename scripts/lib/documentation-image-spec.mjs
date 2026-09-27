export const documentationCaptureSpec = {
  desktop: {
    timeline: {
      layoutPoints: { width: 960, height: 500 },
      outputPixels: { width: 1920, height: 1000 },
    },
    book: {
      layoutPoints: { width: 960, height: 620 },
      outputPixels: { width: 1920, height: 1240 },
    },
  },
  browser: {
    layoutPoints: { width: 800, height: 434 },
    outputPixels: { width: 1600, height: 868 },
  },
};

export const documentationImagePixels = {
  'timeline.png': documentationCaptureSpec.desktop.timeline.outputPixels,
  'timeline-mono.png': documentationCaptureSpec.desktop.timeline.outputPixels,
  'timeline-styles.png': documentationCaptureSpec.desktop.timeline.outputPixels,
  'book.png': documentationCaptureSpec.desktop.book.outputPixels,
  'browser-popup-window.png': documentationCaptureSpec.browser.outputPixels,
  'browser-note-window.png': documentationCaptureSpec.browser.outputPixels,
};
