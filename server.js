const express = require('express');
const { chromium, firefox, webkit } = require('playwright');
const path = require('path');
const app = express();
const port = 3000;

const serverLogs = [];

function logServerEvent(msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    console.log(`[${new Date().toISOString()}] [${type.toUpperCase()}] ${msg}`);
    serverLogs.push({ time, text: msg, type });
    if (serverLogs.length > 200) serverLogs.shift();
}

app.use(express.json());
app.use(express.static('public'));

// Log incoming requests and outgoing responses
app.use((req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] || 'Unknown';
    const startTime = new Date();
    
    // Ignore log polling requests from spamming terminal logs
    if (req.url !== '/logs') {
        logServerEvent(`➡️ Incoming Request: ${req.method} ${req.url} (from ${ip})`, 'info');
    }
    
    if (req.method === 'POST' && req.url === '/start') {
        console.log('    Parameters: ', {
            bridge_id: req.body.bridge_id,
            module_id: req.body.module_id,
            has_token: !!req.body.access_token,
            ice_servers_count: req.body.ice_servers ? req.body.ice_servers.length : 0
        });
    }

    // Intercept response body for logging
    const originalJson = res.json;
    res.json = function (body) {
        res.locals.responseBody = body;
        return originalJson.apply(this, arguments);
    };

    const originalSend = res.send;
    res.send = function (body) {
        if (!res.locals.responseBody) {
            res.locals.responseBody = body;
        }
        return originalSend.apply(this, arguments);
    };

    res.on('finish', () => {
        const duration = new Date() - startTime;
        if (req.url !== '/logs') {
            logServerEvent(`⬅️ Outgoing Response: HTTP ${res.statusCode} (took ${duration}ms)`, 'info');
        }
    });

    next();
});

let browser = null;
let context = null;
let page = null;

async function closeSession() {
    try {
        if (page) {
            logServerEvent('Closing browser page...', 'info');
            await page.close().catch(() => {});
            page = null;
        }
        if (browser) {
            logServerEvent('Closing browser...', 'info');
            await browser.close().catch(() => {});
            browser = null;
            context = null;
        }
        logServerEvent('Stream session stopped and browser terminated successfully.', 'info');
    } catch (err) {
        logServerEvent(`Error during closeSession: ${err.message}`, 'error');
    }
}

