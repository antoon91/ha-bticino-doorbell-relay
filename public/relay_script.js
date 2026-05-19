/**
 * Bticino WebRTC Relay Script (Headless)
 * EXACT LOGIC COPY of bticino_card.js v0.4.0
 */

const statusEl = document.getElementById('status');
const updateStatus = (msg) => {
    console.log(msg);
    statusEl.innerText = msg;
};

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
        
        // Match bticino_card.js local stream setup (falling back to oscillator for headless)
        let localStream;
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
            return;
        }

        pc = new RTCPeerConnection({
            iceServers: config.ice_servers,
            rtcpMuxPolicy: 'require',
            bundlePolicy: 'max-bundle',
            iceTransportPolicy: 'all'
        });

        localStream.getAudioTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
        pc.addTransceiver('video', { direction: 'recvonly' });

        let forwardingStarted = false;
        pc.ontrack = (e) => {
            const track = e.track;
            console.log(`🎥 TRACK ARRIVED: ${track.kind} (${track.label})`);
            
            // Log track stats periodically
            setInterval(() => {
                console.log(`📊 Track [${track.kind}] readyState: ${track.readyState}, enabled: ${track.enabled}, muted: ${track.muted}`);
            }, 5000);

            const stream = e.streams[0] || new MediaStream([track]);
            const videoEl = document.getElementById('remoteVideo');
            if (videoEl && videoEl.srcObject !== stream) {
                console.log('📺 Binding remote WebRTC stream to video element');
                videoEl.srcObject = stream;
            }

            if (!forwardingStarted) {
                forwardingStarted = true;
                forwardToMediaMTX(stream);
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
        console.log('🚀 forwardToMediaMTX started with tracks:', stream.getTracks().map(t => t.kind).join(', '));
        updateStatus('Pushing to MediaMTX via WHIP...');
        const whipPc = new RTCPeerConnection();
        
        whipPc.onicecandidate = (e) => {
            if (e.candidate) console.log('📦 WHIP ICE Candidate:', e.candidate.candidate);
        };
        whipPc.onconnectionstatechange = () => console.log('🌐 WHIP Connection State:', whipPc.connectionState);

        stream.getTracks().forEach(track => {
            console.log('➕ Adding track to WHIP:', track.kind);
            whipPc.addTrack(track, stream);
        });

        // Force H264 for WHIP on the video transceiver
        try {
            const transceivers = whipPc.getTransceivers();
            const videoTransceiver = transceivers.find(t => t.sender.track?.kind === 'video');
            if (videoTransceiver && typeof RTCRtpSender.getCapabilities === 'function') {
                const codecs = RTCRtpSender.getCapabilities('video').codecs;
                console.log('Available Video Codecs:', codecs.map(c => c.mimeType).join(', '));
                const h264Codecs = codecs.filter(c => c.mimeType === 'video/H264');
                if (h264Codecs.length > 0) {
                    console.log('✅ Forcing H264 for WHIP');
                    videoTransceiver.setCodecPreferences(h264Codecs);
                } else {
                    console.warn('⚠️ H264 codec NOT supported by this browser!');
                }
            }
        } catch (codecErr) {
            console.warn('⚠️ Failed to set codec preferences:', codecErr.message);
        }

        const offer = await whipPc.createOffer();
        await whipPc.setLocalDescription(offer);
        console.log('📤 WHIP Offer created. SDP:\n', offer.sdp);

        try {
            console.log('📡 Sending WHIP POST to http://localhost:8889/doorbell/whip');
            const response = await fetch('http://localhost:8889/doorbell/whip', {
                method: 'POST',
                body: whipPc.localDescription.sdp,
                headers: { 'Content-Type': 'application/sdp' }
            });
            console.log('📥 WHIP Response status:', response.status);
            if (response.ok) {
                const answerSdp = await response.text();
                await whipPc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
                console.log('✅ WHIP Answer set');
                updateStatus('✅ RELAY ACTIVE: rtsp://localhost:8554/doorbell');
            } else {
                const errText = await response.text();
                console.error('❌ WHIP push failed:', response.statusText, errText);
                updateStatus('WHIP push failed: ' + response.statusText);
            }
        } catch (err) {
            console.error('❌ WHIP Fetch Error:', err);
            updateStatus('WHIP Error: ' + err.message);
        }
    }
}

window.onload = startRelay;
