require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const twilio = require('twilio');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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

// Conversor: µ-law (8kHz) → PCM (16kHz)
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
    return outBuffer; // Devuelve Buffer
}

// Conversor: PCM (24kHz) → µ-law (8kHz)
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

// ==================== GESTIÓN DE CONVERSACIÓN ====================
let conversacionTemporal = [];
let bufferProveedor = '';    // Traducción Inglés→Español
let bufferTu = '';           // Traducción Español→Inglés
let bufferTranscripcion = ''; // Transcripción del navegador

// Buffers de audio separados
let audioBufferTranscripcion = Buffer.alloc(0);
let lastTranscriptionTime = Date.now();
const SEGMENT_DURATION = 15; // segundos
const MIN_SEGMENT_BYTES = 16000; // 1 segundo

function guardarFragmento(tipo, fragmento) {
    if (!fragmento || fragmento.trim().length === 0) return;
    console.log(`📝 [GUARDAR] tipo=${tipo}, texto="${fragmento.trim()}"`);
    
    if (tipo === 'proveedor') {
        bufferProveedor += fragmento;
        if (/[.!?;:]\s*$/.test(bufferProveedor)) {
            conversacionTemporal.push({
                timestamp: new Date().toISOString(),
                tipo: 'proveedor',
                texto: bufferProveedor.trim()
            });
            bufferProveedor = '';
        }
    } else if (tipo === 'tu') {
        bufferTu += fragmento;
        if (/[.!?;:]\s*$/.test(bufferTu)) {
            conversacionTemporal.push({
                timestamp: new Date().toISOString(),
                tipo: 'tu',
                texto: bufferTu.trim()
            });
            bufferTu = '';
        }
    } else if (tipo === 'transcripcion') {
        const texto = fragmento.trim();
        if (texto.length < 3) return;
        const palabrasFiltro = ['música', 'silencio', 'ruido', 'click', 'tono'];
        if (palabrasFiltro.some(p => texto.toLowerCase().includes(p))) {
            console.log(`⏭️ Transcripción filtrada: "${texto}"`);
            return;
        }
        conversacionTemporal.push({
            timestamp: new Date().toISOString(),
            tipo: 'transcripcion',
            texto: texto
        });
    }
}

function finalizarConversacion() {
    if (bufferProveedor && bufferProveedor.trim().length > 0) {
        conversacionTemporal.push({
            timestamp: new Date().toISOString(),
            tipo: 'proveedor',
            texto: bufferProveedor.trim()
        });
    }
    if (bufferTu && bufferTu.trim().length > 0) {
        conversacionTemporal.push({
            timestamp: new Date().toISOString(),
            tipo: 'tu',
            texto: bufferTu.trim()
        });
    }
    if (audioBufferTranscripcion.length > 0) {
        console.log(`🎤 [TRANSCRIPCIÓN FINAL] Transcribiendo último segmento de ${audioBufferTranscripcion.length} bytes...`);
        transcribirAudioPCM(audioBufferTranscripcion);
        audioBufferTranscripcion = Buffer.alloc(0);
    }
    bufferProveedor = '';
    bufferTu = '';
    bufferTranscripcion = '';
    console.log(`📊 [CONVERSACIÓN] Finalizada. Total fragmentos: ${conversacionTemporal.length}`);
}

