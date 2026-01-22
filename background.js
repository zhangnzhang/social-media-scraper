// Background service worker: 并发抓取任务

let results = {};
let pendingCount = 0;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startScraping') {
    results = {};
    pendingCount = request.links.length;

    // 初始化所有链接为 loading 状态
    request.links.forEach(item => {
      results[`${item.platform}_${item.username}`] = {
        ...item,
        status: 'loading'
      };
    });
    saveState();

    // 并发抓取所有链接
    request.links.forEach(item => scrapeItem(item));

    sendResponse({ status: 'started' });
  }

  if (request.action === 'retry') {
    const item = request.item;
    const key = `${item.platform}_${item.username}`;
    results[key] = { ...item, status: 'loading' };
    pendingCount++;
    saveState();
    scrapeItem(item);
    sendResponse({ status: 'retrying' });
  }

  if (request.action === 'getState') {
    chrome.storage.local.get(['results', 'pendingCount'], (data) => {
      sendResponse({
        results: data.results || {},
        isProcessing: (data.pendingCount || 0) > 0
      });
    });
    return true;
  }
  return true;
});

function saveState() {
  chrome.storage.local.set({ results, pendingCount });
  chrome.runtime.sendMessage({
    action: 'stateUpdate',
    results,
    isProcessing: pendingCount > 0
  }).catch(() => {});
}

async function scrapeItem(item) {
  const key = `${item.platform}_${item.username}`;
  let win = null;

  try {
    win = await chrome.windows.create({
      url: item.url,
      type: 'popup',
      state: 'minimized',
      focused: false
    });

    const tabId = win.tabs[0].id;
    await waitForTabLoad(tabId);

    const func = item.platform === 'pinterest' ? scrapePinterest :
                 item.platform === 'instagram' ? scrapeInstagram :
                 item.platform === 'facebook' ? scrapeFacebook :
                 item.platform === 'youtube' ? scrapeYouTube :
                 item.platform === 'tiktok' ? scrapeTikTok : null;
    const data = await scrapeWithRetry(tabId, func);

    if (data && !data.error) {
      results[key] = { ...data, status: 'done' };
    } else {
      results[key] = { ...item, status: 'error', error: data?.error || 'unknown' };
    }

    await chrome.windows.remove(win.id).catch(() => {});
  } catch (e) {
    console.error('Scrape error:', e);
    results[key] = { ...item, status: 'error', error: e.message };
    if (win) await chrome.windows.remove(win.id).catch(() => {});
  }

  pendingCount--;
  saveState();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 20000);
  });
}

async function scrapeWithRetry(tabId, func) {
  for (let i = 0; i < 6; i++) {
    await sleep(i === 0 ? 3000 : 2000);
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        func
      });
      const data = result[0]?.result;
      if (data && data.followers !== null && data.followers !== undefined) {
        return data;
      }
    } catch (e) {
      console.error('Script error:', e);
    }
  }
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func
    });
    return result[0]?.result;
  } catch (e) {
    return { error: e.message };
  }
}

function scrapePinterest() {
  const path = window.location.pathname;
  const pathMatch = path.match(/^\/([a-zA-Z0-9_]+)\/?$/);
  const username = pathMatch?.[1];

  if (!username || ['pin', 'ideas', 'search', 'settings', 'business', 'today'].includes(username)) {
    return { error: 'invalid_path', path };
  }

  function parseCount(str) {
    if (!str) return null;
    str = str.replace(/,/g, '');
    // 匹配 "7.9 万" 或 "7.9万" 或 "79000" 或 "15"
    const match = str.match(/([\d.]+)\s*(万|k|m|千|百万)?/i);
    if (!match) return null;
    let num = parseFloat(match[1]);
    if (isNaN(num)) return null;
    const unit = (match[2] || '').toLowerCase();
    if (unit === '万') num *= 10000;
    else if (unit === '千') num *= 1000;
    else if (unit === '百万' || unit === 'm') num *= 1000000;
    else if (unit === 'k') num *= 1000;
    return Math.round(num);
  }

  let followers = null, following = null;
  let debug = { method: null, followersText: null, followingText: null };

  // 方法1: data-test-id 选择器
  const followersEl = document.querySelector('[data-test-id="profile-followers-count"]');
  const followingEl = document.querySelector('[data-test-id="profile-following-count"]');

  if (followersEl) {
    const text = followersEl.innerText || '';
    debug.followersText = text;
    debug.method = 'data-test-id';
    followers = parseCount(text);
  }

  if (followingEl) {
    const text = followingEl.innerText || '';
    debug.followingText = text;
    following = parseCount(text);
  }

  // 方法2: 从页面文本提取 (如果方法1失败)
  if (followers === null) {
    const text = document.body.innerText;
    // 匹配中文: "7.9 万 位粉丝" 或 "79000 位粉丝"
    let match = text.match(/([\d.]+)\s*(万|k|m|千|百万)?\s*(位粉丝|粉丝)/i);
    if (match) {
      followers = parseCount(match[1] + ' ' + (match[2] || ''));
      debug.method = 'body-text-cn';
    }
    // 匹配英文: "79K followers"
    if (followers === null) {
      match = text.match(/([\d.]+)\s*(k|m)?\s*followers/i);
      if (match) {
        followers = parseCount(match[1] + (match[2] || ''));
        debug.method = 'body-text-en';
      }
    }
  }

  if (following === null) {
    const text = document.body.innerText;
    // 匹配中文: "15 关注"
    let match = text.match(/([\d.]+)\s*(万|k|m|千|百万)?\s*(位关注|关注中|关注)/i);
    if (match) {
      following = parseCount(match[1] + ' ' + (match[2] || ''));
    }
    // 匹配英文: "15 following"
    if (following === null) {
      match = text.match(/([\d.]+)\s*(k|m)?\s*following/i);
      if (match) {
        following = parseCount(match[1] + (match[2] || ''));
      }
    }
  }

  return {
    platform: 'pinterest',
    username,
    url: window.location.href,
    followers,
    following,
    debug
  };
}

