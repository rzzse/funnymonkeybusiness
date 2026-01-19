// --- 1. IMPORTS (Fixed: Added 'net', Removed 'electron-updater') ---
const { app, BrowserWindow, globalShortcut, session, ipcMain, net } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
let streamActive = false; 

// --- 2. BASELINE COORDINATES (Calibrated for 1920x1080) ---
const REF_W = 1920;
const REF_H = 1080;

// Center (Play/Pause)
const BASE_CENTER_X = 960;
const BASE_CENTER_Y = 540;

// Mute / Volume (Bottom Left)
const BASE_MUTE_X = 58;
const BASE_MUTE_Y = 1052;
const BASE_VOL_MAX_X = 154;
const BASE_VOL_MAX_Y = 1051;

// Controls (Center Overlay)
const BASE_REWIND_X = 869;
const BASE_REWIND_Y = 542;
const BASE_FORWARD_X = 1049;
const BASE_FORWARD_Y = 544;

// Seek Bar (Bottom)
const BASE_BAR_START_X = 10;
const BASE_BAR_END_X = 1907;
const BASE_BAR_Y = 1013;

async function createWindow() {
    app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
    app.commandLine.appendSwitch('disable-site-isolation-trials');
    app.commandLine.appendSwitch('enable-gpu-rasterization');
    app.commandLine.appendSwitch('log-level', '3');
    
    mainWindow = new BrowserWindow({
        width: 1920,
        height: 1080,
        fullscreen: true,
        frame: false,
        kiosk: true,
        backgroundColor: '#000000',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false,
            allowRunningInsecureContent: true,
            sandbox: false,
            preload: path.join(__dirname, 'preload.js') 
        }
    });

    try {
        mainWindow.webContents.debugger.attach('1.3');
        console.log("🔌 God Mode Attached (CDP 1.3)");
    } catch (err) {
        console.log("❌ God Mode Failed:", err);
    }

    // --- 3. THE SMART SCALER ---
    function getScaledCoords(targetX, targetY) {
        if (!mainWindow) return { x: targetX, y: targetY };
        const { width, height } = mainWindow.getBounds();
        
        // Simple Ratio Math
        const scaleX = width / REF_W;
        const scaleY = height / REF_H;

        return {
            x: Math.round(targetX * scaleX),
            y: Math.round(targetY * scaleY)
        };
    }

    // --- SPORTS SNIPER LOGIC (Keep Intact) ---
    ipcMain.on('start-sport-scan', async (event, data) => {
        const { matchId } = data;
        
        // Priority Order
        const targets = [
            { name: "Direct", url: `https://streamed.pk/watch/${matchId}` },
            { name: "Alpha", url: `https://streamed.pk/watch/${matchId}/alpha/1` },
            { name: "Bravo", url: `https://streamed.pk/watch/${matchId}/bravo/1` },
            { name: "Charlie", url: `https://streamed.pk/watch/${matchId}/charlie/1` },
            { name: "Delta", url: `https://streamed.pk/watch/${matchId}/delta/1` },
            { name: "Echo", url: `https://streamed.pk/watch/${matchId}/echo/1` },
            { name: "Foxtrot", url: `https://streamed.pk/watch/${matchId}/foxtrot/1` }
        ];

        console.log(`\n[Sports] 🏒 STARTING CONTINUOUS SCAN: ${matchId}`);

        const sportWindow = new BrowserWindow({
            show: false, width: 1280, height: 720,
            webPreferences: { offscreen: true, contextIsolation: false, nodeIntegration: false }
        });

        sportWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        sportWindow.webContents.setAudioMuted(true);
        sportWindow.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        let firstFound = false;

        try {
            for (let i = 0; i < targets.length; i++) {
                if (sportWindow.isDestroyed()) break;

                const target = targets[i];
                console.log(`[Sports] [${i+1}/${targets.length}] Probing: ${target.name}...`);
                
                try {
                    await sportWindow.loadURL(target.url, { timeout: 6000 }).catch(() => {});
                    
                    const scanResult = await sportWindow.webContents.executeJavaScript(`
                        new Promise((resolve) => {
                            let attempts = 0;
                            const check = () => {
                                attempts++;
                                const body = document.body.innerText.toLowerCase();
                                const iframes = Array.from(document.querySelectorAll('iframe'));

                                if (body.includes("404") || document.title.includes("Not Found") || body.includes("stream not found")) {
                                    resolve({ status: 'dead' });
                                    return;
                                }

                                const valid = iframes.find(f => f.src && (f.src.includes('embed') || f.src.includes('player') || f.src.includes('v1') || f.src.includes('cdn')));
                                if (valid) { resolve({ status: 'success', streamUrl: valid.src }); return; }
                                
                                const vid = document.querySelector('video');
                                if(vid && vid.src && vid.src.startsWith('http')) { resolve({ status: 'success', streamUrl: vid.src }); return; }

                                if (attempts >= 15) resolve({ status: 'timeout' });
                                else setTimeout(check, 200);
                            };
                            check();
                        });
                    `);

                    if (scanResult.status === 'success') {
                        console.log(`      >>> FOUND: ${target.name}`);
                        
                        mainWindow.webContents.send('sport-stream-found', {
                            name: `Streamed (${target.name})`,
                            streamUrl: scanResult.streamUrl,
                            isFirst: !firstFound 
                        });
                        
                        firstFound = true;
                    }

                } catch (e) { console.log(`      [!] Error on ${target.name}`); }
            }
            
            if (!firstFound) mainWindow.webContents.send('sport-error', 'No streams found.');

        } catch (err) {
            console.log(`[Sports] Scanner Error: ${err.message}`);
        } finally {
            if (!sportWindow.isDestroyed()) sportWindow.destroy();
        }
    });

    // --- MASTER SNIPER LOOP (5x per second) ---
    setInterval(async () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        
        const frames = mainWindow.webContents.mainFrame.frames;
        let needsUnmute = false;
        let playerReady = false;
        let timeData = null;

        for (const frame of frames) {
            try {
                // A. CLEANUP
                await frame.executeJavaScript(`
                    (() => {
                        const targets = ['div.flex.w-full.items-center.px-2.pb-2','div[data-media-time-slider]','button[data-media-tooltip="seek"]','button[aria-label="Play"]','button[data-media-tooltip="play"]'];
                        targets.forEach(s => document.querySelectorAll(s).forEach(el => { if(el.style.opacity!=='0') { el.style.opacity='0'; el.style.pointerEvents='auto'; el.style.cursor='none'; }}));
                        document.querySelectorAll('div').forEach(d => { if(parseInt(window.getComputedStyle(d).zIndex)>2000000000) d.remove(); });
                    })();
                `);

                // B. CHECK STATUS
                const status = await frame.executeJavaScript(`
                    (() => {
                        const v = document.querySelector('video');
                        if (!v || v.readyState < 1) return { ready: false };
                        const m = document.querySelector('[data-state="muted"]') || document.querySelector('button[aria-label*="unmute" i]');
                        return { ready: true, isMuted: (v.muted || !!m), curr: v.currentTime, total: v.duration, paused: v.paused };
                    })();
                `);

                if (status && status.ready) {
                    playerReady = true;
                    if (status.isMuted) needsUnmute = true;
                    if (status.total > 0) timeData = { curr: status.curr, total: status.total, paused: status.paused };
                }

                await frame.executeJavaScript(`
                    (() => {
                        try {
                            const noop = () => { console.log("Blocked Fullscreen Attempt"); };
                            window.HTMLElement.prototype.requestFullscreen = noop;
                            window.HTMLElement.prototype.webkitRequestFullscreen = noop;
                            window.HTMLElement.prototype.mozRequestFullScreen = noop;
                            window.HTMLElement.prototype.msRequestFullscreen = noop;
                            if (window.HTMLVideoElement) {
                                window.HTMLVideoElement.prototype.webkitEnterFullscreen = noop;
                                window.HTMLVideoElement.prototype.enterFullscreen = noop;
                            }
                            const targets = ['div.flex.w-full.items-center.px-2.pb-2','div[data-media-time-slider]','button[data-media-tooltip="seek"]','button[aria-label="Play"]','button[data-media-tooltip="play"]'];
                            targets.forEach(s => document.querySelectorAll(s).forEach(el => { 
                                if(el.style.opacity!=='0') { el.style.opacity='0'; el.style.pointerEvents='auto'; el.style.cursor='none'; }
                            }));
                            document.querySelectorAll('div').forEach(d => { 
                                if(parseInt(window.getComputedStyle(d).zIndex)>2000000000) d.remove(); 
                            });
                        } catch(err) {}
                    })();
                `).catch(() => {});
            } catch (e) { }
        }

        if (playerReady) {
            // 1. AUTO-UNMUTE
            if (needsUnmute) {
                console.log("🔇 Unmuting (Scaled)...");
                const mutePos = getScaledCoords(BASE_MUTE_X, BASE_MUTE_Y);
                const volMaxPos = getScaledCoords(BASE_VOL_MAX_X, BASE_VOL_MAX_Y);
                await simulateClick(mutePos.x, mutePos.y);
                await new Promise(r => setTimeout(r, 50));
                await simulateClick(volMaxPos.x, volMaxPos.y);
            }

            // 2. KICKSTART
            if (!streamActive) {
                streamActive = true; 
                console.log("⚡ Kickstart (Scaled)...");
                const fwdPos = getScaledCoords(BASE_FORWARD_X, BASE_FORWARD_Y);
                const rwdPos = getScaledCoords(BASE_REWIND_X, BASE_REWIND_Y);
                await simulateClick(fwdPos.x, fwdPos.y);
                await new Promise(r => setTimeout(r, 100));
                await simulateClick(rwdPos.x, rwdPos.y);
                mainWindow.webContents.send('stream-ready-to-fade');
            }

            // 3. Time Sync
            if (timeData) mainWindow.webContents.send('video-time-data', timeData);
        }
    }, 200);

    // --- CLICK SIMULATION ---
    async function simulateClick(x, y) {
        try {
            if (mainWindow.webContents.debugger.isAttached()) {
                await mainWindow.webContents.executeJavaScript(`(function(){const s=document.getElementById('clickShield');if(s)s.style.pointerEvents='none'})()`);
                await mainWindow.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x, y: y });
                await mainWindow.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: x, y: y, button: 'left', clickCount: 1 });
                await new Promise(r => setTimeout(r, 50)); 
                await mainWindow.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x, y: y, button: 'left', clickCount: 1 });
                await mainWindow.webContents.executeJavaScript(`(function(){const s=document.getElementById('clickShield');if(s)s.style.pointerEvents='auto'})()`);
            }
        } catch (e) {}
    }

    // --- CONFIG ---
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    mainWindow.webContents.setUserAgent(userAgent);

    const ublockPath = path.join(__dirname, 'ublock');
    if (fs.existsSync(path.join(ublockPath, 'manifest.json'))) {
        try { await session.defaultSession.loadExtension(ublockPath); } catch (err) {}
    }

    const AD_DOMAINS = [
        '*://*.oundhertobeconsist.org/*', '*://*.brightadnetwork.com/*', '*://brightadnetwork.com/*', 
        '*://*.simaonegoalz.com/*', '*://*.julianoalvaroz12.com/*', '*://*.maoros.net/*', 
        '*://*.onclickperformance.com/*', '*://*.42416.com/*'
    ];
    session.defaultSession.webRequest.onBeforeRequest({ urls: AD_DOMAINS }, (details, callback) => callback({ cancel: true }));

    mainWindow.webContents.on('will-navigate', (event, url) => {
        const isLocal = url.startsWith('file://') || url.includes('index.html');
        if (!isLocal) event.preventDefault();
    });

    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.loadFile('index.html');

    // --- IPC & LOGIC ---
    ipcMain.on('reset-stream-active', () => { streamActive = false; });
    ipcMain.on('get-video-time', async () => {}); 

    // --- CONTROLLER ---
    ipcMain.on('video-command', async (event, data) => {
        const command = typeof data === 'string' ? data : data.action;
        const frames = mainWindow.webContents.mainFrame.frames;

        for (const frame of frames) {
            try {
                const hasVideo = await frame.executeJavaScript(`(() => { const v = document.querySelector('video'); return v && v.duration > 0; })()`, true);

                if (hasVideo) {
                    if (command === 'togglePlay') {
                        const center = getScaledCoords(BASE_CENTER_X, BASE_CENTER_Y);
                        const startPaused = await frame.executeJavaScript(`document.querySelector('video').paused`, true);
                        const startAudible = mainWindow.webContents.isCurrentlyAudible();
                        
                        for (let i = 0; i < 15; i++) {
                            await simulateClick(center.x, center.y);
                            await new Promise(r => setTimeout(r, 100));
                            const nowPaused = await frame.executeJavaScript(`document.querySelector('video').paused`, true);
                            const nowAudible = mainWindow.webContents.isCurrentlyAudible();
                            if (nowPaused !== startPaused) break; 
                            if (startPaused === true && nowAudible === true) break; 
                        }
                    } 
                    else if (command === 'rewind') {
                        const rwd = getScaledCoords(BASE_REWIND_X, BASE_REWIND_Y);
                        const start = await frame.executeJavaScript(`document.querySelector('video').currentTime`, true);
                        for(let i=0; i<5; i++) {
                            await simulateClick(rwd.x, rwd.y); await new Promise(r => setTimeout(r, 150));
                            const now = await frame.executeJavaScript(`document.querySelector('video').currentTime`, true);
                            if(now < start - 2) break; 
                        }
                    } 
                    else if (command === 'forward') {
                        const fwd = getScaledCoords(BASE_FORWARD_X, BASE_FORWARD_Y);
                        const start = await frame.executeJavaScript(`document.querySelector('video').currentTime`, true);
                        for(let i=0; i<5; i++) {
                            await simulateClick(fwd.x, fwd.y); await new Promise(r => setTimeout(r, 150));
                            const now = await frame.executeJavaScript(`document.querySelector('video').currentTime`, true);
                            if(now > start + 2) break;
                        }
                    }
                    else if (data.action === 'seek') {
                        const percent = data.percent;
                        const scaledStart = getScaledCoords(BASE_BAR_START_X, BASE_BAR_Y);
                        const scaledEnd = getScaledCoords(BASE_BAR_END_X, BASE_BAR_Y);
                        const targetX = Math.round(scaledStart.x + (percent * (scaledEnd.x - scaledStart.x)));
                        const targetY = scaledStart.y; // Y is constant
                        await simulateClick(targetX, targetY);
                    }
                    break;
                }
            } catch (e) {}
        }
    });

    globalShortcut.register('Escape', () => app.quit());
}