app.get('/descargar-conversacion', (req, res) => {
    finalizarConversacion();
    
    if (conversacionTemporal.length === 0) {
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', 'attachment; filename="conversacion_vacia.txt"');
        return res.send("No hay conversación registrada.");
    }
    
    let contenido = '';
    for (const linea of conversacionTemporal) {
        const hora = new Date(linea.timestamp).toLocaleTimeString([], { hour: '2-digit', minute:'2-digit', second:'2-digit' });
       
        if (linea.tipo === 'tu') {
            contenido += `[${hora}] Tú (Traducción al Inglés): ${linea.texto}\n`;
        } else if (linea.tipo === 'proveedor') {
            contenido += `[${hora}] Proveedor (Traducción al Español): ${linea.texto}\n`;
        } else if (linea.tipo === 'transcripcion') {
            contenido += `[${hora}] Transcripción (Audio original): ${linea.texto}\n`;
        }
    }
    
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="conversacion.txt"');
    res.send(contenido);
    
    conversacionTemporal = [];
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
        bufferProveedor = '';
        bufferTu = '';
        bufferTranscripcion = '';
        audioBufferTranscripcion = Buffer.alloc(0);
        lastTranscriptionTime = Date.now();
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
            finalizarConversacion();
            
            if (geminiWsToEnglish && geminiWsToEnglish.readyState === WebSocket.OPEN) {
                geminiWsToEnglish.close();
                geminiWsToEnglish = null;
                console.log('✅ Sesión Gemini [Inglés] cerrada limpiamente');
            }
            if (geminiWsToSpanish && geminiWsToSpanish.readyState === WebSocket.OPEN) {
                geminiWsToSpanish.close();
                geminiWsToSpanish = null;
                console.log('✅ Sesión Gemini [Español] cerrada limpiamente');
            }
            
            const duracion = callStartTime ? ((Date.now() - callStartTime) / 1000).toFixed(1) : 'desconocida';
            const memUsage = process.memoryUsage();
            console.log(`📊 [RAM] Llamada finalizada. Duración: ${duracion}s | RSS: ${(memUsage.rss / 1024 / 1024).toFixed(1)} MB | Heap: ${(memUsage.heapUsed / 1024 / 1024).toFixed(1)} MB`);
            
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

// ==================== FUNCIÓN DE TRANSCRIPCIÓN ====================
async function transcribirAudioPCM(pcmBuffer) {
    if (pcmBuffer.length < MIN_SEGMENT_BYTES) {
        console.log(`⏭️ Segmento demasiado pequeño (${pcmBuffer.length} bytes), omitiendo transcripción.`);
        return;
    }

    try {
        const audioBase64 = pcmBuffer.toString('base64');
        console.log(`📤 Enviando ${pcmBuffer.length} bytes de audio a Gemini 3.1 Flash-Lite...`);
        
        const prompt = `Transcribe el siguiente audio al texto literal en español. 
        Instrucciones:
        - Solo transcribe voz humana en español.
        - Ignora música, ruido de fondo, silencios o cualquier sonido que no sea voz.
        - Si no hay voz humana, responde con "SILENCIO".
        - No incluyas marcas de tiempo ni comentarios adicionales.`;

        const result = await transcriptionModel.generateContent({
            contents: [
                { 
                    role: 'user', 
                    parts: [
                        { text: prompt },
                        { inlineData: { mimeType: 'audio/pcm', data: audioBase64 } }
                    ]
                }
            ]
        });
        
        const texto = result.response.text();
        console.log(`📥 [RESPUESTA TRANSCRIPCIÓN] Texto recibido: "${texto}"`);
        if (texto && texto.trim().length > 0 && texto.trim() !== 'SILENCIO') {
            console.log(`📝 [TRANSCRIPCIÓN FINAL] "${texto}"`);
            guardarFragmento('transcripcion', texto.trim());
        } else {
            console.log('⏭️ Transcripción vacía o silencio detectado.');
        }
    } catch (err) {
        console.error('❌ Error al transcribir audio:', err.message);
        if (err.message.includes('429')) {
            console.log('⚠️ Límite de cuota alcanzado. Intenta más tarde.');
        }
    }
}

const server = app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
const wss = new WebSocket.Server({ server });

let geminiWsToEnglish = null;
let geminiWsToSpanish = null;
let twilioWs = null;
let twilioStreamSid = null;
let twilioPacketsIn = 0;

let textoInglesAcumulado = '';
let textoEspanolAcumulado = '';

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

// ==================== CANAL 1: ESPAÑOL → INGLÉS ====================
function initGeminiToEnglish() {
    if (geminiWsToEnglish && geminiWsToEnglish.readyState === WebSocket.OPEN) return;
    console.log('Conectando a Gemini [Canal Español ➡️ Inglés]... 🇺🇸');
    
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;
    geminiWsToEnglish = new WebSocket(url);

    geminiWsToEnglish.on('open', () => {
        console.log('✅ Gemini [Canal Inglés] conectado con éxito.');
        const setupMessage = {
            setup: {
                model: "models/gemini-3.5-live-translate-preview",
                generationConfig: {
                    responseModalities: ["TEXT", "AUDIO"],  // 👈 IMPORTANTE: pedimos texto y audio
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }
                    }
                }
                // ⚠️ ELIMINADA systemInstruction para no anular el texto
            }
        };
        geminiWsToEnglish.send(JSON.stringify(setupMessage));
        console.log('📤 [SETUP] Enviado a Gemini [Inglés] sin systemInstruction');
    });

    geminiWsToEnglish.on('message', (message) => {
        try {
            const response = JSON.parse(message);
            
            // 🔍 LOG ESTRUCTURA COMPLETA (solo primer mensaje para no saturar)
            if (!geminiWsToEnglish._logged) {
                console.log('🔍 [RESPUESTA GEMINI INGLÉS] Estructura completa:', JSON.stringify(response, null, 2).substring(0, 800));
                geminiWsToEnglish._logged = true;
            }

            if (response.serverContent) {
                // 📝 Si hay modeloTurn, procesar partes
                if (response.serverContent.modelTurn) {
                    const parts = response.serverContent.modelTurn.parts;
                    console.log(`🔍 [INGLÉS] modelTurn tiene ${parts.length} partes`);
                    for (const part of parts) {
                        // ✅ TEXTO
                        if (part.text) {
                            console.log(`🇺🇸 [TEXTO INGLÉS] part.text: "${part.text}"`);
                            textoInglesAcumulado += part.text;
                            guardarFragmento('tu', part.text);
                        }
                        // ✅ AUDIO
                        if (part.inlineData && part.inlineData.data) {
                            console.log(`🔊 [AUDIO INGLÉS] inlineData recibido (${part.inlineData.data.length} chars)`);
                            if (twilioWs && twilioWs.readyState === WebSocket.OPEN && twilioStreamSid) {
                                const convertedAudio = geminiToTwilio(part.inlineData.data);
                                twilioWs.send(JSON.stringify({ 
                                    event: "media", 
                                    streamSid: twilioStreamSid, 
                                    media: { payload: convertedAudio } 
                                }));
                                console.log('✅ Audio enviado a Twilio');
                            } else {
                                console.log('⚠️ Twilio no disponible para enviar audio');
                            }
                        }
                    }
                } else {
                    console.log('🔍 [INGLÉS] serverContent no contiene modelTurn');
                }

                // 📝 turnComplete (para saber cuándo termina una frase)
                if (response.serverContent.turnComplete) {
                    console.log('🔄 [INGLÉS] turnComplete recibido');
                    if (textoInglesAcumulado.trim()) {
                        console.log(`🇺🇸 [Traducción al Inglés generada]: ${textoInglesAcumulado.trim()}`);
                        // Ya se guardó en guardarFragmento, solo limpiamos acumulador
                        textoInglesAcumulado = '';
                    }
                }
            } else {
                console.log('🔍 [INGLÉS] No hay serverContent en la respuesta');
            }
        } catch (e) {
            console.error("❌ Error en mensaje Canal Inglés:", e);
        }
    });

    geminiWsToEnglish.on('close', (code, reason) => {
        console.log(`🔌 Enlace cerrado con Gemini [Canal Inglés] - Código: ${code}, Razón: ${reason || 'sin razón'}`);
        geminiWsToEnglish = null;
    });
    geminiWsToEnglish.on('error', (err) => console.error('❌ Error Canal Inglés:', err));
}

