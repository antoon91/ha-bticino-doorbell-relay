/**
 * Bticino WebRTC Relay Script (Headless)
 * EXACT LOGIC COPY of bticino_card.js v0.4.0
 */

const uiLog = (msg, type = 'info') => {
    const consoleEl = document.getElementById('logConsole');
    if (consoleEl) {
        const line = document.createElement('div');
        line.className = `log-line ${type}`;
        line.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
        consoleEl.appendChild(line);
        consoleEl.scrollTop = consoleEl.scrollHeight;
    }
};

const updateStatus = (msg, type = 'info') => {
    console.log(`[Status] ${msg}`);
    uiLog(msg, type);
    const statusTextEl = document.getElementById('statusText');
    const statusDotEl = document.getElementById('statusDot');
    if (statusTextEl) statusTextEl.innerText = msg;
    if (statusDotEl) {
        statusDotEl.className = 'status-dot';
        if (type === 'success') {
            statusDotEl.classList.add('active');
        } else if (type === 'error') {
            statusDotEl.classList.add('failed');
        }
    }
};

// Detect and display the browser type
const detectBrowser = () => {
    let browserName = 'Unknown';
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('firefox')) {
        browserName = 'Firefox (Gecko)';
    } else if (ua.includes('chrome') || ua.includes('chromium')) {
        browserName = 'Chromium (Blink)';
    } else if (ua.includes('safari') || ua.includes('applewebkit')) {
        browserName = 'WebKit (GStreamer)';
    }
    const el = document.getElementById('browserType');
    if (el) el.innerText = browserName;
};
detectBrowser();

