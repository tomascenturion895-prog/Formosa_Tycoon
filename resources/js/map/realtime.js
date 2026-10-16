import Echo from 'laravel-echo';
import Pusher from 'pusher-js';

window.Pusher = Pusher; // Echo lo busca en window

/**
 * Se conecta al servidor de tiempo real (Reverb). Canales públicos:
 *  - "map" (correcciones de datos) y "chat" (chat GLOBAL): siempre.
 *  - "partida.{id}": propiedades, subastas, jugadores, inicio y fin de MI partida (`watchMatch`).
 *  - "lobby": salas públicas abiertas, solo mientras está abierto el panel de salas (`watchLobby`).
 *  - "partida.{id}.voz": voz de MI sala. Canal de PRESENCIA (quién está) por donde los navegadores se pasan los datos para conectarse
 *    entre sí con WebRTC; el audio no pasa por el servidor. Usa mensajes entre clientes (`whisper`), que Reverb acepta solo de
 *    quien ya está dentro del canal (REVERB_APP_ACCEPT_CLIENT_EVENTS_FROM=members).
 *  - "partida.{id}.chat": chat de MI sala. Canal PRIVADO: Echo pide autorización a /broadcasting/auth (sesión + CSRF) y el
 *    servidor solo la da a quien juega esa partida. Si la rechaza o se cae, el chat lee la sala cada tanto (`onChatRoomLive`).
 * Si Reverb está apagado o no hay configuración, devuelve null y el mapa sigue funcionando (con lecturas periódicas).
 */
export function connectRealtime(conf, h) {
    if (!conf?.key) {
        return null;
    }

    const echo = new Echo({
        broadcaster: 'reverb',
        key: conf.key,
        wsHost: conf.host,
        wsPort: conf.port,
        wssPort: conf.port,
        forceTLS: conf.scheme === 'https',
        enabledTransports: ['ws', 'wss'],
    });

    // El punto inicial en ".PropertyOwnerChanged" evita que Echo le anteponga el namespace de PHP.
    // Las pantallas que no usan estos avisos (el lobby) no pasan el manejador y no se suscriben al canal.
    if (h.onCorrected) {
        echo.channel('map').listen('.PropertyCorrected', (e) => h.onCorrected(e));
    }

    if (h.onChat) {
        echo.channel('chat')
            .listen('.ChatMessageSent', (e) => h.onChat(e))
            .listen('.ChatMessageHidden', (e) => h.onChatHidden(e.id, null));
    }

    let wasDown = false;
    let voiceName = null;
    let voiceChannel = null;
    let voiceH = null;
    echo.connector.pusher.connection.bind('state_change', ({ current }) => {
        const live = current === 'connected';
        h.onStatus(live);
        if (!live) {
            voiceH?.onLive(false); // al volver, el canal de voz se suscribe de nuevo y `here` lo marca como conectado
        }
        if (live && wasDown) {
            h.onBack(); // se cayó y volvió: pudimos perder avisos, así que se vuelve a leer el estado completo
        }
        if (!live && current !== 'connecting' && current !== 'initialized') {
            wasDown = true;
        }
    });

    let matchChannel = null;
    let chatChannel = null;
    let lobbyOn = false;

    return {
        echo,
        /** Escucha una partida (o ninguna con null). */
        watchMatch(id) {
            const name = id == null ? null : `partida.${id}`;
            if (name === matchChannel) {
                return;
            }
            if (matchChannel) {
                echo.leave(matchChannel);
            }
            matchChannel = name;
            if (name) {
                echo.channel(name)
                    .listen('.PropertyOwnerChanged', (e) => h.onOwner(e))
                    .listen('.AuctionUpdated', (e) => h.onAuction(e))
                    .listen('.ActivityFeed', (e) => h.onActivity?.(e))
                    .listen('.OfferUpdated', (e) => h.onOffer?.(e))
                    .listen('.MatchPlayersChanged', (e) => h.onPlayers(e))
                    .listen('.MatchStarted', (e) => h.onStarted(e))
                    .listen('.MatchFinished', (e) => h.onFinished(e));
            }
        },
        /** Escucha el chat de una sala (o ninguna con null). Solo con sesión: un visitante no tiene sala. */
        watchChat(id) {
            const name = id == null ? null : `partida.${id}.chat`;
            if (name === chatChannel) {
                return;
            }
            if (chatChannel) {
                echo.leave(chatChannel); // Echo agrega "private-" por su cuenta al salir de un canal privado
                h.onChatRoomLive?.(false);
            }
            chatChannel = name;
            if (name) {
                echo.private(name)
                    .subscribed(() => h.onChatRoomLive?.(true))
                    .error(() => h.onChatRoomLive?.(false)) // autorización rechazada: se lee por consulta
                    .listen('.ChatMessageSent', (e) => h.onChat(e))
                    .listen('.ChatMessageHidden', (e) => h.onChatHidden(e.id, e.match_id ?? null));
            }
        },
        /** Voz de una sala (o ninguna con null). `v` = { onHere, onJoin, onLeave, onSignal, onLive }. */
        watchVoice(id, v) {
            const name = id == null ? null : `partida.${id}.voz`;
            if (name === voiceName) {
                return;
            }
            if (voiceName) {
                echo.leave(voiceName);
                voiceChannel = null;
            }
            voiceName = name;
            voiceH = name ? v : null;
            if (name) {
                voiceChannel = echo.join(name)
                    .here((list) => v.onHere(list))
                    .joining((m) => v.onJoin(m))
                    .leaving((m) => v.onLeave(m))
                    .error(() => v.onLive(false))
                    .listenForWhisper('signal', (msg) => v.onSignal(msg));
            }
        },
        /** Manda un mensaje de conexión a los demás de la voz de mi sala (cada uno se queda con los suyos). */
        whisperVoice(msg) {
            voiceChannel?.whisper('signal', msg);
        },
        watchLobby(on) {
            if (on === lobbyOn) {
                return;
            }
            lobbyOn = on;
            if (on) {
                echo.channel('lobby').listen('.LobbyChanged', (e) => h.onLobby(e));
            } else {
                echo.leave('lobby');
            }
        },
    };
}
