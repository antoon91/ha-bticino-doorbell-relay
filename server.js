const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const app = express();
const port = 3000;

app.use(express.json());
app.use(express.static('public'));

// Log incoming requests and outgoing responses
app.use((req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] || 'Unknown';
    const startTime = new Date();
    
    console.log(`[${startTime.toISOString()}] ➡️ Incoming Request from ${ip} (${userAgent}): ${req.method} ${req.url}`);
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
        console.log(`[${new Date().toISOString()}] ⬅️ Outgoing Response to ${ip}: HTTP ${res.statusCode} (took ${duration}ms)`);
        if (res.locals.responseBody) {
            console.log('    Payload:', typeof res.locals.responseBody === 'object' ? JSON.stringify(res.locals.responseBody, null, 2) : res.locals.responseBody);
        }
    });

    next();
});

let browser = null;
let context = null;
let page = null;

// Endpoint for Python to push config and start the relay
app.post('/start', async (req, res) => {
    const config = req.body;
    
    if (!config || !config.access_token) {
        return res.status(400).json({ error: 'Missing config data' });
    }

    // Reuse the existing stream if it's already active to prevent redundant calls to the intercom
    if (page && !page.isClosed()) {
        console.log('Stream session is already active. Reusing existing stream!');
        return res.json({ status: 'started', rtsp_url: 'rtsp://localhost:8554/doorbell' });
    }

    try {
        if (!browser) {
            browser = await chromium.launch({
                args: [
                    '--use-fake-ui-for-media-stream',
                    '--use-fake-device-for-media-stream',
                    '--no-sandbox',
                    '--disable-setuid-sandbox'
                ]
            });
            context = await browser.newContext();
        }

        page = await context.newPage();

        // Pipe page console logs to terminal
        page.on('console', msg => console.log('PAGE LOG:', msg.text()));
        
        // Pass config to the page via a global variable
        await page.addInitScript((configData) => {
            window.BTICINO_CONFIG = configData;
        }, config);

        // Setup promise to wait for WHIP activation
        const whipReady = new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.log('Timeout waiting for WHIP stream to start...');
                resolve(false);
            }, 10000); // 10 seconds timeout

            page.on('console', msg => {
                const text = msg.text();
                if (text.includes('WHIP Answer set') || text.includes('RELAY ACTIVE')) {
                    clearTimeout(timeout);
                    resolve(true);
                }
            });
        });

        // Load the relay page
        await page.goto(`http://localhost:${port}/relay.html`);
        console.log('Relay page loaded, waiting for WHIP stream to start...');
        
        const isReady = await whipReady;
        if (isReady) {
            console.log('Stream is ACTIVE and publishing to MediaMTX!');
        } else {
            console.log('Stream initiation timed out, proceeding anyway...');
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
        if (page) await page.close();
        res.json({ status: 'stopped' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Relay control API listening at http://localhost:${port}`);
});
