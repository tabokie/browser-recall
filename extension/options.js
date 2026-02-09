// Load settings
chrome.storage.local.get(['settings', 'interactions'], (result) => {
  const settings = result.settings || {};

  document.getElementById('captureContent').checked = settings.captureContent !== false;
  document.getElementById('captureAttention').checked = settings.captureAttention !== false;
  document.getElementById('archiveQuality').value = settings.archiveQuality || 'medium';

  // Update statistics
  const interactions = result.interactions || [];
  document.getElementById('totalInteractions').textContent = interactions.length;

  const today = new Date().setHours(0, 0, 0, 0);
  const todayCount = interactions.filter(i => i.timestamp >= today).length;
  document.getElementById('todayInteractions').textContent = todayCount;

  // Calculate storage size
  const size = new Blob([JSON.stringify(interactions)]).size;
  const kb = (size / 1024).toFixed(2);
  document.getElementById('storageUsed').textContent = `${kb} KB`;
});

// Save settings on change
['captureContent', 'captureAttention', 'archiveQuality'].forEach(id => {
  const element = document.getElementById(id);
  element.addEventListener('change', () => {
    chrome.storage.local.get(['settings'], (result) => {
      const settings = result.settings || {};

      if (id === 'archiveQuality') {
        settings[id] = element.value;
      } else {
        settings[id] = element.checked;
      }

      chrome.storage.local.set({ settings });
      showStatus('Settings saved', 'success');
    });
  });
});

// Export data
document.getElementById('exportBtn').addEventListener('click', () => {
  chrome.storage.local.get(['interactions'], (result) => {
    const data = JSON.stringify(result.interactions || [], null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `portal-export-${new Date().toISOString().split('T')[0]}.json`;
    a.click();

    URL.revokeObjectURL(url);
    showStatus('Data exported successfully', 'success');
  });
});

// Clear all data
document.getElementById('clearBtn').addEventListener('click', () => {
  if (confirm('Are you sure you want to clear all interaction data? This cannot be undone.')) {
    chrome.storage.local.set({ interactions: [] }, () => {
      document.getElementById('totalInteractions').textContent = '0';
      document.getElementById('todayInteractions').textContent = '0';
      document.getElementById('storageUsed').textContent = '0 KB';
      showStatus('All data cleared', 'success');
    });
  }
});

function showStatus(message, type) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = `status ${type}`;

  setTimeout(() => {
    status.className = 'status';
  }, 3000);
}