async function startRelay() {
    console.log('--- startRelay() ENTERED ---');
    const config = window.BTICINO_CONFIG;
    if (!config) {
        updateStatus('Error: No config found');
        return;
    }
    console.log('Config present, token length:', config.access_token ? config.access_token.length : 0);

    updateStatus('Connecting to Python Streamer WebSocket...');
    
    let pc = null;
    let ws = null;
    let pyWs = null;
    let sessionId = null;
    let tagId = null;
    let candidateQueue = [];
    let remoteDescriptionSet = false;
    let callStarted = false;
    let connectionStartTime = null;
    let localStream = null;

    // Connect to Python WebSocket streamer
    pyWs = new WebSocket('ws://127.0.0.1:9999');
    pyWs.binaryType = 'arraybuffer';
    pyWs.onopen = () => {
        console.log('🔌 Connected to Python WebSocket streamer');
        uiLog('🔌 Connected to Python WebSocket streamer', 'success');
        
        // Once Python WebSocket is open, connect to Netatmo signaling
        connectToNetatmo();
    };
    pyWs.onerror = (e) => {
        console.error('❌ Python WebSocket error:', e);
        uiLog('❌ Python WebSocket error', 'error');
    };

    // Setup local audio oscillator (silence)
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        osc.frequency.value = 440;
        const dest = audioCtx.createMediaStreamDestination();
        osc.connect(dest);
        osc.start();
        localStream = dest.stream;
        if (audioCtx.state === 'suspended') {
            audioCtx.resume().catch(e => console.warn('⚠️ Audio context was suspended, failed to resume:', e));
        }
    } catch (err) {
        console.error('Local stream setup failed:', err);
        updateStatus('Error: Local stream setup failed', 'error');
        return;
    }

    function connectToNetatmo() {
        if (ws) ws.close();
        ws = new WebSocket('wss://app-ws.netatmo.net/appws/');

        ws.onopen = () => {
            updateStatus('☁️ Persistent connection to Netatmo established', 'info');
            ws.send(JSON.stringify({
                action: 'subscribe',
                access_token: config.access_token,
                app_type: 'app_security',
                version: '1.0',
                platform: 'android'
            }));

            // Start the call shortly after subscription, mimicking a user interaction
            setTimeout(() => {
                if (!callStarted) {
                    callStarted = true;
                    _startCall();
                }
            }, 1000);
        };

        ws.onmessage = async (msg) => {
            const data = JSON.parse(msg.data);
            console.log('📥 Netatmo RAW: ' + JSON.stringify(data));

            if (data.status === 'ok') {
                if (data.session_id) sessionId = data.session_id;
                if (data.tag_id) tagId = data.tag_id;
                
                if (data.action === 'subscribe') {
                    updateStatus('✅ Subscription Active', 'success');
                }
            } else if (data.action === 'rtc' || data.type === 'rtc' || data.type === 'app_security') {
                const payload = data.data;
                if (!payload) return;

                if (payload.type === 'answer') {
                    const remoteSdp = payload.sdp || payload.session_description?.sdp;
                    console.log('📦 Received Answer SDP');
                    try {
                        await pc.setRemoteDescription({ type: 'answer', sdp: remoteSdp });
                        console.log('✅ Answer processed, flushing candidates');
                        remoteDescriptionSet = true;
                        _flushCandidates();
                    } catch (err) {
                        console.error('❌ FAILED to set Remote Description:', err.message);
                    }
                } else if (payload.type === 'candidate') {
                    try {
                        if (pc?.remoteDescription) {
                            await pc.addIceCandidate({
                                candidate: payload.ice_candidate.candidate,
                                sdpMLineIndex: payload.ice_candidate.sdp_m_line_index,
                                sdpMid: payload.ice_candidate.sdp_mid
                            });
                        }
                    } catch (e) { console.error('Error adding remote candidate:', e); }
                }
            }
        };

        ws.onclose = () => {
            console.warn('☁️ WebSocket closed, reconnecting in 5s...');
            setTimeout(() => connectToNetatmo(), 5000);
        };
    }

    function _sendCandidateToNetatmo(candidate) {
        candidateQueue.push(candidate);
        if (remoteDescriptionSet) {
            _flushCandidates();
        }
    }

    function _flushCandidates() {
        if (ws?.readyState === WebSocket.OPEN && sessionId) {
            while (candidateQueue.length > 0) {
                const candidate = candidateQueue.shift();
                ws.send(JSON.stringify({
                    action: 'rtc',
                    device_id: config.bridge_id,
                    session_id: sessionId,
                    tag_id: tagId,
                    correlation_id: (Date.now() + Math.floor(Math.random() * 1000)).toString(),
                    data: {
                        type: 'candidate',
                        ice_candidate: {
                            candidate: candidate.candidate,
                            sdp_m_line_index: candidate.sdpMLineIndex,
                            sdp_mid: candidate.sdpMid
                        }
                    }
                }));
            }
        }
    }

    async function _startCall() {
        updateStatus('Starting WebRTC call sequence...', 'info');

        pc = new RTCPeerConnection({
            iceServers: config.ice_servers,
            rtcpMuxPolicy: 'require',
            bundlePolicy: 'max-bundle',
            iceTransportPolicy: 'all',
            encodedInsertableStreams: true
        });

        pc.oniceconnectionstatechange = () => {
            const state = pc.iceConnectionState;
            const logMsg = `🔌 Netatmo ICE Connection State: ${state}`;
            console.log(logMsg);
            uiLog(logMsg, state === 'failed' ? 'error' : state === 'connected' ? 'success' : 'info');
            if (state === 'connected' || state === 'completed') {
                if (!connectionStartTime) {
                    connectionStartTime = Date.now();
                    updateStatus('🔌 Netatmo connection established!', 'success');
                }
            }
        };

        // Periodically check WebRTC inbound stream stats to monitor traffic and frames
        let lastStats = {
            video: { bytes: 0, packets: 0, frames: 0 },
            audio: { bytes: 0, packets: 0 }
        };
        const statsInterval = setInterval(async () => {
            if (!pc || pc.signalingState === 'closed') {
                clearInterval(statsInterval);
                return;
            }
            try {
                const stats = await pc.getStats();
                stats.forEach(report => {
                    if (report.type === 'inbound-rtp') {
                        if (report.kind === 'video') {
                            const bytesDiff = report.bytesReceived - lastStats.video.bytes;
                            const packetsDiff = report.packetsReceived - lastStats.video.packets;
                            const framesDiff = (report.framesDecoded || 0) - lastStats.video.frames;
                            
                            const logMsg = `📊 Inbound Video: received ${report.packetsReceived} packets (+${packetsDiff}), ${report.bytesReceived} bytes (+${bytesDiff}), decoded ${report.framesDecoded || 0} frames (+${framesDiff})`;
                            console.log(logMsg);
                            uiLog(logMsg, 'info');

                            // Update HTML elements
                            const pktsEl = document.getElementById('inVideoPackets');
                            const bytesEl = document.getElementById('inVideoBytes');
                            const framesEl = document.getElementById('inVideoFrames');
                            if (pktsEl) pktsEl.innerText = `${report.packetsReceived} (+${packetsDiff})`;
                            if (bytesEl) bytesEl.innerText = `${(report.bytesReceived / 1024).toFixed(1)} KB (+${(bytesDiff / 1024).toFixed(1)} KB)`;
                            if (framesEl) framesEl.innerText = `${report.framesDecoded || 0} (+${framesDiff})`;
                            
                            lastStats.video.bytes = report.bytesReceived;
                            lastStats.video.packets = report.packetsReceived;
                            lastStats.video.frames = report.framesDecoded || 0;
                        } else if (report.kind === 'audio') {
                            const bytesDiff = report.bytesReceived - lastStats.audio.bytes;
                            const packetsDiff = report.packetsReceived - lastStats.audio.packets;
                            
                            const logMsg = `📊 Inbound Audio: received ${report.packetsReceived} packets (+${packetsDiff}), ${report.bytesReceived} bytes (+${bytesDiff})`;
                            console.log(logMsg);
                            uiLog(logMsg, 'info');

                            // Update HTML elements
                            const pktsEl = document.getElementById('inAudioPackets');
                            const bytesEl = document.getElementById('inAudioBytes');
                            if (pktsEl) pktsEl.innerText = `${report.packetsReceived} (+${packetsDiff})`;
                            if (bytesEl) bytesEl.innerText = `${(report.bytesReceived / 1024).toFixed(1)} KB (+${(bytesDiff / 1024).toFixed(1)} KB)`;
                            
                            lastStats.audio.bytes = report.bytesReceived;
                            lastStats.audio.packets = report.packetsReceived;
                        }
                    }
                });
            } catch (err) {
                console.warn('Failed to retrieve WebRTC stats:', err.message);
            }
        }, 5000);

        localStream.getAudioTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
        pc.addTransceiver('video', { direction: 'recvonly' });

        pc.ontrack = (e) => {
            const track = e.track;
            console.log(`🎥 TRACK ARRIVED: ${track.kind} (${track.label})`);
            uiLog(`🎥 TRACK ARRIVED: ${track.kind}`, 'success');
            
            if (track.kind === 'video') {
                const receiver = e.receiver;
                if (receiver.createEncodedStreams) {
                    console.log('✅ WebRTC Insertable Streams supported by receiver');
                    uiLog('✅ WebRTC Insertable Streams supported by receiver', 'success');
                    const streams = receiver.createEncodedStreams();
                    const readable = streams.readable;
                    const writable = streams.writable;
                    
                    const reader = readable.getReader();
                    const writer = writable.getWriter();
                    
                    console.log('🔑 Encoded video frame processor started, reading first frame...');
                    let frameCount = 0;
                    async function processEncodedFrames() {
                        try {
                            while (true) {
                                const { value, done } = await reader.read();
                                if (done) {
                                    console.log('🔑 Encoded video frame processor done');
                                    break;
                                }
                                
                                frameCount++;
                                if (frameCount === 1) {
                                    console.log(`📥 JS FIRST ENCODED FRAME: ${value.data.byteLength} bytes, type: ${value.type}`);
                                } else if (frameCount % 30 === 0) {
                                    console.log(`📥 JS ENCODED FRAME #${frameCount}: ${value.data.byteLength} bytes`);
                                }
                                
                                // Send raw Annex B H.264 frame to Python over WebSocket
                                if (pyWs && pyWs.readyState === WebSocket.OPEN) {
                                    pyWs.send(value.data);
                                }
                                
                                // Write the frame back so the browser pipeline remains happy
                                await writer.write(value);
                            }
                        } catch (err) {
                            console.error('Error in encoded frames processor:', err);
                        }
                    }
                    processEncodedFrames();
                } else {
                    console.error('❌ Browser does not support Insertable Streams (createEncodedStreams)!');
                    uiLog('❌ Browser does not support Insertable Streams!', 'error');
                }
            }

            const stream = e.streams[0] || new MediaStream([track]);
            const videoEl = document.getElementById('remoteVideo');
            if (videoEl && videoEl.srcObject !== stream) {
                console.log('📺 Binding remote WebRTC stream to video element');
                videoEl.srcObject = stream;
            }
        };

        pc.onicecandidate = (e) => {
            if (e.candidate) _sendCandidateToNetatmo(e.candidate);
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        ws.send(JSON.stringify({
            action: 'rtc',
            device_id: config.bridge_id,
            correlation_id: Date.now().toString(),
            data: {
                type: 'offer',
                session_description: {
                    type: 'call',
                    sdp: _sanitizeSDP(pc.localDescription.sdp),
                    module_id: config.module_id
                }
            }
        }));
    }

    function _sanitizeSDP(sdp) {
        console.log('Original SDP to sanitize:\n', sdp);
        const lines = sdp.split(/\r?\n/);
        let ufrag, pwd, fingerprint;

        for (let line of lines) {
            line = line.trim();
            if (line.startsWith('a=ice-ufrag:')) ufrag = line.split(':')[1];
            if (line.startsWith('a=ice-pwd:')) pwd = line.split(':')[1];
            if (line.startsWith('a=fingerprint:sha-256 ')) fingerprint = line.split(' ')[1];
        }

        const logParsed = `Parsed SDP fields: ufrag=${ufrag}, pwd=${pwd}, fingerprint=${fingerprint}`;
        console.log(logParsed);
        uiLog(logParsed, 'info');

        const sanitized = [
            'v=0',
            'o=- 1234567890 2 IN IP4 127.0.0.1',
            's=-',
            't=0 0',
            'a=group:BUNDLE 0 1',
            'a=msid-semantic: WMS',
            'm=audio 9 UDP/TLS/RTP/SAVPF 111',
            'c=IN IP4 0.0.0.0',
            'a=rtcp:9 IN IP4 0.0.0.0',
            'a=rtcp-mux',
            'a=mid:0',
            'a=sendrecv',
            'a=rtpmap:111 opus/48000/2',
            'a=fmtp:111 minptime=10;useinbandfec=1',
            'a=ssrc:1000 cname:pybticino-lib',
            `a=ice-ufrag:${ufrag}`,
            `a=ice-pwd:${pwd}`,
            `a=fingerprint:sha-256 ${fingerprint}`,
            'a=setup:actpass',
            'm=video 9 UDP/TLS/RTP/SAVPF 103',
            'c=IN IP4 0.0.0.0',
            'a=rtcp:9 IN IP4 0.0.0.0',
            'a=rtcp-mux',
            'a=mid:1',
            'a=recvonly',
            'a=rtpmap:103 H264/90000',
            'a=fmtp:103 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f',
            'a=rtcp-fb:103 nack pli',
            'a=rtcp-fb:103 ccm fir',
            'a=ssrc:1001 cname:pybticino-lib',
            `a=ice-ufrag:${ufrag}`,
            `a=ice-pwd:${pwd}`,
            `a=fingerprint:sha-256 ${fingerprint}`,
            'a=setup:actpass',
            ''
        ].join('\r\n');

        console.log('Sanitized SDP output:\n', sanitized);
        return sanitized;
    }
}

window.onload = startRelay;