// =================================================================
// HOT-SWAP GITHUB UPDATER (NO ELECTRON-UPDATER)
// =================================================================

const REPO_OWNER = "rzzse";
const REPO_NAME = "funnymonkeybusiness";
const BRANCH = "main";
const FILES_TO_UPDATE = ['package.json', 'main.js', 'preload.js', 'index.html']; 

// =================================================================
// FORCE-READ UPDATER (Reads package.json directly)
// =================================================================

function checkForCodeUpdates() {
    console.log('[Updater] Checking GitHub...');
    if (mainWindow) mainWindow.webContents.send('update-message', { text: 'Checking GitHub...', status: 'checking' });

    // 1. Request the Package JSON from GitHub (Timestamp prevents caching)
    const request = net.request(`https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${BRANCH}/package.json?t=${Date.now()}`);

    request.on('response', (response) => {
        let body = '';
        response.on('data', (chunk) => body += chunk);
        response.on('end', () => {
            try {
                if (response.statusCode !== 200) throw new Error("GitHub 404 - Repo Not Found");
                
                // 1. Get Remote Version
                const remotePkg = JSON.parse(body);
                const remoteVer = remotePkg.version;

                // 2. Get Local Version (FORCE READ FROM DISK)
                // We do not use app.getVersion() because it returns 0.0.0 in dev
                const localPath = path.join(__dirname, 'package.json');
                const localData = fs.readFileSync(localPath, 'utf-8');
                const localPkg = JSON.parse(localData);
                const localVer = localPkg.version;

                console.log(`[Updater] 📂 Reading from: ${localPath}`);
                console.log(`[Updater] 📊 Compare: Local(${localVer}) vs Remote(${remoteVer})`);

                if (localVer !== remoteVer) {
                    // Update Available
                    if (mainWindow) mainWindow.webContents.send('update-message', { 
                        text: 'Update Found', 
                        status: 'available', 
                        localVersion: localVer, 
                        remoteVersion: remoteVer 
                    });
                } else {
                    // Up To Date
                    if (mainWindow) mainWindow.webContents.send('update-message', { 
                        text: 'You are up to date!', 
                        status: 'uptodate',
                        localVersion: localVer // <--- Sends the real version (e.g. 0.0.1)
                    });
                }
            } catch (e) {
                console.error('[Updater] Error:', e);
                if (mainWindow) mainWindow.webContents.send('update-message', { text: "Error: " + e.message, status: 'error' });
            }
        });
    });
    
    request.on('error', (err) => {
         if (mainWindow) mainWindow.webContents.send('update-message', { text: "Network Error", status: 'error' });
    });
    request.end();
}

