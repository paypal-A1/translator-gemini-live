require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const twilio = require('twilio');

const app = express();
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 10000;
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

let activeCallSid = null;
let callStartTime = null;

// TABLAS DE CONVERSIÓN AUDIO (INTACTAS)
const ulawToPcmTable = new Int16Array(256);
const BIAS = 0x84;

function initAudioTables() {
    for (let i = 0; i < 256; i++) {
        let ulaw = ~i;
        let sign = ulaw & 0x80;
        let exponent = (ulaw >> 4) & 0x07;
        let mantissa = ulaw & 0x0F;
        let sample = ((mantissa << 3) + BIAS) << exponent;
        sample -= BIAS;
        ulawToPcmTable[i] = sign ? -sample : sample;
    }
}
initAudioTables();

function encodeMuLawSample(pcm) {
    let sign = (pcm & 0x8000) >> 8;
    if (pcm < 0) { pcm = -pcm; pcm -= 1; }
    if (pcm > 32635) pcm = 32635;
    pcm += BIAS;
    let exponent = 7;
    for (let mask = 0x4000; (pcm & mask) == 0 && exponent > 0; mask >>= 1) { exponent--; }
    let mantissa = (pcm >> (exponent + 3)) & 0x0F;
    return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

// Conversor: Twilio/Navegador (8kHz µ-law) -> Gemini (16kHz PCM16)
function twilioToGemini(ulawBuffer) {
    const outBuffer = Buffer.alloc(ulawBuffer.length * 4);
    let outIdx = 0;
    for (let i = 0; i < ulawBuffer.length; i++) {
        const pcmSample = ulawToPcmTable[ulawBuffer[i]];
        outBuffer.writeInt16LE(pcmSample, outIdx);
        outIdx += 2;
        outBuffer.writeInt16LE(pcmSample, outIdx);
        outIdx += 2;
    }
    return outBuffer.toString('base64');
}

// Conversor: Gemini (24kHz PCM16) -> Twilio/Navegador (8kHz µ-law)
function geminiToTwilio(pcmBase64) {
    const inBuffer = Buffer.from(pcmBase64, 'base64');
    const outBuffer = Buffer.alloc(Math.floor(inBuffer.length / 6));
    let outIdx = 0;
    for (let i = 0; i < inBuffer.length; i += 6) {
        if (i + 1 < inBuffer.length) {
            const pcmSample = inBuffer.readInt16LE(i);
            outBuffer[outIdx++] = encodeMuLawSample(pcmSample);
        }
    }
    return outBuffer.toString('base64');
}

app.post('/twiml', (req, res) => {
    res.type('text/xml');
    res.send(`
        <Response>
            <Connect>
                <Stream url="wss://${req.headers.host}/media-stream" />
            </Connect>
        </Response>
    `);
});

// ==================== GESTIÓN DE CONVERSACIÓN (CORREGIDA) ====================
let conversacionTemporal = [];
let textoInglesAcumulado = '';   // Traducción al inglés (de español)
let textoEspanolAcumulado = '';  // Traducción al español (de inglés)

function guardarTexto(tipo, texto) {
    if (!texto || texto.trim().length === 0) return;
    console.log(`📝 [GUARDAR] ${tipo}: "${texto.trim()}"`);
    conversacionTemporal.push({
        timestamp: new Date().toISOString(),
        tipo: tipo,
        texto: texto.trim()
    });
}

function finalizarConversacion() {
    // Guardar todo el texto acumulado, sin depender de puntuación ni turnComplete
    if (textoInglesAcumulado.trim()) {
        guardarTexto('tu', textoInglesAcumulado.trim());
        textoInglesAcumulado = '';
    }
    if (textoEspanolAcumulado.trim()) {
        guardarTexto('proveedor', textoEspanolAcumulado.trim());
        textoEspanolAcumulado = '';
    }
    console.log(`📊 [CONVERSACIÓN] Finalizada. Total fragmentos: ${conversacionTemporal.length}`);
}

app.get('/descargar-conversacion', (req, res) => {
    finalizarConversacion(); // Asegura que se guarde todo antes de descargar

    if (conversacionTemporal.length === 0) {
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', 'attachment; filename="conversacion_vacia.txt"');
        return res.send("No hay conversación registrada.");
    }

    let contenido = '';
    for (const linea of conversacionTemporal) {
        const hora = new Date(linea.timestamp).toLocaleTimeString([], { hour: '2-digit', minute:'2-digit', second:'2-digit' });
        if (linea.tipo === 'tu') {
            contenido += `[${hora}] Tú (Inglés): ${linea.texto}\n`;
        } else if (linea.tipo === 'proveedor') {
            contenido += `[${hora}] Proveedor (Español): ${linea.texto}\n`;
        }
    }

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="conversacion.txt"');
    res.send(contenido);

    // Limpiar después de descargar
    conversacionTemporal = [];
    textoInglesAcumulado = '';
    textoEspanolAcumulado = '';
});

app.post('/make-call', async (req, res) => {
    const { toPhoneNumber } = req.body;
    try {
        const call = await client.calls.create({
            url: `https://${req.headers.host}/twiml`,
            to: toPhoneNumber,
            from: process.env.TWILIO_NUMBER || '+18633445321'
        });
        activeCallSid = call.sid;
        callStartTime = Date.now();

        // Reiniciar conversación
        conversacionTemporal = [];
        textoInglesAcumulado = '';
        textoEspanolAcumulado = '';

        res.status(200).json({ success: true, callSid: call.sid });
    } catch (error) {
        console.error('Error al realizar la llamada:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/hangup', async (req, res) => {
    try {
        if (activeCallSid) {
            await client.calls(activeCallSid).update({ status: 'completed' });
            finalizarConversacion(); // Guarda el texto acumulado

            if (geminiWsToEnglish && geminiWsToEnglish.readyState === WebSocket.OPEN) {
                geminiWsToEnglish.close();
                geminiWsToEnglish = null;
                console.log('✅ Sesión Gemini [Inglés] cerrada');
            }
            if (geminiWsToSpanish && geminiWsToSpanish.readyState === WebSocket.OPEN) {
                geminiWsToSpanish.close();
                geminiWsToSpanish = null;
                console.log('✅ Sesión Gemini [Español] cerrada');
            }

            const duracion = callStartTime ? ((Date.now() - callStartTime) / 1000).toFixed(1) : 'desconocida';
            console.log(`📊 [LLAMADA] Finalizada. Duración: ${duracion}s`);

            browserConnections.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'call_duration', duration: duracion }));
                }
            });
            activeCallSid = null;
            callStartTime = null;
            res.status(200).json({ success: true });
        } else {
            res.status(400).json({ success: false, error: "No hay llamada activa" });
        }
    } catch (error) {
        console.error('Error al colgar:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const server = app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
const wss = new WebSocket.Server({ server });

let geminiWsToEnglish = null;
let geminiWsToSpanish = null;
let twilioWs = null;
let twilioStreamSid = null;
let twilioPacketsIn = 0;

const browserConnections = new Set();

function broadcastToBrowsers(audioData) {
    const toRemove = [];
    browserConnections.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'audio', payload: audioData }));
        } else {
            toRemove.push(ws);
        }
    });
    toRemove.forEach(ws => browserConnections.delete(ws));
}

