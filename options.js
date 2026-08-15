const DEFAULTS = {
  enabled: true,
  moveLinkTabs: true,
  afterChildren: true,
  inheritGroup: true
};

const status = document.getElementById('status');
let statusTimer = 0;

function note(text) {
  status.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    status.textContent = '';
  }, 1600);
}

function sync() {
  const dependent = ['moveLinkTabs', 'afterChildren', 'inheritGroup'];
  const on = document.getElementById('enabled').checked;
  for (const key of dependent) {
    const box = document.getElementById(key);
    box.disabled = !on;
    box.closest('.row').style.opacity = on ? '1' : '0.5';
  }
}

chrome.storage.sync.get(DEFAULTS).then((stored) => {
  for (const key of Object.keys(DEFAULTS)) {
    const box = document.getElementById(key);
    box.checked = stored[key] ?? DEFAULTS[key];
    box.addEventListener('change', () => {
      chrome.storage.sync.set({ [key]: box.checked }).then(() => note('Saved'));
      sync();
    });
  }
  sync();
});
