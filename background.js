const DEFAULTS = {
  enabled: true,
  moveLinkTabs: true,
  afterChildren: true,
  inheritGroup: true
};

const WINDOW_SUPPRESS_MS = 1500;
const STARTUP_SUPPRESS_MS = 4000;
const MAX_CHAIN_DEPTH = 32;

let settings = { ...DEFAULTS };
const activeHistory = new Map();
const openerOf = new Map();
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
  let stored = { active: {}, openers: {} };
  try {
    stored = await chrome.storage.session.get({ active: {}, openers: {} });
  } catch {}
  for (const [windowId, entry] of Object.entries(stored.active)) {
    activeHistory.set(Number(windowId), { cur: entry.cur, prev: entry.prev });
  }
  for (const [tabId, parent] of Object.entries(stored.openers)) {
    openerOf.set(Number(tabId), parent);
  }
}

function persistActive() {
  const active = {};
  for (const [windowId, entry] of activeHistory) active[windowId] = entry;
  chrome.storage.session.set({ active }).catch(() => {});
}

function persistOpeners() {
  const openers = {};
  for (const [tabId, parent] of openerOf) openers[tabId] = parent;
  chrome.storage.session.set({ openers }).catch(() => {});
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

chrome.windows.onRemoved.addListener(async (windowId) => {
  await ready;
  suppressUntil.delete(windowId);
  if (activeHistory.delete(windowId)) persistActive();
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  await ready;
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
  let dirty = openerOf.delete(tabId);
  for (const [child, parent] of openerOf) {
    if (parent === tabId) {
      openerOf.delete(child);
      dirty = true;
    }
  }
  if (dirty) persistOpeners();
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
  if (openerOf.delete(tabId)) persistOpeners();
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

  openerOf.set(tab.id, reference.id);
  persistOpeners();

  let target = settings.afterChildren
    ? indexAfterChain(all, reference, tab.id)
    : reference.index + 1;

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

function indexAfterChain(all, reference, newTabId) {
  let target = reference.index + 1;
  for (const tab of all) {
    if (tab.index <= reference.index) continue;
    if (tab.id === newTabId) continue;
    if (!descendsFrom(tab, reference.id)) break;
    target = tab.index + 1;
  }
  return target;
}

function descendsFrom(tab, ancestorId) {
  let parent = tab.openerTabId ?? openerOf.get(tab.id);
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth += 1) {
    if (parent === undefined) return false;
    if (parent === ancestorId) return true;
    parent = openerOf.get(parent);
  }
  return false;
}
