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

    updateStatus('Connecting to Netatmo...');
    
    let pc = null;
    let ws = null;
    let sessionId = null;
    let tagId = null;
    let candidateQueue = [];
    let remoteDescriptionSet = false;
    let callStarted = false;
    let connectionStartTime = null;
    let whipPc = null;
    let videoSender = null;
    let audioSender = null;
    let canvasInterval = null;
    let localStream = null;
    // Setup local audio oscillator
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        osc.frequency.value = 440;
        const dest = audioCtx.createMediaStreamDestination();
        osc.connect(dest);
        osc.start();
        localStream = dest.stream;
    } catch (err) {
        console.error('Local stream setup failed:', err);
        updateStatus('Error: Local stream setup failed');
        return;
    }

    // Start placeholder stream drawing (forces the H264 encoder to output valid stream right away)
    function startPlaceholderDrawing() {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        canvas.style.position = 'absolute';
        canvas.style.left = '-9999px';
        canvas.style.top = '-9999px';
        document.body.appendChild(canvas);
        
        const ctx = canvas.getContext('2d');
        let angle = 0;
        const startTime = Date.now();
        
        canvasInterval = setInterval(() => {
            // Background
            ctx.fillStyle = '#0a0b10';
            ctx.fillRect(0, 0, 640, 480);
            
            // Grid effect
            ctx.strokeStyle = '#1e293b';
            ctx.lineWidth = 1;
            for (let i = 0; i < 640; i += 40) {
                ctx.beginPath();
                ctx.moveTo(i, 0);
                ctx.lineTo(i, 480);
                ctx.stroke();
            }
            for (let j = 0; j < 480; j += 40) {
                ctx.beginPath();
                ctx.moveTo(0, j);
                ctx.lineTo(640, j);
                ctx.stroke();
            }
            
            // Glowing pulsing accent circle
            const pulse = Math.abs(Math.sin((Date.now() - startTime) / 1000));
            ctx.strokeStyle = `rgba(99, 102, 241, ${0.15 + pulse * 0.35})`;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(320, 240, 70, 0, Math.PI * 2);
            ctx.stroke();
            
            // Outer spinner
            ctx.strokeStyle = '#a855f7';
            ctx.lineWidth = 5;
            ctx.beginPath();
            ctx.arc(320, 240, 50, angle, angle + Math.PI * 0.4);
            ctx.stroke();
            angle += 0.1;
            
            // Title text
            ctx.fillStyle = '#f3f4f6';
            ctx.font = 'bold 22px system-ui, -apple-system, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('BTicino Doorbell Relay', 320, 130);
            
            ctx.fillStyle = '#9ca3af';
            ctx.font = '15px system-ui, -apple-system, sans-serif';
            ctx.fillText('Establishing Netatmo call...', 320, 330);
            
            // Elapsed time
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            ctx.fillStyle = '#6366f1';
            ctx.font = '13px monospace';
            ctx.fillText(`Negotiation time: ${elapsed}s`, 320, 365);
        }, 100); // 10 fps
        
        const captureMethod = canvas.captureStream || canvas.webkitCaptureStream;
        if (!captureMethod) {
            console.error('❌ canvas.captureStream is NOT supported in this browser context!');
            return null;
        }
        return captureMethod.call(canvas, 10);
    }

    console.log('Generating placeholder video track...');
    const placeholderStream = startPlaceholderDrawing();
    let placeholderVideoTrack = null;
    if (placeholderStream) {
        const videoTracks = placeholderStream.getVideoTracks();
        if (videoTracks.length > 0) {
            placeholderVideoTrack = videoTracks[0];
            console.log('✅ Generated placeholder video track:', placeholderVideoTrack.label);
        } else {
            console.error('❌ Placeholder stream has NO video tracks!');
        }
    } else {
        console.error('❌ Failed to create placeholder stream!');
    }

    let placeholderAudioTrack = null;
    if (localStream) {
        const audioTracks = localStream.getAudioTracks();
        if (audioTracks.length > 0) {
            placeholderAudioTrack = audioTracks[0];
            console.log('✅ Generated placeholder audio track:', placeholderAudioTrack.label);
        } else {
            console.error('❌ Local stream has NO audio tracks!');
        }
    }

    const initTracks = [];
    if (placeholderAudioTrack) initTracks.push(placeholderAudioTrack);
    if (placeholderVideoTrack) initTracks.push(placeholderVideoTrack);

    if (initTracks.length === 0) {
        console.error('❌ No tracks available for initial WHIP connection!');
        updateStatus('Error: No media tracks initialized', 'error');
        return;
    }

    console.log(`Starting WHIP with ${initTracks.length} tracks.`);
    const initStream = new MediaStream(initTracks);
    forwardToMediaMTX(initStream);

    // --- Signaling Connection (Simplified version of _connectToNetatmo) ---
    ws = new WebSocket('wss://app-ws.netatmo.net/appws/');

    ws.onopen = () => {
        updateStatus('☁️ Persistent connection to Netatmo established');
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
        console.log('📥 Netatmo RAW:', data);

        if (data.status === 'ok') {
            if (data.session_id) sessionId = data.session_id;
            if (data.tag_id) tagId = data.tag_id;
            
            if (data.action === 'subscribe') {
                updateStatus('✅ Subscription Active');
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
        updateStatus('Starting call sequence...');
        
        if (!localStream) {
            console.error('Local stream was not initialized!');
            return;
        }

         pc = new RTCPeerConnection({
            iceServers: config.ice_servers,
            rtcpMuxPolicy: 'require',
            bundlePolicy: 'max-bundle',
            iceTransportPolicy: 'all'
        });

        pc.oniceconnectionstatechange = () => {
            const state = pc.iceConnectionState;
            const logMsg = `🔌 Netatmo ICE Connection State: ${state}`;
            console.log(logMsg);
            uiLog(logMsg, state === 'failed' ? 'error' : state === 'connected' ? 'success' : 'info');
            if (state === 'connected' || state === 'completed') {
                if (!connectionStartTime) {
                    connectionStartTime = Date.now();
                    uiLog('🔌 Netatmo connection established! Fallback timer started.', 'success');
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

        let forwardingStarted = false;
        let arrivedTracks = [];
        let trackTimeout = null;

        function startMediaFlowCheck() {
            if (forwardingStarted) return;
            console.log('⏳ Waiting for media packets & decoded frames from Netatmo...');
            const checkInterval = setInterval(async () => {
                try {
                    const stats = await pc.getStats();
                    let audioPackets = 0;
                    let videoPackets = 0;
                    let videoFramesDecoded = 0;
                    
                    stats.forEach(report => {
                        if (report.type === 'inbound-rtp') {
                            if (report.kind === 'audio') {
                                audioPackets = report.packetsReceived || 0;
                            } else if (report.kind === 'video') {
                                videoPackets = report.packetsReceived || 0;
                                videoFramesDecoded = report.framesDecoded || 0;
                            }
                        }
                    });
                    
                    console.log(`⏳ Media flow check: Audio packets: ${audioPackets}, Video packets: ${videoPackets}, Decoded frames: ${videoFramesDecoded}`);
                    
                    let elapsed = 0;
                    if (connectionStartTime) {
                        elapsed = Date.now() - connectionStartTime;
                    }
                    
                    // Start forwarding if:
                    // 1. Audio packets are flowing AND video has decoded at least one frame (so video is active and structured)
                    // 2. Or if connection is established and 8 seconds elapsed, start with whatever packets are flowing (fallback)
                    if ((audioPackets > 0 && videoFramesDecoded > 0) || (connectionStartTime && elapsed > 8000 && (audioPackets > 0 || videoPackets > 0))) {
                        clearInterval(checkInterval);
                        if (!forwardingStarted) {
                            forwardingStarted = true;
                            const logReady = '✅ Real media ready! Replacing tracks on WHIP sender...';
                            console.log(logReady);
                            uiLog(logReady, 'success');

                            const netatmoVideoTrack = arrivedTracks.find(t => t.kind === 'video');
                            const netatmoAudioTrack = arrivedTracks.find(t => t.kind === 'audio');

                            if (videoSender && netatmoVideoTrack) {
                                console.log('🔄 Swapping in real Video track');
                                videoSender.replaceTrack(netatmoVideoTrack)
                                    .then(() => {
                                        console.log('✅ Video track swapped successfully!');
                                        uiLog('✅ Video stream swapped to real doorbell camera!', 'success');
                                    })
                                    .catch(err => {
                                        console.error('❌ Video track swap failed:', err);
                                        uiLog(`❌ Video track swap failed: ${err.message}`, 'error');
                                    });
                            }
                            if (audioSender && netatmoAudioTrack) {
                                console.log('🔄 Swapping in real Audio track');
                                audioSender.replaceTrack(netatmoAudioTrack)
                                    .then(() => {
                                        console.log('✅ Audio track swapped successfully!');
                                        uiLog('✅ Audio stream swapped to real doorbell microphone!', 'success');
                                    })
                                    .catch(err => {
                                        console.error('❌ Audio track swap failed:', err);
                                        uiLog(`❌ Audio track swap failed: ${err.message}`, 'error');
                                    });
                            }
                            
                            // Stop placeholder canvas drawing to save resources
                            if (canvasInterval) {
                                clearInterval(canvasInterval);
                                canvasInterval = null;
                            }
                        }
                    }
                } catch (err) {
                    console.warn('Error in media flow check:', err.message);
                }
            }, 500);
        }

        pc.ontrack = (e) => {
            const track = e.track;
            console.log(`🎥 TRACK ARRIVED: ${track.kind} (${track.label})`);
            arrivedTracks.push(track);
            
            const stream = e.streams[0] || new MediaStream([track]);
            const videoEl = document.getElementById('remoteVideo');
            if (videoEl && videoEl.srcObject !== stream) {
                console.log('📺 Binding remote WebRTC stream to video element');
                videoEl.srcObject = stream;
            }

            if (trackTimeout) clearTimeout(trackTimeout);

            const hasAudio = arrivedTracks.some(t => t.kind === 'audio');
            const hasVideo = arrivedTracks.some(t => t.kind === 'video');

            if (hasAudio && hasVideo) {
                startMediaFlowCheck();
            } else {
                // Wait up to 1.5 seconds for the other track to arrive before checking packets
                trackTimeout = setTimeout(() => {
                    startMediaFlowCheck();
                }, 1500);
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
        // ... (same as before)
        const lines = sdp.split('\r\n');
        let ufrag, pwd, fingerprint;

        for (const line of lines) {
            if (line.startsWith('a=ice-ufrag:')) ufrag = line.split(':')[1];
            if (line.startsWith('a=ice-pwd:')) pwd = line.split(':')[1];
            if (line.startsWith('a=fingerprint:sha-256 ')) fingerprint = line.split(' ')[1];
        }

        return [
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
    }

    // --- MediaMTX Forwarding (WHIP) ---
    async function forwardToMediaMTX(stream) {
        const logStart = `🚀 forwardToMediaMTX started with tracks: ${stream.getTracks().map(t => t.kind).join(', ')}`;
        console.log(logStart);
        uiLog(logStart, 'info');
        updateStatus('Pushing to MediaMTX via WHIP...');
        
        whipPc = new RTCPeerConnection();
        
        whipPc.onicecandidate = (e) => {
            if (e.candidate) {
                const logCand = `📦 WHIP ICE Candidate: ${e.candidate.candidate}`;
                console.log(logCand);
                uiLog(logCand, 'info');
            }
        };
        whipPc.onconnectionstatechange = () => {
            const state = whipPc.connectionState;
            const logState = `🌐 WHIP Connection State: ${state}`;
            console.log(logState);
            uiLog(logState, state === 'failed' ? 'error' : state === 'connected' ? 'success' : 'warning');
            
            const el = document.getElementById('whipState');
            if (el) el.innerText = state;
            if (state === 'connected') {
                updateStatus('Streaming Active', 'success');
            } else if (state === 'failed' || state === 'disconnected') {
                updateStatus('Streaming Failed/Disconnected', 'error');
            }
        };

        const tracksText = stream.getTracks().map(t => t.kind).join(' + ');
        const tracksEl = document.getElementById('whipTracks');
        if (tracksEl) tracksEl.innerText = tracksText;

        stream.getTracks().forEach(track => {
            console.log('➕ Adding track to WHIP:', track.kind);
            const sender = whipPc.addTrack(track, stream);
            if (track.kind === 'video') videoSender = sender;
            if (track.kind === 'audio') audioSender = sender;
        });

        // Force H264 for WHIP on the video transceiver
        try {
            const transceivers = whipPc.getTransceivers();
            const videoTransceiver = transceivers.find(t => t.sender.track?.kind === 'video');
            if (videoTransceiver && typeof RTCRtpSender.getCapabilities === 'function') {
                const codecs = RTCRtpSender.getCapabilities('video').codecs;
                const logCodecs = `Available Video Codecs: ${codecs.map(c => c.mimeType).join(', ')}`;
                console.log(logCodecs);
                uiLog(logCodecs, 'info');
                
                const h264Codecs = codecs.filter(c => c.mimeType && c.mimeType.toLowerCase() === 'video/h264');
                const forcedEl = document.getElementById('h264Forced');
                if (h264Codecs.length > 0) {
                    const logForce = '✅ Forcing H264 for WHIP';
                    console.log(logForce);
                    uiLog(logForce, 'success');
                    if (forcedEl) forcedEl.innerText = 'yes (forced)';
                    videoTransceiver.setCodecPreferences(h264Codecs);
                } else {
                    const logWarn = '⚠️ H264 codec NOT supported by this browser!';
                    console.warn(logWarn);
                    uiLog(logWarn, 'warning');
                    if (forcedEl) forcedEl.innerText = 'no (not supported)';
                }
            }
        } catch (codecErr) {
            console.warn('⚠️ Failed to set codec preferences:', codecErr.message);
        }

        const offer = await whipPc.createOffer();
        await whipPc.setLocalDescription(offer);
        console.log('📤 WHIP Offer created. SDP:\n', offer.sdp);

        try {
            const logSend = '📡 Sending WHIP POST to http://localhost:8889/doorbell/whip';
            console.log(logSend);
            uiLog(logSend, 'info');
            const response = await fetch('http://localhost:8889/doorbell/whip', {
                method: 'POST',
                body: whipPc.localDescription.sdp,
                headers: { 'Content-Type': 'application/sdp' }
            });
            const logResp = `📥 WHIP Response status: ${response.status}`;
            console.log(logResp);
            uiLog(logResp, 'info');
            if (response.ok) {
                const answerSdp = await response.text();
                await whipPc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
                const logSet = '✅ WHIP Answer set';
                console.log(logSet);
                uiLog(logSet, 'success');
                updateStatus('✅ RELAY ACTIVE: rtsp://localhost:8554/doorbell', 'success');
            } else {
                const errText = await response.text();
                const logFail = `❌ WHIP push failed: ${response.statusText} ${errText}`;
                console.error(logFail);
                uiLog(logFail, 'error');
                updateStatus('WHIP push failed: ' + response.statusText, 'error');
            }
        } catch (err) {
            const logErr = `❌ WHIP Fetch Error: ${err.message}`;
            console.error(logErr);
            uiLog(logErr, 'error');
            updateStatus('WHIP Error: ' + err.message, 'error');
        }
    }
}

window.onload = startRelay;
