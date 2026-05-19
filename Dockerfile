# Use Playwright's official image as base (contains Node and Chromium dependencies)
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

# Disable hardware video encoders to force GStreamer to use software encoders (x264) in Docker
# Also set GST_DEBUG to 2 (warnings/errors) to output GStreamer diagnostics
ENV GST_PLUGIN_FEATURE_RANK=v4l2h264enc:0,omxh264enc:0 \
    GST_DEBUG="*:2"

# Install MediaMTX, Python 3, FFmpeg, and Python websockets package
WORKDIR /app
RUN apt-get update && apt-get install -y wget curl python3 python3-pip ffmpeg && \
    pip3 install websockets && \
    ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then \
        MEDIAMTX_ARCH="amd64"; \
    elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then \
        MEDIAMTX_ARCH="arm64v8"; \
    else \
        echo "Unknown architecture: $ARCH" && exit 1; \
    fi && \
    wget https://github.com/bluenviron/mediamtx/releases/download/v1.9.0/mediamtx_v1.9.0_linux_${MEDIAMTX_ARCH}.tar.gz && \
    tar -xvzf mediamtx_v1.9.0_linux_${MEDIAMTX_ARCH}.tar.gz && \
    rm mediamtx_v1.9.0_linux_${MEDIAMTX_ARCH}.tar.gz

# Install snap-less Chromium with H.264 support from xtradeb PPA
RUN apt-get update && apt-get install -y software-properties-common && \
    add-apt-repository -y ppa:xtradeb/apps && \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y chromium

# Copy project files
COPY package.json .
RUN npm install
COPY . .

# Expose ports
# 3000: Control API
# 8554: RTSP
# 8889: WebRTC / WHIP
# 9997: MediaMTX API
# 9999: Python WebSocket Streamer
EXPOSE 3000 8554 8889 9997 9999

# Start script to run both MediaMTX and the Node server
RUN echo "#!/bin/bash\n./mediamtx mediamtx.yml & npm start" > start.sh
RUN chmod +x start.sh

CMD ["./start.sh"]
