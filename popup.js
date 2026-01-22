const scanBtn = document.getElementById('scanBtn');
const clearBtn = document.getElementById('clearBtn');
const statusDiv = document.getElementById('status');
const statusText = document.getElementById('statusText');
const resultsDiv = document.getElementById('results');
const countSpan = document.getElementById('count');

// 页面加载时恢复状态
document.addEventListener('DOMContentLoaded', () => {
  chrome.runtime.sendMessage({ action: 'getState' }, (response) => {
    if (response) {
      renderResults(response.results);
      if (response.isProcessing) {
        setStatus('正在并发抓取中...', true);
        scanBtn.disabled = true;
      }
    }
  });
});

// 监听状态更新
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'stateUpdate') {
    renderResults(request.results);
    if (request.isProcessing) {
      const entries = Object.values(request.results);
      const done = entries.filter(e => e.status === 'done').length;
      const total = entries.length;
      setStatus(`正在抓取 ${done}/${total}...`, true);
      scanBtn.disabled = true;
    } else {
      setStatus('抓取完成！', false);
      scanBtn.disabled = false;
      setTimeout(() => setStatus('', false), 2000);
    }
  }
});

scanBtn.addEventListener('click', async () => {
  scanBtn.disabled = true;
  setStatus('正在扫描页面...', true);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const hrefs = new Set();

        // 从 <a> 标签获取
        document.querySelectorAll('a[href]').forEach(a => hrefs.add(a.href));

        // 从 JSON-LD 结构化数据获取
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
    });

    if (links.length === 0) {
      setStatus('未找到社媒链接', false);
      scanBtn.disabled = false;
      return;
    }

    setStatus(`找到 ${links.length} 个链接，开始并发抓取...`, true);
    chrome.runtime.sendMessage({ action: 'startScraping', links });

  } catch (e) {
    setStatus('扫描失败: ' + e.message, false);
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
  countSpan.textContent = `${doneCount}/${entries.length} 条`;

  if (entries.length === 0) {
    resultsDiv.innerHTML = '<div class="no-data">点击扫描开始抓取社媒数据</div>';
    return;
  }

  resultsDiv.innerHTML = entries.map(item => {
    const statusClass = item.status || 'loading';
    const statusLabel = item.status === 'loading' ? '抓取中' :
                        item.status === 'done' ? '完成' :
                        item.status === 'error' ? '失败' : '';

    // 判断是否需要显示重试按钮（失败或数据为空）
    const needRetry = item.status === 'error' ||
                      (item.status === 'done' && item.followers === null);

    const retryBtn = needRetry && item.status !== 'loading' ?
      `<button class="retry-btn" data-platform="${item.platform}" data-username="${item.username}" data-url="${item.url}">重试</button>` : '';

    return `
      <div class="result-item ${statusClass}">
        <div class="result-header">
          <span class="platform-badge platform-${item.platform}">${item.platform}</span>
          <span class="username">@${item.username}</span>
          <span class="status-badge status-${statusClass}">${statusLabel}</span>
          ${retryBtn}
        </div>
        ${item.status === 'loading' ? `
          <div class="loading-text"><div class="mini-spinner"></div>正在抓取数据...</div>
        ` : item.status === 'done' ? `
          <div class="stats">
            <div class="stat-item"><span>粉丝:</span><span class="stat-value">${formatNumber(item.followers)}</span></div>
            <div class="stat-item"><span>关注:</span><span class="stat-value">${formatNumber(item.following)}</span></div>
            ${item.posts ? `<div class="stat-item"><span>帖子:</span><span class="stat-value">${formatNumber(item.posts)}</span></div>` : ''}
            ${item.likes ? `<div class="stat-item"><span>点赞:</span><span class="stat-value">${formatNumber(item.likes)}</span></div>` : ''}
            ${item.videos ? `<div class="stat-item"><span>视频:</span><span class="stat-value">${formatNumber(item.videos)}</span></div>` : ''}
          </div>
          <a class="link" href="${item.url}" target="_blank">${item.url}</a>
        ` : `
          <div class="loading-text" style="color:#d32f2f">抓取失败</div>
        `}
      </div>
    `;
  }).join('');

  // 绑定重试按钮事件
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
