const scanBtn = document.getElementById('scanBtn');
const clearBtn = document.getElementById('clearBtn');
const statusDiv = document.getElementById('status');
const statusText = document.getElementById('statusText');
const resultsDiv = document.getElementById('results');
const countSpan = document.getElementById('count');

// Restore state when the popup opens
document.addEventListener('DOMContentLoaded', () => {
  chrome.runtime.sendMessage({ action: 'getState' }, (response) => {
    if (response) {
      renderResults(response.results);
      if (response.isProcessing) {
        setStatus('Scraping in parallel...', true);
        scanBtn.disabled = true;
      }
    }
  });
});

// Listen for status updates
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'stateUpdate') {
    renderResults(request.results);
    if (request.isProcessing) {
      const entries = Object.values(request.results);
      const done = entries.filter(e => e.status === 'done').length;
      const total = entries.length;
      setStatus(`Scraping ${done}/${total}...`, true);
      scanBtn.disabled = true;
    } else {
      setStatus('Done!', false);
      scanBtn.disabled = false;
      setTimeout(() => setStatus('', false), 2000);
    }
  }
});

scanBtn.addEventListener('click', async () => {
  scanBtn.disabled = true;
  setStatus('Scanning page...', true);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const hrefs = new Set();

        // From <a> tags
        document.querySelectorAll('a[href]').forEach(a => hrefs.add(a.href));

        // From JSON-LD structured data
        document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
          try {
            const json = JSON.parse(script.textContent);
            const extract = (obj) => {
              if (typeof obj === 'string' && obj.startsWith('http')) {
                hrefs.add(obj.replace(/\\\//g, '/'));
              } else if (Array.isArray(obj)) {
                obj.forEach(extract);
              } else if (obj && typeof obj === 'object') {
                Object.values(obj).forEach(extract);
              }
            };
            extract(json);
          } catch (e) {}
        });

        return Array.from(hrefs);
      }
    });

    const hrefs = results[0]?.result || [];
    const links = [];

    hrefs.forEach(href => {
      const pinMatch = href.match(/https?:\/\/(www\.)?pinterest\.[a-z.]+\/([a-zA-Z0-9_]+)\/?$/);
      if (pinMatch && !['pin', 'ideas', 'search', 'settings', 'business', 'today', '_'].includes(pinMatch[2])) {
        if (!links.find(l => l.username === pinMatch[2] && l.platform === 'pinterest')) {
          links.push({ username: pinMatch[2], url: href, platform: 'pinterest' });
        }
      }

      const igMatch = href.match(/https?:\/\/(www\.)?instagram\.com\/([a-zA-Z0-9_.]+)\/?$/);
      if (igMatch && !['p', 'explore', 'reels', 'stories', 'direct', 'accounts', 'about', 'legal', '_'].includes(igMatch[2])) {
        if (!links.find(l => l.username === igMatch[2] && l.platform === 'instagram')) {
          links.push({ username: igMatch[2], url: href, platform: 'instagram' });
        }
      }

      const fbMatch = href.match(/https?:\/\/(www\.)?(facebook|fb)\.com\/([a-zA-Z0-9_.]+)\/?$/);
      if (fbMatch && !['pages', 'groups', 'events', 'marketplace', 'watch', 'gaming', 'login', 'help', 'settings'].includes(fbMatch[3])) {
        if (!links.find(l => l.username === fbMatch[3] && l.platform === 'facebook')) {
          links.push({ username: fbMatch[3], url: href, platform: 'facebook' });
        }
      }

      const ytMatch = href.match(/https?:\/\/(www\.)?youtube\.com\/(c\/|channel\/|@)?([a-zA-Z0-9_-]+)\/?$/);
      if (ytMatch && !['watch', 'playlist', 'feed', 'results', 'shorts'].includes(ytMatch[3])) {
        if (!links.find(l => l.username === ytMatch[3] && l.platform === 'youtube')) {
          links.push({ username: ytMatch[3], url: href, platform: 'youtube' });
        }
      }

      const ttMatch = href.match(/https?:\/\/(www\.)?tiktok\.com\/@([a-zA-Z0-9_.]+)\/?$/);
      if (ttMatch) {
        if (!links.find(l => l.username === ttMatch[2] && l.platform === 'tiktok')) {
          links.push({ username: ttMatch[2], url: href, platform: 'tiktok' });
        }
      }

      const xMatch = href.match(/https?:\/\/(www\.)?(x|twitter)\.com\/([a-zA-Z0-9_]+)\/?$/);
      if (xMatch && !['home', 'explore', 'search', 'messages', 'notifications', 'settings', 'i', 'login'].includes(xMatch[3])) {
        if (!links.find(l => l.username === xMatch[3] && l.platform === 'x')) {
          links.push({ username: xMatch[3], url: href, platform: 'x' });
        }
      }
    });

    if (links.length === 0) {
      setStatus('No social media links found', false);
      scanBtn.disabled = false;
      return;
    }

    setStatus(`Found ${links.length} links, scraping in parallel...`, true);
    chrome.runtime.sendMessage({ action: 'startScraping', links });

  } catch (e) {
    setStatus('Scan failed: ' + e.message, false);
    scanBtn.disabled = false;
  }
});

