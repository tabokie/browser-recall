import { generateSlugFromUrl } from './utils.js';

export function affectsPopupPage(mutation, slug) {
  if (mutation?.affectsPopup === false) return false;
  // List membership also updates the list picker's ordering on other pages.
  if (mutation?.type !== 'history' || !slug) return true;
  const urls = [mutation.url, ...(mutation.urls || [])].filter(Boolean);
  if (!urls.length) return true;
  return urls.some((url) => {
    try {
      return generateSlugFromUrl(url) === slug;
    } catch {
      return true;
    }
  });
}
