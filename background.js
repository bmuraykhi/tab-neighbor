const DEFAULTS = {
  enabled: true,
  moveLinkTabs: true,
  afterChildren: true,
  inheritGroup: true
};

const WINDOW_SUPPRESS_MS = 1500;
const STARTUP_SUPPRESS_MS = 4000;
const GROUP_SUPPRESS_MS = 700;

let settings = { ...DEFAULTS };
const activeHistory = new Map();
const chains = new Map();
const suppressUntil = new Map();
let globalSuppressUntil = 0;
let queue = Promise.resolve();

const ready = init();

async function init() {
  try {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    settings = { ...DEFAULTS, ...stored };
  } catch {
    settings = { ...DEFAULTS };
  }
  let stored = { active: {} };
  try {
    stored = await chrome.storage.session.get({ active: {} });
  } catch {}
  for (const [windowId, entry] of Object.entries(stored.active)) {
    activeHistory.set(Number(windowId), { cur: entry.cur, prev: entry.prev });
  }
}

function persistActive() {
  const active = {};
  for (const [windowId, entry] of activeHistory) active[windowId] = entry;
  chrome.storage.session.set({ active }).catch(() => {});
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const key of Object.keys(changes)) {
    if (key in DEFAULTS) settings[key] = changes[key].newValue ?? DEFAULTS[key];
  }
});

chrome.runtime.onStartup.addListener(() => {
  globalSuppressUntil = Date.now() + STARTUP_SUPPRESS_MS;
});

chrome.runtime.onInstalled.addListener(() => {
  globalSuppressUntil = Date.now() + STARTUP_SUPPRESS_MS;
});

chrome.windows.onCreated.addListener((win) => {
  suppressUntil.set(win.id, Date.now() + WINDOW_SUPPRESS_MS);
});

chrome.tabGroups.onCreated.addListener((group) => {
  suppressUntil.set(group.windowId, Date.now() + GROUP_SUPPRESS_MS);
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  await ready;
  suppressUntil.delete(windowId);
  chains.delete(windowId);
  if (activeHistory.delete(windowId)) persistActive();
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  await ready;
  chains.delete(windowId);
  const entry = activeHistory.get(windowId);
  if (!entry) {
    activeHistory.set(windowId, { cur: tabId, prev: undefined });
  } else if (entry.cur !== tabId) {
    entry.prev = entry.cur;
    entry.cur = tabId;
  }
  persistActive();
});

chrome.tabs.onRemoved.addListener(async (tabId, { windowId }) => {
  await ready;
  const entry = activeHistory.get(windowId);
  if (!entry) return;
  if (entry.cur === tabId) {
    entry.cur = entry.prev;
    entry.prev = undefined;
    persistActive();
  } else if (entry.prev === tabId) {
    entry.prev = undefined;
    persistActive();
  }
});

chrome.tabs.onDetached.addListener(async (tabId, { oldWindowId }) => {
  await ready;
  const entry = activeHistory.get(oldWindowId);
  if (!entry) return;
  if (entry.cur === tabId) {
    entry.cur = entry.prev;
    entry.prev = undefined;
    persistActive();
  } else if (entry.prev === tabId) {
    entry.prev = undefined;
    persistActive();
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  const referenceId = tab.openerTabId ?? activeHistory.get(tab.windowId)?.cur;
  queue = queue.then(() => place(tab, referenceId)).catch(() => {});
});

async function place(tab, referenceId) {
  await ready;
  if (!settings.enabled) return;
  if (tab.id === undefined || tab.id === chrome.tabs.TAB_ID_NONE) return;
  if (tab.pinned) return;
  if (tab.openerTabId !== undefined && !settings.moveLinkTabs) return;

  if (referenceId === undefined || referenceId === tab.id) {
    const entry = activeHistory.get(tab.windowId);
    if (entry) referenceId = entry.cur !== tab.id ? entry.cur : entry.prev;
  }
  if (referenceId === undefined || referenceId === tab.id) return;

  const now = Date.now();
  if (now < globalSuppressUntil) return;
  if (now < (suppressUntil.get(tab.windowId) ?? 0)) return;

  let all;
  try {
    all = await chrome.tabs.query({ windowId: tab.windowId });
  } catch {
    return;
  }
  all.sort((a, b) => a.index - b.index);
  const current = all.find((t) => t.id === tab.id);
  if (!current || current.pinned) return;
  if (tab.openerTabId === undefined && current.index !== all.length - 1) return;

  const reference = all.find((t) => t.id === referenceId);
  if (!reference) return;

  const groupId = current.groupId ?? tab.groupId ?? -1;
  if (groupId !== -1 && groupId !== reference.groupId) return;

  let target = reference.index + 1;
  if (settings.afterChildren) {
    const chain = chains.get(tab.windowId);
    if (chain && chain.refId === reference.id) {
      const last = all.find((t) => t.id === chain.lastTabId);
      if (last && last.index > reference.index) target = last.index + 1;
    }
  }
  chains.set(tab.windowId, { refId: reference.id, lastTabId: tab.id });

  if (current.index !== target) {
    if (current.index < target) target -= 1;
    try {
      await chrome.tabs.move(tab.id, { index: target });
    } catch {
      return;
    }
  }

  if (!settings.inheritGroup) return;
  if (reference.groupId === undefined || reference.groupId === -1) return;
  if (current.groupId === reference.groupId) return;
  try {
    await chrome.tabs.group({ groupId: reference.groupId, tabIds: [tab.id] });
  } catch {}
}