async function downloadUpdates() {
    if (mainWindow) mainWindow.webContents.send('update-message', { text: 'Downloading...', status: 'downloading' });
    try {
        for (const file of FILES_TO_UPDATE) {
            await downloadFile(file);
        }
        if (mainWindow) mainWindow.webContents.send('update-message', { text: 'Restarting...', status: 'ready' });
        
        // Wait 1s for the UI to show "Restarting" then reboot
        setTimeout(() => { app.relaunch(); app.exit(0); }, 1000);
    } catch (err) {
        if (mainWindow) mainWindow.webContents.send('update-message', { text: 'Failed: ' + err.message, status: 'error' });
    }
}

function downloadFile(filename) {
    return new Promise((resolve, reject) => {
        const url = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${BRANCH}/${filename}`;
        const request = net.request(`${url}?t=${Date.now()}`);
        request.on('response', (response) => {
            let fileData = '';
            response.on('data', (chunk) => fileData += chunk);
            response.on('end', () => {
                fs.writeFileSync(path.join(__dirname, filename), fileData);
                resolve();
            });
        });
        request.on('error', reject);
        request.end();
    });
}

// LINK THE BUTTONS
ipcMain.on('check-for-updates', () => checkForCodeUpdates());
ipcMain.on('start-download', () => downloadUpdates());
ipcMain.on('restart-app', () => { app.relaunch(); app.exit(0); });

// APP LIFECYCLE
app.on('ready', createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });