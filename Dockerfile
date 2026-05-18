# Use Playwright's official image as base (contains Node and Chromium dependencies)
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

# Install MediaMTX
WORKDIR /app
RUN apt-get update && apt-get install -y wget curl && \
    wget https://github.com/bluenviron/mediamtx/releases/download/v1.9.0/mediamtx_v1.9.0_linux_amd64.tar.gz && \
    tar -xvzf mediamtx_v1.9.0_linux_amd64.tar.gz && \
    rm mediamtx_v1.9.0_linux_amd64.tar.gz

# Copy project files
COPY package.json .
RUN npm install
COPY . .

# Expose ports
# 3000: Control API
# 8554: RTSP
# 8889: WebRTC / WHIP
# 9997: MediaMTX API
EXPOSE 3000 8554 8889 9997

# Start script to run both MediaMTX and the Node server
RUN echo "#!/bin/bash\n./mediamtx mediamtx.yml & npm start" > start.sh
RUN chmod +x start.sh

CMD ["./start.sh"]