// ==================== CANAL 2: INGLÉS → ESPAÑOL ====================
function initGeminiToSpanish() {
    if (geminiWsToSpanish && geminiWsToSpanish.readyState === WebSocket.OPEN) return;
    console.log('Conectando a Gemini [Canal Inglés ➡️ Español]... 🇪🇸');
    
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;
    geminiWsToSpanish = new WebSocket(url);

    geminiWsToSpanish.on('open', () => {
        console.log('✅ Gemini [Canal Español] conectado con éxito.');
        const setupMessage = {
            setup: {
                model: "models/gemini-3.5-live-translate-preview",
                generationConfig: {
                    responseModalities: ["TEXT", "AUDIO"],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }
                    }
                }
                // ⚠️ ELIMINADA systemInstruction
            }
        };
        geminiWsToSpanish.send(JSON.stringify(setupMessage));
        console.log('📤 [SETUP] Enviado a Gemini [Español] sin systemInstruction');
    });

    geminiWsToSpanish.on('message', (message) => {
        try {
            const response = JSON.parse(message);
            
            if (!geminiWsToSpanish._logged) {
                console.log('🔍 [RESPUESTA GEMINI ESPAÑOL] Estructura completa:', JSON.stringify(response, null, 2).substring(0, 800));
                geminiWsToSpanish._logged = true;
            }

            if (response.serverContent) {
                if (response.serverContent.modelTurn) {
                    const parts = response.serverContent.modelTurn.parts;
                    console.log(`🔍 [ESPAÑOL] modelTurn tiene ${parts.length} partes`);
                    for (const part of parts) {
                        if (part.text) {
                            console.log(`🇪🇸 [TEXTO ESPAÑOL] part.text: "${part.text}"`);
                            textoEspanolAcumulado += part.text;
                            guardarFragmento('proveedor', part.text);
                        }
                        if (part.inlineData && part.inlineData.data) {
                            console.log(`🔊 [AUDIO ESPAÑOL] inlineData recibido (${part.inlineData.data.length} chars)`);
                            const convertedAudio = geminiToTwilio(part.inlineData.data);
                            broadcastToBrowsers(convertedAudio);
                            console.log('✅ Audio enviado a navegadores');
                        }
                    }
                } else {
                    console.log('🔍 [ESPAÑOL] serverContent no contiene modelTurn');
                }

                if (response.serverContent.turnComplete) {
                    console.log('🔄 [ESPAÑOL] turnComplete recibido');
                    if (textoEspanolAcumulado.trim()) {
                        console.log(`🇪🇸 [Traducción al Español generada]: ${textoEspanolAcumulado.trim()}`);
                        textoEspanolAcumulado = '';
                    }
                }
            } else {
                console.log('🔍 [ESPAÑOL] No hay serverContent en la respuesta');
            }
        } catch (e) {
            console.error("❌ Error en mensaje Canal Español:", e);
        }
    });

    geminiWsToSpanish.on('close', (code, reason) => {
        console.log(`🔌 Enlace cerrado con Gemini [Canal Español] - Código: ${code}, Razón: ${reason || 'sin razón'}`);
        geminiWsToSpanish = null;
    });
    geminiWsToSpanish.on('error', (err) => console.error('❌ Error Canal Español:', err));
}