// Endpoint for Python to push config and start the relay
app.post('/start', async (req, res) => {
    const config = req.body;
    
    if (!config || !config.access_token) {
        return res.status(400).json({ error: 'Missing config data' });
    }

    // Reuse the existing stream if it's already active to prevent redundant calls to the intercom
    if (page && !page.isClosed()) {
        logServerEvent('Stream session is already active. Reusing existing stream!', 'info');
        return res.json({ status: 'started', rtsp_url: 'rtsp://localhost:8554/doorbell' });
    }

    try {
        if (!browser) {
            try {
                // Try launching native system Chromium (/usr/bin/chromium) first for H.264 support
                browser = await chromium.launch({
                    executablePath: '/usr/bin/chromium',
                    args: [
                        '--use-fake-ui-for-media-stream',
                        '--use-fake-device-for-media-stream',
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--autoplay-policy=no-user-gesture-required',
                        '--disable-background-timer-throttling',
                        '--disable-backgrounding-occluded-windows',
                        '--disable-renderer-backgrounding'
                    ]
                });
                logServerEvent('Launched system Chromium successfully with H.264 support', 'info');
            } catch (err) {
                logServerEvent(`System Chromium launch failed: ${err.message}. Trying default Playwright Chromium...`, 'warning');
                try {
                    browser = await chromium.launch({
                        args: [
                            '--use-fake-ui-for-media-stream',
                            '--use-fake-device-for-media-stream',
                            '--no-sandbox',
                            '--disable-setuid-sandbox',
                            '--autoplay-policy=no-user-gesture-required',
                            '--disable-background-timer-throttling',
                            '--disable-backgrounding-occluded-windows',
                            '--disable-renderer-backgrounding'
                        ]
                    });
                    logServerEvent('Launched default Playwright Chromium successfully', 'info');
                } catch (defaultErr) {
                    logServerEvent(`Default Playwright Chromium launch failed: ${defaultErr.message}. Trying WebKit...`, 'warning');
                    try {
                        browser = await webkit.launch();
                        logServerEvent('Launched WebKit successfully with H.264 support', 'info');
                    } catch (webkitErr) {
                        logServerEvent(`WebKit launch failed: ${webkitErr.message}. Trying Firefox...`, 'warning');
                        try {
                            browser = await firefox.launch({
                                firefoxUserPrefs: {
                                    'media.navigator.streams.fake': true,
                                    'media.navigator.permission.disabled': true,
                                    'media.autoplay.default': 0, // Allow autoplay
                                    'dom.webnotifications.enabled': false
                                }
                            });
                            logServerEvent('Launched Firefox successfully with H.264 support', 'info');
                        } catch (firefoxErr) {
                            logServerEvent(`All browser launches failed! Last error: ${firefoxErr.message}`, 'error');
                            throw new Error('No compatible browser could be launched.');
                        }
                    }
                }
            }
            context = await browser.newContext();
        }

        page = await context.newPage();

        // Pipe page console logs to terminal and serverLogs
        page.on('console', msg => {
            const text = msg.text();
            console.log('PAGE LOG:', text);
            
            let type = 'info';
            if (text.includes('❌') || text.includes('Error') || text.includes('failed') || text.includes('exception')) type = 'error';
            else if (text.includes('⚠️') || text.includes('Warning') || text.includes('Timeout')) type = 'warning';
            else if (text.includes('✅') || text.includes('success') || text.includes('ready') || text.includes('Binding') || text.includes('TRACK ARRIVED')) type = 'success';
            
            logServerEvent(`[Relay] ${text}`, type);

            // Auto-close session if the peer connection is disconnected or failed
            if (text.includes('Netatmo ICE Connection State: disconnected') || 
                text.includes('Netatmo ICE Connection State: failed') ||
                text.includes('Netatmo ICE Connection State: closed')) {
                logServerEvent('ICE Connection lost. Cleaning up session...', 'warning');
                closeSession().catch(err => console.error('Error auto-closing session:', err));
            }
        });
        
        // Pass config to the page via a global variable
        await page.addInitScript((configData) => {
            window.BTICINO_CONFIG = configData;
        }, config);

        // Setup promise to wait for WHIP activation
        const whipReady = new Promise((resolve) => {
            const timeout = setTimeout(() => {
                logServerEvent('Timeout waiting for WHIP stream to start...', 'warning');
                resolve(false);
            }, 10000); // 10 seconds timeout

            page.on('console', msg => {
                const text = msg.text();
                if (text.includes('Netatmo connection established') || text.includes('WebRTC Insertable Streams supported')) {
                    clearTimeout(timeout);
                    resolve(true);
                }
            });
        });

        // Load the relay page
        await page.goto(`http://localhost:${port}/relay.html`);
        logServerEvent('Relay page loaded, waiting for Netatmo stream to connect...', 'info');
        
        const isReady = await whipReady;
        if (isReady) {
            logServerEvent('Stream is ACTIVE and forwarding to Python!', 'success');
        } else {
            logServerEvent('Stream initiation timed out, proceeding anyway...', 'warning');
        }
        
        res.json({ status: 'started', rtsp_url: 'rtsp://localhost:8554/doorbell' });

    } catch (error) {
        console.error('Error starting relay:', error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint to stop the relay
app.post('/stop', async (req, res) => {
    try {
        await closeSession();
        res.json({ status: 'stopped' });
    } catch (error) {
        logServerEvent(`Error stopping stream session: ${error.message}`, 'error');
        res.status(500).json({ error: error.message });
    }
});

// Proxy endpoint to fetch configuration from FastAPI server to avoid CORS issues in browsers
app.get('/fetch-config', async (req, res) => {
    try {
        const response = await fetch('http://localhost:8000/config');
        if (!response.ok) {
            throw new Error(`FastAPI server returned status ${response.status}`);
        }
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('Error fetching config from FastAPI:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint to receive events from MediaMTX hooks
app.post('/mediamtx-event', express.json(), (req, res) => {
    const { event, path, type, id } = req.body;
    let eventMsg = '';
    if (event === 'ready') {
        eventMsg = `🎥 [MediaMTX] Stream published & ready on path: /${path} (Source: ${type || 'N/A'})`;
    } else if (event === 'not_ready') {
        eventMsg = `🎥 [MediaMTX] Stream stopped publishing / offline on path: /${path}`;
        if (path === 'doorbell') {
            logServerEvent('Stream went offline on MediaMTX. Cleaning up session...', 'warning');
            closeSession().catch(err => console.error('Error auto-closing session:', err));
        }
    } else if (event === 'read') {
        eventMsg = `👥 [MediaMTX] Client started reading RTSP stream: /${path} (Reader: ${type || 'N/A'}, ID: ${id || 'N/A'})`;
    } else if (event === 'unread') {
        eventMsg = `👥 [MediaMTX] Client stopped reading RTSP stream: /${path} (Reader: ${type || 'N/A'}, ID: ${id || 'N/A'})`;
    } else {
        eventMsg = `🎥 [MediaMTX] Event: ${event} on path: /${path}`;
    }
    logServerEvent(eventMsg, 'success');
    res.json({ status: 'ok' });
});

// Endpoint to fetch logs
app.get('/logs', (req, res) => {
    res.json(serverLogs);
});

const { spawn } = require('child_process');
let pythonStreamer = null;

function startPythonStreamer() {
    logServerEvent('Starting Python WebRTC streamer daemon...', 'info');
    pythonStreamer = spawn('python3', [path.join(__dirname, 'relay_streamer.py')], {
        stdio: ['ignore', 'pipe', 'pipe']
    });

    pythonStreamer.stdout.on('data', (data) => {
        console.log(`[Python Streamer] ${data.toString().trim()}`);
    });

    pythonStreamer.stderr.on('data', (data) => {
        console.error(`[Python Streamer ERROR] ${data.toString().trim()}`);
    });

    pythonStreamer.on('close', (code) => {
        logServerEvent(`Python WebRTC streamer daemon exited with code ${code}`, 'warning');
    });
}

const cleanup = () => {
    if (pythonStreamer) {
        logServerEvent('Terminating Python WebRTC streamer daemon...', 'info');
        pythonStreamer.kill('SIGTERM');
        pythonStreamer = null;
    }
};
process.on('exit', cleanup);
process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
});
process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
});

app.listen(port, () => {
    console.log(`Relay control API listening at http://localhost:${port}`);
    startPythonStreamer();
});
