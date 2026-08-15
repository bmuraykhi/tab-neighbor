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
const lastActive = new Map();
const openerOf = new Map();
const suppressUntil = new Map();
let globalSuppressUntil = 0;

const ready = init();

async function init() {
  try {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    settings = { ...DEFAULTS, ...stored };
  } catch {
    settings = { ...DEFAULTS };
  }
  try {
    const tabs = await chrome.tabs.query({ active: true });
    for (const tab of tabs) lastActive.set(tab.windowId, tab.id);
  } catch {}
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

chrome.windows.onRemoved.addListener((windowId) => {
  suppressUntil.delete(windowId);
  lastActive.delete(windowId);
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  lastActive.set(windowId, tabId);
});

chrome.tabs.onRemoved.addListener((tabId, { windowId }) => {
  openerOf.delete(tabId);
  for (const [child, parent] of openerOf) {
    if (parent === tabId) openerOf.delete(child);
  }
  if (lastActive.get(windowId) === tabId) lastActive.delete(windowId);
});

chrome.tabs.onDetached.addListener((tabId, { oldWindowId }) => {
  openerOf.delete(tabId);
  if (lastActive.get(oldWindowId) === tabId) lastActive.delete(oldWindowId);
});

chrome.tabs.onCreated.addListener((tab) => {
  const referenceId = tab.openerTabId ?? lastActive.get(tab.windowId);
  void place(tab, referenceId);
});

async function place(tab, referenceId) {
  await ready;
  if (!settings.enabled) return;
  if (tab.id === undefined || tab.id === chrome.tabs.TAB_ID_NONE) return;
  if (tab.pinned) return;
  if (referenceId === undefined || referenceId === tab.id) return;
  if (tab.openerTabId !== undefined && !settings.moveLinkTabs) return;

  const now = Date.now();
  if (now < globalSuppressUntil) return;
  if (now < (suppressUntil.get(tab.windowId) ?? 0)) return;

  const reference = await getTab(referenceId);
  if (!reference || reference.windowId !== tab.windowId) return;

  openerOf.set(tab.id, reference.id);

  let target = settings.afterChildren
    ? await indexAfterChain(reference, tab.id)
    : reference.index + 1;

  const current = await getTab(tab.id);
  if (!current || current.windowId !== tab.windowId) return;
  if (current.pinned) return;

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

async function indexAfterChain(reference, newTabId) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ windowId: reference.windowId });
  } catch {
    return reference.index + 1;
  }
  tabs.sort((a, b) => a.index - b.index);

  let target = reference.index + 1;
  for (const tab of tabs) {
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

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}
