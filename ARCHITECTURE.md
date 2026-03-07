# opentheatre — Refactored Architecture

## File Structure

```
opentheatre/
├── main.js                  ← Electron main process (refactored)
├── preload.js               ← Hardened contextBridge
├── index.html               ← Structural markup only (no JS, no CSS)
├── package.json             ← Unchanged
├── ublock/                  ← Unchanged
└── renderer/
    ├── styles.css           ← All CSS extracted here
    ├── app.js               ← Entry point: boots app, wires all modules
    ├── state.js             ← Centralized Proxy-based reactive store
    ├── db.js                ← IndexedDB async wrapper (replaces localStorage)
    ├── api.js               ← TMDB fetch layer with LRU cache
    ├── navigation.js        ← Dynamic 2D spatial nav engine
    ├── player.js            ← Stream handling, provider cycling, stall watchdog
    └── ui.js                ← All DOM rendering with listener cleanup
```

---

## What Changed & Why

### 1. CDP → HTML5 Video API (`main.js` + `player.js`)

**Before:** `simulateClick()` used Chrome DevTools Protocol to dispatch synthetic mouse events to pixel coordinates. This was fragile (broke on resolution changes), slow (15 retry loops × 100ms waits), and hit the wrong player when multiple iframes exist.

**After:** A content script (`VIDEO_CONTENT_SCRIPT`) is injected into every iframe via `mainWindow.webContents.on('frame-created')`. It directly calls `video.play()`, `video.pause()`, `video.currentTime = x` — native HTML5 API. Commands travel:

```
keyboard → app.js → ipcBridge.send('video-command') 
         → main.js IPC handler 
         → executeJavaScript postMessage into iframes
         → content script → video element
```

State travels back:
```
video element events (play/pause/timeupdate) 
  → content script window.top.postMessage({ __OT__: true })
  → app.js window.addEventListener('message')
  → store.patch({ playing, currentTime })
```

**No CDP attached. No `debugger.attach()`. No mouse coordinate math.**

---

### 2. MutationObserver Sniper (`main.js`)

**Before:** A 200ms `setInterval` ran across all frames, executing `document.querySelectorAll` + `style.opacity = 0` on every tick regardless of whether anything changed. 5× per second CPU burn.

**After:** The injected content script installs a single `MutationObserver` on `document.documentElement`. When new nodes are inserted, `sweepUnwantedUI()` fires only for the delta. Zero polling. The sniper only shoots when there's a target.

---

### 3. Dynamic 2D Spatial Navigation (`navigation.js`)

**Before:** `navState = { activeRow: 2, activeIndex: 1 }` with a hardcoded `getFocusElement(row, index)` lookup table. Adding a new UI element meant editing the matrix.

**After:** `findNearest(source, direction)` queries every focusable element, reads their `getBoundingClientRect()` in a single layout pass (batch read → no thrashing), then scores each candidate by:

```
score = primaryAxisDistance + crossAxisDistance × 1.5
```

The lowest-score element wins. Works for carousels, grids, HUD, modals — all without a single hardcoded ID.

---

### 4. Fail-Safe Atomic Updater (`main.js`)

**Before:** `downloadFile()` wrote directly to `__dirname` with `fs.writeFileSync`. If interrupted mid-download, the live file would be truncated/corrupt → bricked app.

**After:**
1. All files download into a **hidden temp directory** (`os.tmpdir()/ot-update-{timestamp}`)
2. Optional SHA-256 integrity check against `checksums.json` on the remote
3. **Atomic swap**: `fs.renameSync(tmp → live)` — rename is atomic on POSIX (same filesystem). Each file is backed up as `.bak` before swap; backup is restored on failure
4. Temp dir cleaned up in `finally` regardless of success/failure

```
[tmpDir/main.js ✓] → rename → [live/main.js]
[tmpDir/main.js ✗] → restore [live/main.js.bak] → abort
```

---

### 5. Centralized State (`state.js`)

**Before:** `let continueWatching = []`, `let localState = {}`, `let navState = {}`, `let epanelOpen`, `let currentId` — scattered across 5,764 lines, mutated anywhere.

**After:** One `store` object with:
- `store.get(key)` — read
- `store.set(key, value)` — write + notify
- `store.patch(partial)` — atomic batch write
- `store.subscribe(key, fn)` — reactive listener
- `store.proxy(...keys)` — backwards-compatible Proxy wrapper so `localState.playing = true` still works

---

### 6. IndexedDB Storage (`db.js`)

**Before:** `localStorage.setItem('ot_history_1', JSON.stringify([...50 items...]))` — synchronous, blocks main thread, 5MB limit.