// ==================== CANAL 1: Español -> Inglés (INTACTO) ====================
function initGeminiToEnglish() {
    if (geminiWsToEnglish && geminiWsToEnglish.readyState === WebSocket.OPEN) return;
    console.log('🔌 Conectando a Gemini [Canal Español ➡️ Inglés]... 🇺🇸');

    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;
    geminiWsToEnglish = new WebSocket(url);

    geminiWsToEnglish.on('open', () => {
        console.log('✅ Gemini [Inglés] conectado.');
        const setupMessage = {
            setup: {
                model: "models/gemini-3.5-live-translate-preview",
                generationConfig: {
                    responseModalities: ["TEXT", "AUDIO"],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }
                    }
                },
                systemInstruction: {
                    parts: [{ text: "You are a real-time bidirectional translator. Translate everything the user says from Spanish into fluent English. Provide both the literal text translation and the spoken audio translation. Do not add any extra explanations or text commentary outside of the literal translation." }]
                }
            }
        };
        geminiWsToEnglish.send(JSON.stringify(setupMessage));
    });

    geminiWsToEnglish.on('message', (message) => {
        try {
            const response = JSON.parse(message);

            if (response.serverContent && response.serverContent.modelTurn) {
                const parts = response.serverContent.modelTurn.parts;
                for (const part of parts) {
                    // 📝 Acumular texto (sin depender de turnComplete)
                    if (part.text) {
                        textoInglesAcumulado += part.text + ' ';
                        console.log(`🇺🇸 [Texto parcial] ${part.text}`);
                    }

                    // 🔊 Audio
                    if (part.inlineData && part.inlineData.data) {
                        if (twilioWs && twilioWs.readyState === WebSocket.OPEN && twilioStreamSid) {
                            const convertedAudio = geminiToTwilio(part.inlineData.data);
                            twilioWs.send(JSON.stringify({
                                event: "media",
                                streamSid: twilioStreamSid,
                                media: { payload: convertedAudio }
                            }));
                            console.log('🔊 [AUDIO -> TWILIO] Enviado');
                        }
                    }
                }
            }
            // 🔥 Ya no dependemos de turnComplete
        } catch (e) {
            console.error("Error en Canal Inglés:", e);
        }
    });

    geminiWsToEnglish.on('close', () => {
        geminiWsToEnglish = null;
        console.log('🔌 Desconectado Gemini [Inglés]');
    });
    geminiWsToEnglish.on('error', (err) => console.error('Error Canal Inglés:', err));
}

