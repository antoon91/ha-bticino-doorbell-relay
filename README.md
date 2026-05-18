# Bticino Classe 100 WebRTC-to-RTSP Docker Relay

A robust, headless relay system designed to extract a stable H264 video stream from a Bticino/Netatmo doorbell and expose it as a local RTSP feed. This relay is specifically designed to be used in conjunction with the [Home Assistant Bticino Doorbell custom component](https://github.com/aanton/home-assistant-bticino-doorbell).

## 🚀 How it Works

The system uses a multi-stage relay to overcome the sensitivity of the Bticino firmware and the complexities of WebRTC in a headless environment:

1.  **Home Assistant Trigger**: When the camera stream is requested in Home Assistant, the custom component sends a POST request to this relay's Control API (port 3000) containing the necessary authentication tokens and ICE servers.
2.  **Node.js Relay (Headless Browser)**: Uses Playwright (Chromium) to run a script that mirrors the exact signaling logic of the original `bticino_card.js`. This ensures bit-for-bit parity with the official handshake sequence.
3.  **MediaMTX Hub**: Acts as the media ingestion point. The headless browser pushes the doorbell's WebRTC stream (WHIP) to an internal MediaMTX instance, which then exposes it as a standard RTSP stream.
4.  **H264 Passthrough**: The system is specifically configured to prioritize H264, ensuring zero-transcoding latency and full compatibility with HomeKit and Home Assistant.

## 🛠 Installation & Usage (Docker)

This relay is designed to run entirely within Docker to encapsulate the headless browser and MediaMTX server.

### 1. Build the Docker Image

```bash
docker build -t bticino-relay .
```

### 2. Run the Container

```bash
docker run -d \
  --name bticino-relay \
  -p 3000:3000 \
  -p 8554:8554 \
  -p 8889:8889 \
  bticino-relay
```

### Ports
- `3000`: Control API (Receives the `POST /start` command from Home Assistant)
- `8554`: RTSP Stream output (`rtsp://localhost:8554/doorbell`)
- `8889`: WebRTC / WHIP

## 🏃‍♂️ Testing Manually (Without Home Assistant)

If you want to test the relay independently of Home Assistant, you can send a manual POST request to the Control API. You will need to obtain your own Netatmo OAuth token and TURN servers.

```bash
curl -X POST http://localhost:3000/start \
  -H "Content-Type: application/json" \
  -d '{
    "access_token": "YOUR_NETATMO_OAUTH_TOKEN",
    "ice_servers": [{"urls": ["turn:...", "stun:..."], "username": "...", "credential": "..."}],
    "bridge_id": "YOUR_BRIDGE_MAC",
    "module_id": "YOUR_MODULE_ID"
  }'
```

Once started, the stream can be viewed at:
- **RTSP Feed**: `rtsp://localhost:8554/doorbell` (VLC or Home Assistant)
- **WebRTC Player**: [http://localhost:8889/doorbell](http://localhost:8889/doorbell) (MediaMTX native player)

## 📁 Directory Structure
- `Dockerfile`: Multi-stage build pulling Playwright and MediaMTX.
- `server.js`: Node.js Express server to orchestrate Playwright.
- `public/relay_script.js`: The "brain" that performs the exact WebRTC handshake.
- `mediamtx.yml`: Configuration for H264/WHIP ingestion into MediaMTX.