// ==================== WEBSOCKETS DEL SERVIDOR ====================
wss.on('connection', (ws, req) => {
    const urlClara = new URL(req.url, `http://${req.headers.host}`);
    const pathname = urlClara.pathname;

    if (pathname === '/browser-stream') {
        console.log('🚀 Navegador conectado. Total conexiones activas:', browserConnections.size + 1);
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
                    const pcmBuffer = twilioToGemini(ulawBuffer);
                    
                    // 1. Enviar a Gemini Live (flujo continuo)
                    geminiWsToEnglish.send(JSON.stringify({
                        realtimeInput: {
                            mediaChunks: [
                                {
                                    mimeType: "audio/pcm",
                                    data: pcmBuffer.toString('base64')
                                }
                            ]
                        }
                    }));

                    // 2. Copiar para transcripción
                    audioBufferTranscripcion = Buffer.concat([audioBufferTranscripcion, pcmBuffer]);
                    
                    const now = Date.now();
                    if ((now - lastTranscriptionTime) >= SEGMENT_DURATION * 1000) {
                        const segundos = (audioBufferTranscripcion.length / (16000 * 2)).toFixed(1);
                        console.log(`🎤 [TRANSCRIPCIÓN] Segmento de ${segundos} segundos`);
                        transcribirAudioPCM(audioBufferTranscripcion);
                        audioBufferTranscripcion = Buffer.alloc(0);
                        lastTranscriptionTime = now;
                    }
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
        console.log('🚀 Twilio vinculado.');
        twilioWs = ws;
        
        initGeminiToSpanish();

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                
                if (data.event === 'start') {
                    twilioStreamSid = data.start.streamSid;
                    console.log(`📞 Enlace Twilio fijado: ${twilioStreamSid}`);
                    
                    browserConnections.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({ type: 'twilio_ready' }));
                            console.log('📢 Notificado al navegador: Twilio listo');
                        }
                    });
                }

                if (data.event === 'media') {
                    twilioPacketsIn++;
                    if (twilioPacketsIn % 100 === 0) {
                        console.log(`📥 [DIAGNÓSTICO]: Procesando audio de Twilio... (${twilioPacketsIn} paquetes)`);
                    }

                    if (geminiWsToSpanish && geminiWsToSpanish.readyState === WebSocket.OPEN) {
                        const ulawBuffer = Buffer.from(data.media.payload, 'base64');
                        const pcmBuffer = twilioToGemini(ulawBuffer);
                        geminiWsToSpanish.send(JSON.stringify({
                            realtimeInput: {
                                mediaChunks: [
                                    {
                                        mimeType: "audio/pcm",
                                        data: pcmBuffer.toString('base64')
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