**After:** All large data (watch history, profiles, watchlist, blocked shows) goes through `db.js` async IndexedDB wrapper. Auto-migrates existing `localStorage` data on first run. localStorage is kept only for tiny primitives (theme name, seekStep, etc.).

---

### 7. LRU API Cache (`api.js`)

**Before:** Every `fetch(TMDB_BASE/movie/550)` was a fresh network call, even when scrolling back and forth on the same carousel.

**After:** `LRUCache` class with `Map` (insertion-order) evicts least-recently-used entries at `max=150`. TTL = 5 minutes. In-flight deduplication via `_inflight: Map<url, Promise>` ensures two simultaneous identical requests share one network call.

---

### 8. DOM Cleanup / Listener Registry (`ui.js`)

**Before:** `carousel.innerHTML = ''` followed by new `appendChild` calls — old event listeners on removed nodes held references in closure. Carousels accumulated ghost listeners over long sessions.

**After:** `_listenerRegistry: WeakMap<element, [{type, fn}]>`. `_addTrackedListener()` registers every listener. `_cleanupListeners(container)` walks the subtree and calls `removeEventListener` before clearing `innerHTML`. `WeakMap` allows GC to collect elements naturally.

---

### 9. GPU-Accelerated Render (`styles.css` + `ui.js`)

**Before:** `progressBar.style.width = '73%'` — triggers layout reflow on every animation frame.

**After:**
- Progress bar is always `width: 100%`, driven by `transform: scaleX(0.73) translateZ(0)` — pure compositor, no layout
- `will-change: transform` added to carousel items, HUD handle, hero layers
- Quality enhancer is a CSS class (`.quality-enhanced { filter: contrast(1.08) ... }`) — no rAF loop whatsoever
- `backface-visibility: hidden` on carousel items forces GPU layer promotion

---

### 10. IPC Security (`preload.js` + `main.js`)

**Before:** `ipcRenderer.send` exposed directly → any injected script could call any channel.

**After:**
- `preload.js` exposes `window.ipcBridge` with two strict allowlists: `SEND_ALLOWLIST` and `LISTEN_ALLOWLIST`
- `main.js` validates every incoming message: channel name checked + payload shape validated per channel
- `video-command` only accepts `togglePlay | rewind | forward | {action:'seek', percent:0..1}` — no arbitrary JS
- `webSecurity: false` is retained (required for cross-origin embeds) but compensated by the strict IPC validation

---

## Import / Export Wiring

```
index.html
  └── <script type="module" src="renderer/app.js">

renderer/app.js
  ├── import { store, localState, navState }  from './state.js'
  ├── import { db }                            from './db.js'
  ├── import { api, img }                      from './api.js'
  ├── import { initPlayer, startStreaming, ... } from './player.js'
  ├── import { renderCarousel, wakeUpHUD, ... }  from './ui.js'
  └── import { navigation }                    from './navigation.js'

renderer/player.js
  ├── import { store }   from './state.js'
  ├── import { db }      from './db.js'
  └── import { api }     from './api.js'

renderer/ui.js
  ├── import { store }              from './state.js'
  ├── import { api, img }           from './api.js'
  ├── import { startStreaming, ... } from './player.js'
  └── import { navigation, ... }    from './navigation.js'

renderer/navigation.js
  └── import { store } from './state.js'

renderer/api.js     — no local imports (pure utility)
renderer/db.js      — no local imports (pure utility)
renderer/state.js   — no local imports (pure data)
```

---

## Migration Checklist

- [ ] Copy all files to project root (main.js, preload.js, index.html)
- [ ] Create `renderer/` directory and copy all renderer files
- [ ] Rename old `index.html` to `index.html.bak` before replacing
- [ ] Verify `ublock/` extension directory is still present
- [ ] Verify `avatar/` directory is present (1.png–8.png)
- [ ] On first launch: IndexedDB migration runs automatically from localStorage
- [ ] Test with `npm start` — check DevTools console for `[app] Boot complete.`
- [ ] Optional: Add `checksums.json` to GitHub repo for update integrity verification

---

## Backwards Compatibility Notes

- `window.ipcRenderer` → replaced by `window.ipcBridge` everywhere in app.js
- `navState.activeRow / activeIndex` → removed; spatial engine handles navigation
- `localState` → still accessible via `store.proxy()` wrapper
- `continueWatching` array → now async from IndexedDB, use `store.get('continueWatching')`
- All `onclick="..."` attributes in HTML → replaced by `addEventListener` in `_wireUiEvents()`
