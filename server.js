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

// TABLAS DE CONVERSIÓN AUDIO (Se mantienen idénticas)
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

// 🔄 CONVERSOR 1: Teléfono/Navegador (8kHz u-law) ➡️ Gemini (16kHz PCM16)
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

// 🔄 CONVERSOR 2: Gemini (24kHz PCM16) ➡️ Teléfono/Navegador (8kHz u-law)
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

// ==================== DESCARGA DE CONVERSACIÓN ====================
let conversacionTemporal = [];
let bufferProveedor = '';
let bufferTu = '';

function guardarFragmento(tipo, fragmento) {
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
    bufferProveedor = '';
    bufferTu = '';
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
            contenido += `[${hora}] Tú: ${linea.texto}\n`;
        } else if (linea.tipo === 'proveedor') {
            contenido += `[${hora}] Proveedor: ${linea.texto}\n`;
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
            
            // 🛑 CERRAR SESIONES DE GEMINI INMEDIATAMENTE
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

const server = app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
const wss = new WebSocket.Server({ server });

let geminiWsToEnglish = null;
let geminiWsToSpanish = null;
let twilioWs = null;
let twilioStreamSid = null;
let twilioPacketsIn = 0;

// ACUMULADORES GLOBALES PARA EVITAR LOGS INCOMPLETOS O ENTRECORTADOS
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

// 🌐 CANAL 1: CONEXIÓN A GEMINI [Español ➡️ Inglés]
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
                    responseModalities: ["TEXT", "AUDIO"], // 👈 AGREGADO TEXTO PARA EL DIAGNÓSTICO
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }
                    }
                },
                systemInstruction: {
                    parts: [{ text: "You are a real-time bidirectional translator. Translate everything the user says from Spanish into fluent English. Respond ONLY with the spoken audio translation. Do not add any extra explanations or text commentary outside of the literal translation." }]
                }
            }
        };
        geminiWsToEnglish.send(JSON.stringify(setupMessage));
    });

    geminiWsToEnglish.on('message', (message) => {
        try {
            const response = JSON.parse(message);
            
            if (response.serverContent) {
                if (response.serverContent.modelTurn) {
                    const parts = response.serverContent.modelTurn.parts;
                    for (const part of parts) {
                        if (part.text) {
                            textoInglesAcumulado += part.text; // Acumular trozo de texto
                            guardarFragmento('tu', part.text);
                        }
                        
                        if (part.inlineData && part.inlineData.data) {
                            if (twilioWs && twilioWs.readyState === WebSocket.OPEN && twilioStreamSid) {
                                const convertedAudio = geminiToTwilio(part.inlineData.data);
                                console.log('🔊 [AUDIO -> TWILIO]: Reenviando paquete de voz traducido al Inglés.');
                                console.log(`📊 Longitud del audio convertido: ${convertedAudio.length} caracteres base64`);
                                
                                twilioWs.send(JSON.stringify({ 
                                    event: "media", 
                                    streamSid: twilioStreamSid, 
                                    media: { payload: convertedAudio } 
                                }));
                                console.log('✅ Audio enviado a Twilio');
                            }
                        }
                    }
                }
                
                // 📝 IMPRIMIR LOG DE TRADUCCIÓN CUANDO EL MODELO TERMINE LA ORACIÓN
                if (response.serverContent.turnComplete) {
                    if (textoInglesAcumulado.trim()) {
                        console.log(`🇺🇸 [Traducción al Inglés generada]: ${textoInglesAcumulado.trim()}`);
                        textoInglesAcumulado = ''; // Limpiar acumulador para el siguiente turno
                    }
                }
            }
        } catch (e) {
            console.error("Error en mensaje Canal Inglés:", e);
        }
    });

    geminiWsToEnglish.on('close', () => { 
        geminiWsToEnglish = null; 
        console.log('🔌 Enlace cerrado con Gemini [Canal Inglés].');
    });
    geminiWsToEnglish.on('error', (err) => console.error('Error Canal Inglés:', err));
}

// 🌐 CANAL 2: CONEXIÓN A GEMINI [Inglés ➡️ Español]
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
                    responseModalities: ["TEXT", "AUDIO"], // 👈 AGREGADO TEXTO PARA EL DIAGNÓSTICO
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }
                    }
                },
                systemInstruction: {
                    parts: [{ text: "You are a real-time bidirectional translator. Translate everything the user says from English into fluent Spanish. Respond ONLY with the spoken audio translation. Do not add any extra explanations or text commentary outside of the literal translation." }]
                }
            }
        };
        geminiWsToSpanish.send(JSON.stringify(setupMessage));
    });

    geminiWsToSpanish.on('message', (message) => {
        try {
            const response = JSON.parse(message);
            
            if (response.serverContent) {
                if (response.serverContent.modelTurn) {
                    const parts = response.serverContent.modelTurn.parts;
                    for (const part of parts) {
                        if (part.text) {
                            textoEspanolAcumulado += part.text; // Acumular trozo de texto
                            guardarFragmento('proveedor', part.text);
                        }
                        
                        if (part.inlineData && part.inlineData.data) {
                            const convertedAudio = geminiToTwilio(part.inlineData.data);
                            console.log('🔊 [AUDIO -> NAVEGADOR]: Reenviando paquete de voz traducido al Español.');
                            console.log(`📊 Longitud del audio convertido: ${convertedAudio.length} caracteres base64`);
                            
                            broadcastToBrowsers(convertedAudio);
                            console.log('✅ Audio enviado a todos los navegadores conectados');
                        }
                    }
                }
                
                // 📝 IMPRIMIR LOG DE TRADUCCIÓN CUANDO EL MODELO TERMINE LA ORACIÓN
                if (response.serverContent.turnComplete) {
                    if (textoEspanolAcumulado.trim()) {
                        console.log(`🇪🇸 [Traducción al Español generada]: ${textoEspanolAcumulado.trim()}`);
                        textoEspanolAcumulado = ''; // Limpiar acumulador para el siguiente turno
                    }
                }
            }
        } catch (e) {
            console.error("Error en mensaje Canal Español:", e);
        }
    });

    geminiWsToSpanish.on('close', () => { 
        geminiWsToSpanish = null; 
        console.log('🔌 Enlace cerrado con Gemini [Canal Español].');
    });
    geminiWsToSpanish.on('error', (err) => console.error('Error Canal Español:', err));
}

// GESTIÓN DE FLUJOS INTERNOS (WebSockets del Servidor)
wss.on('connection', (ws, req) => {
    const urlClara = new URL(req.url, `http://${req.headers.host}`);
    const pathname = urlClara.pathname;

    if (pathname === '/browser-stream') {
        console.log('🚀 Navegador conectado. Total conexiones activas:', browserConnections.size + 1);
        browserConnections.add(ws);
        
        const keepAliveInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ping' }));
                console.log('💓 Keepalive enviado al navegador');
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