clearBtn.addEventListener('click', () => {
  chrome.storage.local.set({ results: {}, pendingCount: 0 });
  renderResults({});
  setStatus('', false);
});

function setStatus(text, showSpinner) {
  statusText.textContent = text;
  statusDiv.classList.toggle('show', !!text);
  statusDiv.querySelector('.spinner').style.display = showSpinner ? 'block' : 'none';
}

function renderResults(results) {
  const entries = Object.values(results || {});
  const doneCount = entries.filter(e => e.status === 'done').length;
  countSpan.textContent = `${doneCount}/${entries.length}`;

  if (entries.length === 0) {
    resultsDiv.innerHTML = '<div class="no-data">Click Scan to start collecting social media data</div>';
    return;
  }

  resultsDiv.innerHTML = entries.map(item => {
    const statusClass = item.status || 'loading';
    const statusLabel = item.status === 'loading' ? 'Loading' :
                        item.status === 'done' ? 'Done' :
                        item.status === 'error' ? 'Failed' : '';

    // Show a retry button if the request failed or returned no data
    const needRetry = item.status === 'error' ||
                      (item.status === 'done' && item.followers === null);

    const retryBtn = needRetry && item.status !== 'loading' ?
      `<button class="retry-btn" data-platform="${item.platform}" data-username="${item.username}" data-url="${item.url}">Retry</button>` : '';

    return `
      <div class="result-item ${statusClass}">
        <div class="result-header">
          <span class="platform-badge platform-${item.platform}">${item.platform}</span>
          <span class="username">@${item.username}</span>
          <span class="status-badge status-${statusClass}">${statusLabel}</span>
          ${retryBtn}
        </div>
        ${item.status === 'loading' ? `
          <div class="loading-text"><div class="mini-spinner"></div>Fetching data...</div>
        ` : item.status === 'done' ? `
          <div class="stats">
            <div class="stat-item"><span>Followers:</span><span class="stat-value">${item.rawText ? (item.followers || '-') : formatNumber(item.followers)}</span></div>
            <div class="stat-item"><span>Following:</span><span class="stat-value">${item.rawText ? (item.following || '-') : formatNumber(item.following)}</span></div>
            ${item.posts ? `<div class="stat-item"><span>Posts:</span><span class="stat-value">${formatNumber(item.posts)}</span></div>` : ''}
            ${item.likes ? `<div class="stat-item"><span>Likes:</span><span class="stat-value">${formatNumber(item.likes)}</span></div>` : ''}
            ${item.videos ? `<div class="stat-item"><span>Videos:</span><span class="stat-value">${formatNumber(item.videos)}</span></div>` : ''}
          </div>
          <a class="link" href="${item.url}" target="_blank">${item.url}</a>
        ` : `
          <div class="loading-text" style="color:#d32f2f">Scrape failed</div>
        `}
      </div>
    `;
  }).join('');

  // Bind retry button handlers
  resultsDiv.querySelectorAll('.retry-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = {
        platform: btn.dataset.platform,
        username: btn.dataset.username,
        url: btn.dataset.url
      };
      chrome.runtime.sendMessage({ action: 'retry', item });
    });
  });
}

function formatNumber(num) {
  if (num === null || num === undefined) return '-';
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toLocaleString();
}
