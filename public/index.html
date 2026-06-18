require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const twilio = require('twilio');
const { GoogleGenerativeAI } = require('@google/generative-ai'); // 👈 NUEVO

const app = express();
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 10000;
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ==================== CLIENTE GEMINI PARA TRANSCRIPCIÓN ====================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const transcriptionModel = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });

let activeCallSid = null;
let callStartTime = null;

// Conversión de audio (igual que siempre)
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

// Convierte µ-law (8kHz) a PCM (16kHz) duplicando muestras
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
    return outBuffer;
}

// Convierte PCM (24kHz) a µ-law (8kHz) para Twilio
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
    return outBuffer;
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

// ==================== GESTIÓN DE CONVERSACIÓN ====================
let conversacionTemporal = [];
let audioBufferPCM = Buffer.alloc(0); // 👈 NUEVO: buffer para acumular audio PCM
let textoTranscrito = '';             // 👈 NUEVO: acumula transcripción final

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
    // Si hay transcripción pendiente, guardarla
    if (textoTranscrito.trim()) {
        guardarTexto('transcripcion', textoTranscrito.trim());
        textoTranscrito = '';
    }
    // Limpiar buffer de audio
    audioBufferPCM = Buffer.alloc(0);
    console.log(`📊 [CONVERSACIÓN] Finalizada. Total fragmentos: ${conversacionTemporal.length}`);
}

