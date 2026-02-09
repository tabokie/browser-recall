// Content script for capturing user intent and attention
console.log('Portal content script loaded on:', window.location.href);
let currentInteractionId = null;
let attentionData = {
  scrollDepth: 0,
  timeOnPage: 0,
  highlights: [],
  clicks: 0
};

let startTime = Date.now();
let maxScrollDepth = 0;

// Track scroll depth
window.addEventListener('scroll', () => {
  const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
  const currentScroll = window.scrollY;
  const depth = scrollHeight > 0 ? (currentScroll / scrollHeight) * 100 : 0;
  maxScrollDepth = Math.max(maxScrollDepth, depth);
  attentionData.scrollDepth = maxScrollDepth;
});

// Track clicks
document.addEventListener('click', () => {
  attentionData.clicks++;
});

// Track text selection (highlights)
document.addEventListener('mouseup', () => {
  const selection = window.getSelection();
  const selectedText = selection.toString().trim();

  if (selectedText.length > 10) {
    attentionData.highlights.push({
      text: selectedText,
      timestamp: Date.now(),
      context: getSelectionContext(selection)
    });
  }
});

function getSelectionContext(selection) {
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const element = container.nodeType === 3 ? container.parentElement : container;

    return {
      tagName: element.tagName,
      className: element.className,
      id: element.id
    };
  }
  return null;
}

// Extract user intent from search queries or input fields
function extractIntent() {
  const intents = [];

  // Check URL for search parameters
  const url = new URL(window.location.href);
  const searchParams = ['q', 'query', 'search', 's', 'term'];

  searchParams.forEach(param => {
    const value = url.searchParams.get(param);
    if (value) {
      intents.push({ type: 'search', value });
    }
  });

  // Check for input fields (search boxes)
  const searchInputs = document.querySelectorAll('input[type="search"], input[name*="search"], input[name*="query"]');
  searchInputs.forEach(input => {
    if (input.value) {
      intents.push({ type: 'input', value: input.value });
    }
  });

  return intents;
}

// Extract meaningful content from the page
function extractContent() {
  // Remove script, style, and navigation elements
  const clone = document.cloneNode(true);
  ['script', 'style', 'nav', 'header', 'footer'].forEach(tag => {
    clone.querySelectorAll(tag).forEach(el => el.remove());
  });

  // Get text content
  const text = clone.body?.textContent || '';

  // Clean and truncate
  const cleaned = text
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 5000); // Limit to 5000 chars

  return cleaned;
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Content script received message:', request);

  if (request.action === 'captureInteraction') {
    currentInteractionId = request.interactionId;

    // Calculate time on page
    attentionData.timeOnPage = Date.now() - startTime;

    // Extract intent and content
    const intent = extractIntent();
    const content = extractContent();

    console.log('Captured data - Intent:', intent.length, 'Content length:', content.length);

    // Send data back to background script
    chrome.runtime.sendMessage({
      action: 'updateInteraction',
      interactionId: currentInteractionId,
      intent: JSON.stringify(intent),
      content: content,
      attention: attentionData
    });

    console.log('✓ Sent data back to background');
    sendResponse({ success: true });
  }

  return true;
});

// Before unload, send final attention data
window.addEventListener('beforeunload', () => {
  if (currentInteractionId) {
    attentionData.timeOnPage = Date.now() - startTime;

    chrome.runtime.sendMessage({
      action: 'updateInteraction',
      interactionId: currentInteractionId,
      attention: attentionData
    });
  }
});
