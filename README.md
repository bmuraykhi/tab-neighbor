# Tab Neighbor

Chrome (MV3) extension that opens every new tab immediately to the right of the
active tab instead of at the far end of the tab strip.

Works for `⌘T` / `Ctrl+T`, the `+` button, bookmarks, and links opened in a new
tab — the keyboard shortcut itself is untouched, only the placement of the tab
it creates.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked** → select this folder.

## Options

`chrome://extensions` → Tab Neighbor → **Details** → **Extension options**.

| Option | Default | Effect |
| --- | --- | --- |
| Enabled | on | Master switch |
| Reposition tabs opened from links | on | Off = only tabs you open yourself are moved |
| Keep related tabs together | on | New tab lands after the tabs already spawned from the current one |
| Join the current tab's group | on | New tab inherits the active tab's tab group |