app.get('/descargar-conversacion', (req, res) => {
    finalizarConversacion();
    if (conversacionTemporal.length === 0) {
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', 'attachment; filename="conversacion_vacia.txt"');
        return res.send("No hay conversación registrada aún.");
    }
    let contenido = '';
    for (const linea of conversacionTemporal) {
        const hora = new Date(linea.timestamp).toLocaleTimeString([], { hour: '2-digit', minute:'2-digit', second:'2-digit' });
        contenido += `[${hora}] ${linea.tipo}: ${linea.texto}\n`;
    }
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="conversacion.txt"');
    res.send(contenido);
    conversacionTemporal = [];
    audioBufferPCM = Buffer.alloc(0);
    textoTranscrito = '';
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
        conversacionTemporal = [];
        audioBufferPCM = Buffer.alloc(0);
        textoTranscrito = '';
        console.log('📞 [LLAMADA] Iniciada con SID:', call.sid);
        
        // Conectar Gemini Live al iniciar la llamada (traducción voz a voz)
        initGeminiToEnglish();
        initGeminiToSpanish();
        
        res.status(200).json({ success: true, callSid: call.sid });
    } catch (error) {
        console.error('❌ Error al realizar la llamada:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/hangup', async (req, res) => {
    try {
        if (activeCallSid) {
            await client.calls(activeCallSid).update({ status: 'completed' });
            
            // 🔥 NUEVO: Antes de finalizar, transcribir el audio acumulado
            if (audioBufferPCM.length > 0) {
                console.log(`🎤 [TRANSCRIPCIÓN] Iniciando transcripción de ${audioBufferPCM.length} bytes de audio...`);
                await transcribirAudioPCM(audioBufferPCM);
            } else {
                console.log('⚠️ No hay audio acumulado para transcribir.');
            }
            
            finalizarConversacion();
            
            if (geminiWsToEnglish && geminiWsToEnglish.readyState === WebSocket.OPEN) {
                geminiWsToEnglish.close();
                geminiWsToEnglish = null;
            }
            if (geminiWsToSpanish && geminiWsToSpanish.readyState === WebSocket.OPEN) {
                geminiWsToSpanish.close();
                geminiWsToSpanish = null;
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
        console.error('❌ Error al colgar:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== FUNCIÓN DE TRANSCRIPCIÓN (NUEVA) ====================
async function transcribirAudioPCM(pcmBuffer) {
    try {
        // Convertir el buffer PCM a base64
        const audioBase64 = pcmBuffer.toString('base64');
        
        console.log(`📤 Enviando ${pcmBuffer.length} bytes de audio a Gemini 3.1 Flash-Lite...`);
        
        const result = await transcriptionModel.generateContent({
            contents: [
                { 
                    role: 'user', 
                    parts: [
                        { text: 'Transcribe el siguiente audio al texto literal en español. Solo devuelve la transcripción, sin comentarios adicionales.' },
                        { inlineData: { mimeType: 'audio/pcm', data: audioBase64 } }
                    ]
                }
            ]
        });
        
        const texto = result.response.text();
        if (texto && texto.trim().length > 0) {
            console.log(`📝 [TRANSCRIPCIÓN FINAL] "${texto}"`);
            textoTranscrito = texto.trim();
            guardarTexto('transcripcion', textoTranscrito);
        } else {
            console.log('⚠️ No se obtuvo transcripción (texto vacío).');
        }
    } catch (err) {
        console.error('❌ Error al transcribir audio:', err.message);
        if (err.message.includes('429')) {
            console.log('⚠️ Límite de cuota alcanzado. Intenta más tarde.');
        }
    }
}

// ==================== WEBSOCKETS (igual que antes, con pequeña adición) ====================
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

// ==================== CANAL 1: Navegador -> Gemini Live -> Twilio (Inglés) ====================
function initGeminiToEnglish() {
    if (geminiWsToEnglish && geminiWsToEnglish.readyState === WebSocket.OPEN) {
        console.log('ℹ️ Gemini [Inglés] ya está conectado');
        return;
    }
    console.log('🔌 Conectando a Gemini [Canal Español ➡️ Inglés]...');
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;
    geminiWsToEnglish = new WebSocket(url);

    geminiWsToEnglish.on('open', () => {
        console.log('✅ Gemini [Inglés] conectado.');
        const setupMessage = {
            setup: {
                model: "models/gemini-3.5-live-translate-preview",
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }
                    }
                }
            }
        };
        geminiWsToEnglish.send(JSON.stringify(setupMessage));
        console.log('📤 [SETUP] Enviado a Gemini [Inglés]');
    });

    geminiWsToEnglish.on('message', (message) => {
        try {
            const response = JSON.parse(message);
            if (response.serverContent && response.serverContent.modelTurn) {
                const parts = response.serverContent.modelTurn.parts;
                for (const part of parts) {
                    if (part.inlineData && part.inlineData.data) {
                        console.log('🔊 [AUDIO] Recibido paquete de audio de Gemini [Inglés]');
                        if (twilioWs && twilioWs.readyState === WebSocket.OPEN && twilioStreamSid) {
                            const convertedAudio = geminiToTwilio(part.inlineData.data);
                            twilioWs.send(JSON.stringify({
                                event: "media",
                                streamSid: twilioStreamSid,
                                media: { payload: convertedAudio.toString('base64') }
                            }));
                            console.log('📤 [AUDIO] Enviado a Twilio');
                        } else {
                            console.log('⚠️ Twilio no disponible');
                        }
                    }
                }
            }
        } catch (e) {
            console.error('❌ Error en mensaje Canal Inglés:', e);
        }
    });

    geminiWsToEnglish.on('close', (code, reason) => {
        console.log(`🔌 Desconectado Gemini [Inglés] - Código: ${code}, Razón: ${reason || 'sin razón'}`);
        geminiWsToEnglish = null;
    });
    geminiWsToEnglish.on('error', (err) => console.error('❌ Error Canal Inglés:', err));
}

// ==================== CANAL 2: Twilio -> Gemini Live -> Navegador (Español) ====================
function initGeminiToSpanish() {
    if (geminiWsToSpanish && geminiWsToSpanish.readyState === WebSocket.OPEN) {
        console.log('ℹ️ Gemini [Español] ya está conectado');
        return;
    }
    console.log('🔌 Conectando a Gemini [Canal Inglés ➡️ Español]...');
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;
    geminiWsToSpanish = new WebSocket(url);

    geminiWsToSpanish.on('open', () => {
        console.log('✅ Gemini [Español] conectado.');
        const setupMessage = {
            setup: {
                model: "models/gemini-3.5-live-translate-preview",
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }
                    }
                }
            }
        };
        geminiWsToSpanish.send(JSON.stringify(setupMessage));
        console.log('📤 [SETUP] Enviado a Gemini [Español]');
    });

    geminiWsToSpanish.on('message', (message) => {
        try {
            const response = JSON.parse(message);
            if (response.serverContent && response.serverContent.modelTurn) {
                const parts = response.serverContent.modelTurn.parts;
                for (const part of parts) {
                    if (part.inlineData && part.inlineData.data) {
                        console.log('🔊 [AUDIO] Recibido paquete de audio de Gemini [Español]');
                        const convertedAudio = geminiToTwilio(part.inlineData.data);
                        broadcastToBrowsers(convertedAudio.toString('base64'));
                        console.log('📤 [AUDIO] Enviado a navegadores');
                    }
                }
            }
        } catch (e) {
            console.error('❌ Error en mensaje Canal Español:', e);
        }
    });

    geminiWsToSpanish.on('close', (code, reason) => {
        console.log(`🔌 Desconectado Gemini [Español] - Código: ${code}, Razón: ${reason || 'sin razón'}`);
        geminiWsToSpanish = null;
    });
    geminiWsToSpanish.on('error', (err) => console.error('❌ Error Canal Español:', err));
}

// ==================== WebSockets del servidor ====================
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

        ws.on('message', (message) => {
            if (geminiWsToEnglish && geminiWsToEnglish.readyState === WebSocket.OPEN) {
                try {
                    const base64Str = message.toString();
                    const ulawBuffer = Buffer.from(base64Str, 'base64');
                    const pcmBuffer = twilioToGemini(ulawBuffer); // Devuelve Buffer PCM 16kHz
                    
                    // 1. Enviar a Gemini Live (audio a audio)
                    geminiWsToEnglish.send(JSON.stringify({
                        realtimeInput: {
                            mediaChunks: [{ mimeType: "audio/pcm", data: pcmBuffer.toString('base64') }]
                        }
                    }));

                    // 2. Acumular audio PCM para transcripción (NUEVO)
                    audioBufferPCM = Buffer.concat([audioBufferPCM, pcmBuffer]);
                    if (audioBufferPCM.length % (16000 * 2 * 10) === 0) { // Cada ~10 segundos
                        console.log(`📊 Audio acumulado: ${(audioBufferPCM.length / (16000 * 2)).toFixed(1)} segundos`);
                    }
                } catch (err) {
                    console.error('❌ Error al procesar audio del navegador:', err);
                }
            } else {
                console.log('⚠️ Gemini [Inglés] no disponible');
            }
        });

        ws.on('close', () => {
            browserConnections.delete(ws);
            clearInterval(keepAliveInterval);
            console.log('🔌 Navegador desconectado. Conexiones restantes:', browserConnections.size);
        });
        ws.on('error', (err) => console.error('❌ Error en WebSocket del navegador:', err.message));
    } 
    else if (pathname === '/media-stream') {
        console.log('📞 Twilio conectado.');
        twilioWs = ws;

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
                        const ulawBuffer = Buffer.from(data.media.payload, 'base64');
                        const pcmBuffer = twilioToGemini(ulawBuffer);
                        geminiWsToSpanish.send(JSON.stringify({
                            realtimeInput: {
                                mediaChunks: [{ mimeType: "audio/pcm", data: pcmBuffer.toString('base64') }]
                            }
                        }));
                    } else {
                        console.log('⚠️ Gemini [Español] no disponible');
                    }
                }
            } catch (err) {
                console.error('❌ Error en flujo Twilio:', err);
            }
        });

        ws.on('close', () => {
            twilioWs = null;
            twilioStreamSid = null;
            console.log('🔌 Twilio desconectado');
        });
    }
});
