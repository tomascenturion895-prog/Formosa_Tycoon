import { ownerColor } from './owners.js';
import {
    shouldOffer, peersFrom, cleanSignal, speakingStep, rmsLevel, micButton, statusText, micErrorText, iceServersFrom, retryDelay,
} from './voice-model.js';

const CONNECT_TIMEOUT_MS = 15000; // una llamada que no se armó en este tiempo se rehace
const SEND_GAP_MS = 35;           // separación entre mensajes de conexión (varios jugadores a la vez no saturan el canal)
const LEVEL_EVERY_MS = 120;

/**
 * Voz de la sala, de jugador a jugador (WebRTC). El servidor NO recibe el audio: el canal de presencia `partida.{id}.voz` solo sirve
 * para saber quién está y para que los navegadores se pasen los datos de conexión.
 *
 * Reglas:
 *  - Entrás a escuchar solo, al estar en una sala. El micrófono arranca CERRADO y no se pide permiso hasta que lo abrís.
 *  - Cerrar el micrófono lo apaga de verdad (se suelta el dispositivo): no queda el aviso de "grabando" del navegador.
 *  - En cada par de jugadores llama el de número menor; si la conexión no se arma o se cae, vuelve a llamar (con espera creciente).
 *  - Cada jugador puede silenciar a otro (solo para sí) o dejar de oír a todos.
 *  - Si algo falla (sin permiso, sin micrófono, sin conexión), el juego sigue igual: solo se avisa en el panel de voz.
 */