function scrapeInstagram() {
  const pathMatch = window.location.pathname.match(/^\/([a-zA-Z0-9_.]+)\/?$/);
  const username = pathMatch?.[1];
  if (!username || ['p', 'explore', 'reels', 'stories', 'direct', 'accounts'].includes(username)) {
    return null;
  }

  function parseCount(str) {
    if (!str) return null;
    const match = str.match(/([\d,.]+)\s*(万|k|m|千|百万)?/i);
    if (!match) return null;
    let num = parseFloat(match[1].replace(/,/g, ''));
    const unit = (match[2] || '').toLowerCase();
    if (unit === '万') num *= 10000;
    else if (unit === '千') num *= 1000;
    else if (unit === '百万' || unit === 'm') num *= 1000000;
    else if (unit === 'k') num *= 1000;
    return Math.round(num);
  }

  let followers = null, following = null, posts = null;

  const links = document.querySelectorAll('a[href*="/followers/"], a[href*="/following/"]');
  links.forEach(link => {
    const text = link.innerText || '';
    const title = link.querySelector('[title]')?.getAttribute('title') || '';
    if (link.href.includes('/followers/')) {
      followers = parseCount(title) || parseCount(text);
    } else if (link.href.includes('/following/')) {
      following = parseCount(title) || parseCount(text);
    }
  });

  if (followers === null) {
    const metaDesc = document.querySelector('meta[name="description"]')?.content || '';
    const metaMatch = metaDesc.match(/([\d,.]+[KkMm]?)\s*Followers/i);
    if (metaMatch) followers = parseCount(metaMatch[1]);
  }

  if (followers === null) {
    const text = document.body.innerText;
    const match = text.match(/([\d,.]+)\s*(万|k|m)?\s*(粉丝|followers)/i);
    if (match) followers = parseCount(match[1] + (match[2] || ''));
  }

  if (following === null) {
    const text = document.body.innerText;
    const match = text.match(/([\d,.]+)\s*(万|k|m)?\s*(关注|following)/i);
    if (match) following = parseCount(match[1] + (match[2] || ''));
  }

  const text = document.body.innerText;
  const postsMatch = text.match(/([\d,.]+)\s*(万|k|m)?\s*(帖子|posts)/i);
  if (postsMatch) posts = parseCount(postsMatch[1] + (postsMatch[2] || ''));

  return {
    platform: 'instagram',
    username,
    url: window.location.href,
    followers,
    following,
    posts
  };
}

function scrapeFacebook() {
  const pathMatch = window.location.pathname.match(/^\/([a-zA-Z0-9_.]+)\/?$/);
  const username = pathMatch?.[1];
  if (!username || ['pages', 'groups', 'events', 'marketplace', 'watch', 'gaming'].includes(username)) {
    return { error: 'invalid_path' };
  }

  function parseCount(str) {
    if (!str) return null;
    // 处理 &nbsp; 和空格
    str = str.replace(/&nbsp;/g, '').replace(/\s+/g, '');
    const match = str.match(/([\d,.]+)\s*(万|k|m|千|百万)?/i);
    if (!match) return null;
    let num = parseFloat(match[1].replace(/,/g, ''));
    const unit = (match[2] || '').toLowerCase();
    if (unit === '万') num *= 10000;
    else if (unit === '千') num *= 1000;
    else if (unit === '百万' || unit === 'm') num *= 1000000;
    else if (unit === 'k') num *= 1000;
    return Math.round(num);
  }

  let followers = null, likes = null, following = null;

  // 方法1: 从链接获取
  const followersLink = document.querySelector('a[href*="/followers/"]');
  const followingLink = document.querySelector('a[href*="/following/"]');
  const likesLink = document.querySelector('a[href*="/friends_likes/"]');

  if (followersLink) {
    const strong = followersLink.querySelector('strong');
    followers = parseCount(strong?.innerText || followersLink.innerText);
  }

  if (followingLink) {
    const strong = followingLink.querySelector('strong');
    following = parseCount(strong?.innerText || followingLink.innerText);
  }

  if (likesLink) {
    const strong = likesLink.querySelector('strong');
    likes = parseCount(strong?.innerText || likesLink.innerText);
  }

  // 方法2: 从页面文本提取
  if (followers === null) {
    const text = document.body.innerText;
    const match = text.match(/([\d,.]+)\s*(万|k|m)?\s*(位粉丝|粉丝|followers)/i);
    if (match) followers = parseCount(match[1] + (match[2] || ''));
  }

  if (following === null) {
    const text = document.body.innerText;
    // 匹配 "关注 33 人" 格式
    const match = text.match(/关注\s*([\d,.]+)\s*(万|k|m)?\s*人/i);
    if (match) following = parseCount(match[1] + (match[2] || ''));
    // 匹配英文 "following 33"
    if (following === null) {
      const match2 = text.match(/following\s*([\d,.]+)\s*(k|m)?/i);
      if (match2) following = parseCount(match2[1] + (match2[2] || ''));
    }
  }

  if (likes === null) {
    const text = document.body.innerText;
    const match = text.match(/([\d,.]+)\s*(万|k|m)?\s*(次赞|likes|people like)/i);
    if (match) likes = parseCount(match[1] + (match[2] || ''));
  }

  return {
    platform: 'facebook',
    username,
    url: window.location.href,
    followers,
    likes,
    following
  };
}