// ==================== CANAL 2: Inglés -> Español (INTACTO) ====================
function initGeminiToSpanish() {
    if (geminiWsToSpanish && geminiWsToSpanish.readyState === WebSocket.OPEN) return;
    console.log('🔌 Conectando a Gemini [Canal Inglés ➡️ Español]... 🇪🇸');

    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;
    geminiWsToSpanish = new WebSocket(url);

    geminiWsToSpanish.on('open', () => {
        console.log('✅ Gemini [Español] conectado.');
        const setupMessage = {
            setup: {
                model: "models/gemini-3.5-live-translate-preview",
                generationConfig: {
                    responseModalities: ["TEXT", "AUDIO"],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }
                    }
                },
                systemInstruction: {
                    parts: [{ text: "You are a real-time bidirectional translator. Translate everything the user says from English into fluent Spanish. Provide both the literal text translation and the spoken audio translation. Do not add any extra explanations or text commentary outside of the literal translation." }]
                }
            }
        };
        geminiWsToSpanish.send(JSON.stringify(setupMessage));
    });

    geminiWsToSpanish.on('message', (message) => {
        try {
            const response = JSON.parse(message);

            if (response.serverContent && response.serverContent.modelTurn) {
                const parts = response.serverContent.modelTurn.parts;
                for (const part of parts) {
                    // 📝 Acumular texto
                    if (part.text) {
                        textoEspanolAcumulado += part.text + ' ';
                        console.log(`🇪🇸 [Texto parcial] ${part.text}`);
                    }

                    // 🔊 Audio
                    if (part.inlineData && part.inlineData.data) {
                        const convertedAudio = geminiToTwilio(part.inlineData.data);
                        broadcastToBrowsers(convertedAudio);
                        console.log('🔊 [AUDIO -> NAVEGADOR] Enviado');
                    }
                }
            }
        } catch (e) {
            console.error("Error en Canal Español:", e);
        }
    });

    geminiWsToSpanish.on('close', () => {
        geminiWsToSpanish = null;
        console.log('🔌 Desconectado Gemini [Español]');
    });
    geminiWsToSpanish.on('error', (err) => console.error('Error Canal Español:', err));
}

// ==================== WEBSOCKETS DEL SERVIDOR (INTACTO) ====================
wss.on('connection', (ws, req) => {
    const urlClara = new URL(req.url, `http://${req.headers.host}`);
    const pathname = urlClara.pathname;

    if (pathname === '/browser-stream') {
        console.log('🖥️ Navegador conectado. Conexiones activas:', browserConnections.size + 1);
        browserConnections.add(ws);

        const keepAliveInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ping' }));
            } else {
                clearInterval(keepAliveInterval);
            }
        }, 10000);

        initGeminiToEnglish();

        ws.on('message', (message) => {
            if (geminiWsToEnglish && geminiWsToEnglish.readyState === WebSocket.OPEN) {
                try {
                    const base64Str = message.toString();
                    const ulawBuffer = Buffer.from(base64Str, 'base64');
                    const convertedAudio = twilioToGemini(ulawBuffer);

                    geminiWsToEnglish.send(JSON.stringify({
                        realtimeInput: {
                            mediaChunks: [
                                {
                                    mimeType: "audio/pcm",
                                    data: convertedAudio
                                }
                            ]
                        }
                    }));
                } catch (err) {
                    console.error("Error al procesar audio del navegador:", err);
                }
            }
        });

        ws.on('close', () => {
            browserConnections.delete(ws);
            clearInterval(keepAliveInterval);
            console.log('🔌 Navegador desconectado. Conexiones restantes:', browserConnections.size);
        });

        ws.on('error', (err) => {
            console.error('Error en WebSocket del navegador:', err.message);
            browserConnections.delete(ws);
            clearInterval(keepAliveInterval);
        });
    } 
    else if (pathname === '/media-stream') {
        console.log('📞 Twilio conectado.');
        twilioWs = ws;

        initGeminiToSpanish();

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                if (data.event === 'start') {
                    twilioStreamSid = data.start.streamSid;
                    console.log(`📞 StreamSid de Twilio: ${twilioStreamSid}`);

                    browserConnections.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({ type: 'twilio_ready' }));
                        }
                    });
                }

                if (data.event === 'media') {
                    twilioPacketsIn++;
                    if (twilioPacketsIn % 100 === 0) {
                        console.log(`📥 [DIAGNÓSTICO] Paquetes de Twilio procesados: ${twilioPacketsIn}`);
                    }

                    if (geminiWsToSpanish && geminiWsToSpanish.readyState === WebSocket.OPEN) {
                        const convertedAudio = twilioToGemini(Buffer.from(data.media.payload, 'base64'));
                        geminiWsToSpanish.send(JSON.stringify({
                            realtimeInput: {
                                mediaChunks: [
                                    {
                                        mimeType: "audio/pcm",
                                        data: convertedAudio
                                    }
                                ]
                            }
                        }));
                    }
                }
            } catch (err) {
                console.error("Error en flujo Twilio:", err);
            }
        });

        ws.on('close', () => {
            twilioWs = null;
            twilioStreamSid = null;
            console.log('🔌 Twilio desconectado');
        });
    }
});
