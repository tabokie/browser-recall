function windowCaptureSpec(width, height) {
  const paddingPoints = 40;
  return {
    layoutPoints: { width, height },
    paddingPoints,
    outputPixels: {
      width: (width + paddingPoints * 2) * 2,
      height: (height + paddingPoints * 2) * 2,
    },
  };
}

export const documentationWallpaper = {
  name: 'Sonoma, Light (Still)',
  file: 'scripts/assets/documentation-sonoma-light.png',
  crop: 'center-cover',
};

export const documentationCaptureSpec = {
  desktop: {
    timeline: windowCaptureSpec(960, 620),
    book: windowCaptureSpec(960, 620),
  },
  browser: windowCaptureSpec(800, 434),
};

export const documentationImagePixels = {
  'timeline.png': documentationCaptureSpec.desktop.timeline.outputPixels,
  'timeline-mono.png': documentationCaptureSpec.desktop.timeline.outputPixels,
  'timeline-styles.png': documentationCaptureSpec.desktop.timeline.outputPixels,
  'book.png': documentationCaptureSpec.desktop.book.outputPixels,
  'browser-popup-window.png': documentationCaptureSpec.browser.outputPixels,
  'browser-note-window.png': documentationCaptureSpec.browser.outputPixels,
};