export function createVoice({ user, $, cfg = {}, getRt }) {
    const root = $('voice');
    const micBtn = $('voice-mic');
    const deafBtn = $('voice-deaf');
    const toggleBtn = $('voice-toggle');
    const statusEl = $('voice-status');
    const listEl = $('voice-list');
    const noteEl = $('voice-note');
    const micLabel = $('voice-mic-label');

    const supported = !!(root && user && cfg.enabled && typeof RTCPeerConnection !== 'undefined');
    if (!supported) {
        if (root) {
            root.hidden = true;
        }

        return { sync() {}, active: () => false, mic: () => 'off' };
    }

    const iceServers = iceServersFrom(cfg.iceServers);
    const maxPeers = Number(cfg.maxPeers) > 0 ? Number(cfg.maxPeers) : 7;
    const me = Number(user.id);

    let matchId = null;
    let live = false;
    let mic = 'off';          // 'off' | 'asking' | 'on'
    let stream = null;
    let track = null;
    let deaf = false;
    let needsTap = false;
    let audioCtx = null;
    let levelTimer = null;
    let sendTimer = null;
    const outbox = [];
    const peers = new Map();  // id -> entrada de cada compañero
    const self = { speaking: { on: false, lastLoud: 0 }, analyser: null, source: null };

    // ------------------------------------------------------------------ pantalla

    function setNote(text) {
        if (!noteEl) {
            return;
        }
        noteEl.textContent = text || '';
        noteEl.hidden = !text;
    }

    function render() {
        const b = micButton(mic, { connected: live, peers: peers.size });
        micBtn.setAttribute('aria-pressed', String(b.pressed));
        micBtn.disabled = b.disabled;
        micBtn.title = b.title;
        micBtn.classList.toggle('on', mic === 'on');
        micLabel.textContent = b.label;
        deafBtn.setAttribute('aria-pressed', String(deaf));
        deafBtn.title = deaf ? 'Volver a oír a los demás' : 'Dejar de oír a los demás';
        statusEl.textContent = statusText({ live, peers: peers.size, mic, deaf });
        root.classList.toggle('is-live', live);
        renderList();
    }

    function renderList() {
        listEl.textContent = '';
        const rows = [{ id: me, name: `${user.name} (vos)`, self: true }, ...[...peers.values()].sort((a, b) => a.id - b.id)];
        for (const p of rows) {
            const li = document.createElement('li');
            li.className = 'voice-row';
            li.dataset.id = String(p.id);
            li.classList.toggle('me', !!p.self);
            const dot = document.createElement('span');
            dot.className = 'voice-dot';
            dot.style.background = ownerColor(p.id); // el mismo color del jugador que en las posiciones
            dot.setAttribute('aria-hidden', 'true');
            const name = document.createElement('span');
            name.className = 'voice-name';
            name.textContent = p.name;
            li.append(dot, name);
            if (p.self) {
                const st = document.createElement('span');
                st.className = 'voice-state';
                st.textContent = mic === 'on' ? 'micrófono abierto' : 'en silencio';
                li.append(st);
                li.classList.toggle('talking', self.speaking.on);
            } else {
                const st = document.createElement('span');
                st.className = 'voice-state';
                st.textContent = p.state === 'connected' ? '' : (p.state === 'failed' ? 'sin conexión' : 'conectando…');
                const mute = document.createElement('button');
                mute.type = 'button';
                mute.className = 'voice-peer-mute';
                mute.setAttribute('aria-pressed', String(p.muted));
                mute.textContent = p.muted ? 'Silenciado' : 'Silenciar';
                mute.title = p.muted ? `Volver a oír a ${p.name}` : `No oír a ${p.name} (solo para vos)`;
                mute.addEventListener('click', () => {
                    p.muted = !p.muted;
                    applyVolume(p);
                    renderList();
                });
                li.append(st, mute);
                li.classList.toggle('talking', p.speaking.on && !p.muted && !deaf);
            }
            listEl.append(li);
        }
    }

    function paintTalking() {
        for (const li of listEl.children) {
            const id = Number(li.dataset.id);
            const on = id === me ? self.speaking.on : (() => {
                const p = peers.get(id);

                return !!p && p.speaking.on && !p.muted && !deaf;
            })();
            li.classList.toggle('talking', on);
        }
        root.classList.toggle('talking', self.speaking.on);
    }

    // ------------------------------------------------------------------ envío de mensajes de conexión

    function send(msg) {
        outbox.push({ from: me, ...msg });
        if (!sendTimer) {
            sendTimer = setTimeout(drain, 0);
        }
    }

    function drain() {
        sendTimer = null;
        const item = outbox.shift();
        if (!item) {
            return;
        }
        try {
            getRt()?.whisperVoice(item);
        } catch (e) {
            console.warn('No se pudo enviar el mensaje de voz', e);
        }
        if (outbox.length) {
            sendTimer = setTimeout(drain, SEND_GAP_MS);
        }
    }

    // ------------------------------------------------------------------ audio

    function context() {
        if (!audioCtx) {
            try {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            } catch {
                audioCtx = false;
            }
        }
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => {});
        }

        return audioCtx || null;
    }

    function analyse(mediaStream) {
        const ctx = context();
        if (!ctx) {
            return null;
        }
        try {
            const source = ctx.createMediaStreamSource(mediaStream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            source.connect(analyser); // no se conecta a los parlantes: solo se mide
            return { source, analyser, buf: new Uint8Array(analyser.fftSize) };
        } catch {
            return null;
        }
    }

    function startLevels() {
        if (levelTimer) {
            return;
        }
        levelTimer = setInterval(() => {
            const now = performance.now();
            let changed = false;
            const measure = (a, st) => {
                if (!a) {
                    return st;
                }
                a.analyser.getByteTimeDomainData(a.buf);
                const next = speakingStep(st, rmsLevel(a.buf), now);
                if (next.on !== st.on) {
                    changed = true;
                }

                return next;
            };
            self.speaking = measure(self.meter, self.speaking);
            for (const p of peers.values()) {
                p.speaking = measure(p.meter, p.speaking);
            }
            if (changed) {
                paintTalking();
            }
        }, LEVEL_EVERY_MS);
    }

    function stopLevels() {
        clearInterval(levelTimer);
        levelTimer = null;
    }

    function applyVolume(p) {
        if (p.audio) {
            p.audio.muted = deaf || p.muted;
        }
        paintTalking();
    }

    function playAll() {
        for (const p of peers.values()) {
            p.audio?.play().then(() => { needsTap = false; setNote(''); }).catch(() => {});
        }
    }

    function attachRemote(p, remote) {
        if (p.audio) {
            p.audio.srcObject = null;
        }
        const audio = new Audio();
        audio.autoplay = true;
        audio.playsInline = true;
        audio.srcObject = remote;
        p.audio = audio;
        p.meter = analyse(remote);
        applyVolume(p);
        audio.play().catch(() => {
            needsTap = true; // el navegador exige un toque antes de reproducir sonido
            setNote('Tocá cualquier parte de la pantalla para activar el sonido de la voz.');
        });
    }

    // ------------------------------------------------------------------ conexiones

    function newEntry(info) {
        return {
            id: info.id, name: info.name, pc: null, sid: '', sender: null, audio: null, meter: null, muted: false,
            speaking: { on: false, lastLoud: 0 }, state: 'connecting', pendingIce: [], attempts: 0, timer: null, remoteSet: false,
        };
    }

    function clearTimer(p) {
        clearTimeout(p.timer);
        p.timer = null;
    }

    function dropPc(p) {
        clearTimer(p);
        if (p.pc) {
            p.pc.onicecandidate = null;
            p.pc.ontrack = null;
            p.pc.onconnectionstatechange = null;
            try {
                p.pc.close();
            } catch { /* ya cerrada */ }
        }
        p.pc = null;
        p.sender = null;
        p.remoteSet = false;
        p.pendingIce = [];
        if (p.audio) {
            p.audio.srcObject = null;
            p.audio = null;
        }
        p.meter = null;
        p.speaking = { on: false, lastLoud: 0 };
    }

    function buildPc(p) {
        const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
        p.pc = pc;
        const sid = p.sid;
        pc.onicecandidate = (e) => {
            if (p.sid === sid) {
                send({ to: p.id, kind: 'ice', sid, candidate: e.candidate ? e.candidate.toJSON() : null });
            }
        };
        pc.ontrack = (e) => attachRemote(p, e.streams[0] ?? new MediaStream([e.track]));
        pc.onconnectionstatechange = () => {
            if (p.pc !== pc) {
                return;
            }
            const s = pc.connectionState;
            if (s === 'connected') {
                clearTimer(p);
                p.attempts = 0;
                p.state = 'connected';
                renderList();
            } else if (s === 'failed' || s === 'closed') {
                p.state = 'failed';
                renderList();
                scheduleRetry(p);
            } else if (s === 'disconnected') {
                clearTimer(p);
                p.timer = setTimeout(() => {
                    if (p.pc === pc && pc.connectionState !== 'connected') {
                        p.state = 'failed';
                        renderList();
                        scheduleRetry(p);
                    }
                }, 5000);
            }
        };

        return pc;
    }

    function attachMic(p) {
        if (p.sender && track) {
            p.sender.replaceTrack(track).catch(() => {});
        }
    }

    /** Solo el de número menor llama; el otro espera la llamada (y la vuelve a esperar si la conexión se rehace). */
    function scheduleRetry(p) {
        clearTimer(p);
        if (!peers.has(p.id) || !shouldOffer(me, p.id)) {
            return;
        }
        const wait = retryDelay(p.attempts++);
        p.timer = setTimeout(() => {
            if (peers.get(p.id) === p) {
                call(p);
            }
        }, wait);
    }

    async function call(p) {
        dropPc(p);
        p.state = 'connecting';
        p.sid = Math.random().toString(36).slice(2, 10);
        const pc = buildPc(p);
        try {
            const tr = pc.addTransceiver('audio', { direction: 'sendrecv' });
            p.sender = tr.sender;
            attachMic(p);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            send({ to: p.id, kind: 'offer', sid: p.sid, sdp: pc.localDescription.sdp });
            clearTimer(p);
            p.timer = setTimeout(() => { // si no se conecta, se rehace
                if (p.pc === pc && pc.connectionState !== 'connected') {
                    scheduleRetry(p);
                }
            }, CONNECT_TIMEOUT_MS);
        } catch (e) {
            console.warn('No se pudo iniciar la llamada de voz', e);
            p.state = 'failed';
            scheduleRetry(p);
        }
        renderList();
    }

    async function flushIce(p) {
        const queued = p.pendingIce;
        p.pendingIce = [];
        for (const c of queued) {
            try {
                await p.pc?.addIceCandidate(c);
            } catch { /* candidato viejo o repetido */ }
        }
    }

    async function onOffer(p, s) {
        dropPc(p);
        p.sid = s.sid;
        p.state = 'connecting';
        const pc = buildPc(p);
        try {
            await pc.setRemoteDescription({ type: 'offer', sdp: s.sdp });
            p.remoteSet = true;
            const tr = pc.getTransceivers().find((t) => t.receiver?.track?.kind === 'audio') ?? pc.getTransceivers()[0];
            if (tr) {
                tr.direction = 'sendrecv';
                p.sender = tr.sender;
                attachMic(p);
            }
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            send({ to: p.id, kind: 'answer', sid: p.sid, sdp: pc.localDescription.sdp });
            await flushIce(p);
            clearTimer(p);
            p.timer = setTimeout(() => {
                if (p.pc === pc && pc.connectionState !== 'connected') {
                    p.state = 'failed';
                    renderList();
                }
            }, CONNECT_TIMEOUT_MS);
        } catch (e) {
            console.warn('No se pudo responder la llamada de voz', e);
            p.state = 'failed';
        }
        renderList();
    }

    async function onAnswer(p, s) {
        if (!p.pc || s.sid !== p.sid || p.remoteSet) {
            return;
        }
        try {
            await p.pc.setRemoteDescription({ type: 'answer', sdp: s.sdp });
            p.remoteSet = true;
            await flushIce(p);
        } catch (e) {
            console.warn('Respuesta de voz inválida', e);
        }
    }

    async function onIce(p, s) {
        if (s.sid !== p.sid || !p.pc) {
            return;
        }
        const cand = s.candidate ?? null; // null = no hay más candidatos
        if (cand === null) {
            return;
        }
        if (!p.remoteSet) {
            p.pendingIce.push(cand);

            return;
        }
        try {
            await p.pc.addIceCandidate(cand);
        } catch { /* candidato viejo o repetido */ }
    }

    function onSignal(raw) {
        const s = cleanSignal(raw, me, new Set(peers.keys()));
        if (!s) {
            return;
        }
        const p = peers.get(s.from);
        if (!p) {
            return;
        }
        if (s.kind === 'offer') {
            if (shouldOffer(me, p.id)) {
                return; // el que llama soy yo: una oferta de ese jugador no corresponde
            }
            onOffer(p, s);
        } else if (s.kind === 'answer') {
            onAnswer(p, s);
        } else if (s.kind === 'ice') {
            onIce(p, s);
        } else if (s.kind === 'bye') {
            dropPc(p); // el otro cerró su llamada: se espera una nueva
            p.state = 'connecting';
            renderList();
        }
    }

    function addPeer(info) {
        if (!info || Number(info.id) === me || peers.size >= maxPeers && !peers.has(Number(info.id))) {
            return;
        }
        const id = Number(info.id);
        const existing = peers.get(id);
        if (existing) {
            existing.name = info.name || existing.name;
            if (shouldOffer(me, id) && (!existing.pc || existing.state === 'failed')) {
                call(existing);
            }

            return;
        }
        const p = newEntry({ id, name: String(info.name ?? '') });
        peers.set(id, p);
        startLevels();
        if (shouldOffer(me, id)) {
            call(p);
        }
        render();
    }

    function removePeer(id) {
        const p = peers.get(Number(id));
        if (!p) {
            return;
        }
        dropPc(p);
        peers.delete(p.id);
        if (peers.size === 0 && mic !== 'on') {
            stopLevels();
        }
        render();
    }

    // ------------------------------------------------------------------ micrófono

    async function openMic() {
        if (mic !== 'off') {
            return;
        }
        setNote('');
        if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
            setNote(micErrorText(null, false));

            return;
        }
        mic = 'asking';
        render();
        let got;
        try {
            got = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        } catch (e) {
            mic = 'off';
            setNote(micErrorText(e));
            render();

            return;
        }
        if (matchId == null) { // me fui de la sala mientras elegía
            got.getTracks().forEach((t) => t.stop());
            mic = 'off';
            render();

            return;
        }
        stream = got;
        track = got.getAudioTracks()[0] ?? null;
        if (!track) {
            closeMic();

            return;
        }
        track.addEventListener('ended', () => closeMic()); // se desconectó el dispositivo
        for (const p of peers.values()) {
            attachMic(p);
        }
        self.meter = analyse(stream);
        mic = 'on';
        startLevels();
        render();
    }

    function closeMic() {
        if (track) {
            track.stop();
        }
        stream?.getTracks().forEach((t) => t.stop());
        for (const p of peers.values()) {
            p.sender?.replaceTrack(null).catch(() => {});
        }
        try {
            self.meter?.source.disconnect();
        } catch { /* ya desconectado */ }
        stream = null;
        track = null;
        self.meter = null;
        self.speaking = { on: false, lastLoud: 0 };
        mic = 'off';
        if (peers.size === 0) {
            stopLevels();
        }
        paintTalking();
        render();
    }

    // ------------------------------------------------------------------ canal de la sala

    function teardown() {
        closeMic();
        for (const p of peers.values()) {
            dropPc(p);
        }
        peers.clear();
        stopLevels();
        outbox.length = 0;
        matchId = null;
        live = false;
        setNote('');
        root.hidden = true;
    }

    const handlers = {
        onHere: (list) => {
            live = true;
            const wanted = peersFrom(list, me, maxPeers);
            for (const id of [...peers.keys()]) {
                if (!wanted.some((w) => w.id === id)) {
                    removePeer(id);
                }
            }
            wanted.forEach(addPeer);
            render();
        },
        onJoin: (m) => addPeer(peersFrom([m], me, maxPeers)[0]),
        onLeave: (m) => removePeer(m?.id),
        onSignal,
        onLive: (v) => {
            live = !!v;
            if (!live) {
                for (const p of peers.values()) {
                    p.state = 'connecting';
                }
            }
            render();
        },
    };

    micBtn.addEventListener('click', () => (mic === 'on' ? closeMic() : openMic()));
    deafBtn.addEventListener('click', () => {
        deaf = !deaf;
        peers.forEach(applyVolume);
        context();
        playAll();
        render();
    });
    toggleBtn.addEventListener('click', () => {
        const open = toggleBtn.getAttribute('aria-expanded') !== 'true';
        toggleBtn.setAttribute('aria-expanded', String(open));
        listEl.hidden = !open;
        root.classList.toggle('open', open);
    });
    document.addEventListener('pointerdown', () => {
        if (matchId != null) {
            context();
            if (needsTap) {
                playAll();
            }
        }
    }, { passive: true });

    return {
        /** Se llama cada vez que cambia mi partida: `id` = la sala en espera o en juego, o null. */
        sync(id) {
            const next = id == null ? null : Number(id);
            if (next === matchId) {
                return;
            }
            const rt = getRt();
            if (matchId != null) {
                teardown();
                rt?.watchVoice(null, handlers);
            }
            if (next == null || !rt?.watchVoice) {
                return;
            }
            matchId = next;
            root.hidden = false;
            render();
            rt.watchVoice(next, handlers);
        },
        active: () => matchId != null,
        mic: () => mic,
    };
}