function scrapeYouTube() {
  const path = window.location.pathname;
  const pathMatch = path.match(/^\/(c\/|channel\/|@)?([a-zA-Z0-9_-]+)\/?$/);
  const username = pathMatch?.[2];

  if (!username || ['watch', 'playlist', 'feed', 'results', 'shorts'].includes(username)) {
    return { error: 'invalid_path' };
  }

  function parseCount(str) {
    if (!str) return null;
    str = str.replace(/\s+/g, '').toLowerCase();
    const match = str.match(/([\d,.]+)\s*(万|k|m|千|百万)?/i);
    if (!match) return null;
    let num = parseFloat(match[1].replace(/,/g, ''));
    const unit = (match[2] || '').toLowerCase();
    if (unit === '万') num *= 10000;
    else if (unit === '千' || unit === 'k') num *= 1000;
    else if (unit === '百万' || unit === 'm') num *= 1000000;
    return Math.round(num);
  }

  let subscribers = null, videos = null;

  // 方法1: 从 metadata 元素获取
  const metaTexts = document.querySelectorAll('.yt-content-metadata-view-model__metadata-text, #subscriber-count, yt-formatted-string#subscriber-count');
  metaTexts.forEach(el => {
    const text = el.innerText || '';
    if (/subscribers|订阅/i.test(text)) {
      subscribers = parseCount(text);
    }
    if (/videos|视频/i.test(text)) {
      videos = parseCount(text);
    }
  });

  // 方法2: 从页面文本提取
  if (subscribers === null) {
    const text = document.body.innerText;
    const match = text.match(/([\d,.]+)\s*(万|k|m)?\s*(subscribers|位订阅者|订阅者)/i);
    if (match) subscribers = parseCount(match[1] + (match[2] || ''));
  }

  return {
    platform: 'youtube',
    username,
    url: window.location.href,
    followers: subscribers,
    videos,
    following: null
  };
}

function scrapeTikTok() {
  const path = window.location.pathname;
  const pathMatch = path.match(/^\/@([a-zA-Z0-9_.]+)\/?$/);
  const username = pathMatch?.[1];

  if (!username) {
    return { error: 'invalid_path' };
  }

  function parseCount(str) {
    if (!str) return null;
    str = str.replace(/\s+/g, '').toLowerCase();
    const match = str.match(/([\d,.]+)\s*(万|k|m|千|百万)?/i);
    if (!match) return null;
    let num = parseFloat(match[1].replace(/,/g, ''));
    const unit = (match[2] || '').toLowerCase();
    if (unit === '万') num *= 10000;
    else if (unit === '千' || unit === 'k') num *= 1000;
    else if (unit === '百万' || unit === 'm') num *= 1000000;
    return Math.round(num);
  }

  let followers = null, following = null, likes = null;

  // 方法1: 从 data-e2e 属性获取
  const followersEl = document.querySelector('[data-e2e="followers-count"]');
  const followingEl = document.querySelector('[data-e2e="following-count"]');
  const likesEl = document.querySelector('[data-e2e="likes-count"]');

  if (followersEl) followers = parseCount(followersEl.innerText);
  if (followingEl) following = parseCount(followingEl.innerText);
  if (likesEl) likes = parseCount(likesEl.innerText);

  // 方法2: 从页面文本提取
  if (followers === null) {
    const text = document.body.innerText;
    const match = text.match(/([\d,.]+)\s*(万|k|m)?\s*(粉丝|followers)/i);
    if (match) followers = parseCount(match[1] + (match[2] || ''));
  }

  return {
    platform: 'tiktok',
    username,
    url: window.location.href,
    followers,
    following,
    likes
  };
}
