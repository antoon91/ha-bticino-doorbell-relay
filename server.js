const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const app = express();
const port = 3000;

app.use(express.json());
app.use(express.static('public'));

let browser = null;
let context = null;
let page = null;

// Endpoint for Python to push config and start the relay
app.post('/start', async (req, res) => {
    const config = req.body;
    
    if (!config || !config.access_token) {
        return res.status(400).json({ error: 'Missing config data' });
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

        // Load the relay page
        await page.goto(`http://localhost:${port}/relay.html`);
        
        console.log('Relay page loaded and started');
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
