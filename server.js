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

// TABLAS DE CONVERSIÓN AUDIO
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

// ==================== SISTEMA DE CONVERSACIÓN ====================
let conversacionTemporal = [];
let textoInglesAcumulado = '';
let textoEspanolAcumulado = '';
let temporizadorEspanol = null;
let temporizadorIngles = null;

function guardarFragmento(tipo, textoCompleto) {
    if (textoCompleto && textoCompleto.trim().length > 0) {
        conversacionTemporal.push({
            timestamp: new Date().toISOString(),
            tipo: tipo,
            texto: textoCompleto.trim()
        });
        console.log(`📝 [GUARDADO] ${tipo}: ${textoCompleto.trim()}`);
    }
}

function resetearTemporizador(tipo) {
    if (tipo === 'español' && temporizadorEspanol) {
        clearTimeout(temporizadorEspanol);
        temporizadorEspanol = null;
    }
    if (tipo === 'inglés' && temporizadorIngles) {
        clearTimeout(temporizadorIngles);
        temporizadorIngles = null;
    }
}

function procesarTextoEspanol(nuevoTexto) {
    if (!nuevoTexto || nuevoTexto.trim() === '') return;
    
    console.log(`🔵 [RAW - Español recibido]: "${nuevoTexto}"`);
    
    resetearTemporizador('español');
    
    textoEspanolAcumulado += nuevoTexto;
    
    if (/[.!?;:]$/.test(nuevoTexto.trim())) {
        if (textoEspanolAcumulado.trim()) {
            const textoFinal = textoEspanolAcumulado.trim();
            console.log(`🇪🇸 [TRADUCCIÓN ESPAÑOL]: ${textoFinal}`);
            guardarFragmento('proveedor', textoFinal);
            textoEspanolAcumulado = '';
        }
        resetearTemporizador('español');
    } else {
        temporizadorEspanol = setTimeout(() => {
            if (textoEspanolAcumulado && textoEspanolAcumulado.trim()) {
                console.log(`🇪🇸 [TRADUCCIÓN ESPAÑOL - TIMEOUT]: ${textoEspanolAcumulado.trim()}`);
                guardarFragmento('proveedor', textoEspanolAcumulado.trim());
                textoEspanolAcumulado = '';
            }
            temporizadorEspanol = null;
        }, 1500);
    }
}

function procesarTextoIngles(nuevoTexto) {
    if (!nuevoTexto || nuevoTexto.trim() === '') return;
    
    console.log(`🔴 [RAW - Inglés recibido]: "${nuevoTexto}"`);
    
    resetearTemporizador('inglés');
    
    textoInglesAcumulado += nuevoTexto;
    
    if (/[.!?;:]$/.test(nuevoTexto.trim())) {
        if (textoInglesAcumulado.trim()) {
            const textoFinal = textoInglesAcumulado.trim();
            console.log(`🇺🇸 [TRADUCCIÓN INGLÉS]: ${textoFinal}`);
            guardarFragmento('tu', textoFinal);
            textoInglesAcumulado = '';
        }
        resetearTemporizador('inglés');
    } else {
        temporizadorIngles = setTimeout(() => {
            if (textoInglesAcumulado && textoInglesAcumulado.trim()) {
                console.log(`🇺🇸 [TRADUCCIÓN INGLÉS - TIMEOUT]: ${textoInglesAcumulado.trim()}`);
                guardarFragmento('tu', textoInglesAcumulado.trim());
                textoInglesAcumulado = '';
            }
            temporizadorIngles = null;
        }, 1500);
    }
}

function finalizarConversacion() {
    if (textoEspanolAcumulado && textoEspanolAcumulado.trim()) {
        console.log(`🇪🇸 [FINAL ESPAÑOL]: ${textoEspanolAcumulado.trim()}`);
        guardarFragmento('proveedor', textoEspanolAcumulado.trim());
        textoEspanolAcumulado = '';
    }
    if (textoInglesAcumulado && textoInglesAcumulado.trim()) {
        console.log(`🇺🇸 [FINAL INGLÉS]: ${textoInglesAcumulado.trim()}`);
        guardarFragmento('tu', textoInglesAcumulado.trim());
        textoInglesAcumulado = '';
    }
    if (temporizadorEspanol) clearTimeout(temporizadorEspanol);
    if (temporizadorIngles) clearTimeout(temporizadorIngles);
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
                console.log('✅ Sesión Gemini [Inglés] cerrada');
            }
            if (geminiWsToSpanish && geminiWsToSpanish.readyState === WebSocket.OPEN) {
                geminiWsToSpanish.close();
                geminiWsToSpanish = null;
                console.log('✅ Sesión Gemini [Español] cerrada');
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

// 🌐 CANAL 1: Español (desde navegador) -> Inglés (a Twilio)
function initGeminiToEnglish() {
    if (geminiWsToEnglish && geminiWsToEnglish.readyState === WebSocket.OPEN) return;
    console.log('🌐 Conectando Gemini [Español ➡️ Inglés]...');
    
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;
    geminiWsToEnglish = new WebSocket(url);

    geminiWsToEnglish.on('open', () => {
        console.log('✅ Gemini [Inglés] conectado');
        const setupMessage = {
            setup: {
                model: "models/gemini-3.5-live-translate-preview",
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    outputAudioTranscription: {}   // <--- CAMBIO: agregado
                }
            }
        };
        geminiWsToEnglish.send(JSON.stringify(setupMessage));
    });

    geminiWsToEnglish.on('message', (message) => {
        try {
            const response = JSON.parse(message);
            
            // <--- CAMBIO: capturar texto de la traducción
            if (response.serverContent && response.serverContent.outputTranscription && response.serverContent.outputTranscription.text) {
                procesarTextoIngles(response.serverContent.outputTranscription.text);
            }
            
            if (response.serverContent && response.serverContent.modelTurn && response.serverContent.modelTurn.parts) {
                for (const part of response.serverContent.modelTurn.parts) {
                    if (part.inlineData && part.inlineData.data) {
                        if (twilioWs && twilioWs.readyState === WebSocket.OPEN && twilioStreamSid) {
                            const convertedAudio = geminiToTwilio(part.inlineData.data);
                            twilioWs.send(JSON.stringify({ 
                                event: "media", 
                                streamSid: twilioStreamSid, 
                                media: { payload: convertedAudio } 
                            }));
                        }
                    }
                }
            }
            
            if (response.serverContent && response.serverContent.turnComplete) {
                resetearTemporizador('inglés');
                if (textoInglesAcumulado && textoInglesAcumulado.trim()) {
                    console.log(`🇺🇸 [turnComplete - Inglés]: ${textoInglesAcumulado.trim()}`);
                    guardarFragmento('tu', textoInglesAcumulado.trim());
                    textoInglesAcumulado = '';
                }
            }
        } catch (e) {
            console.error("Error Canal Inglés:", e);
        }
    });

    geminiWsToEnglish.on('close', () => { 
        geminiWsToEnglish = null; 
        console.log('🔌 Gemini [Inglés] desconectado');
    });
    geminiWsToEnglish.on('error', (err) => console.error('Error Canal Inglés:', err));
}

// 🌐 CANAL 2: Inglés (desde Twilio) -> Español (a navegador)
function initGeminiToSpanish() {
    if (geminiWsToSpanish && geminiWsToSpanish.readyState === WebSocket.OPEN) return;
    console.log('🌐 Conectando Gemini [Inglés ➡️ Español]...');
    
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;
    geminiWsToSpanish = new WebSocket(url);

    geminiWsToSpanish.on('open', () => {
        console.log('✅ Gemini [Español] conectado');
        const setupMessage = {
            setup: {
                model: "models/gemini-3.5-live-translate-preview",
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    outputAudioTranscription: {}   // <--- CAMBIO: agregado
                }
            }
        };
        geminiWsToSpanish.send(JSON.stringify(setupMessage));
    });

    geminiWsToSpanish.on('message', (message) => {
        try {
            const response = JSON.parse(message);
            
            // <--- CAMBIO: capturar texto de la traducción
            if (response.serverContent && response.serverContent.outputTranscription && response.serverContent.outputTranscription.text) {
                procesarTextoEspanol(response.serverContent.outputTranscription.text);
            }
            
            if (response.serverContent && response.serverContent.modelTurn && response.serverContent.modelTurn.parts) {
                for (const part of response.serverContent.modelTurn.parts) {
                    if (part.inlineData && part.inlineData.data) {
                        const convertedAudio = geminiToTwilio(part.inlineData.data);
                        broadcastToBrowsers(convertedAudio);
                    }
                }
            }
            
            if (response.serverContent && response.serverContent.turnComplete) {
                resetearTemporizador('español');
                if (textoEspanolAcumulado && textoEspanolAcumulado.trim()) {
                    console.log(`🇪🇸 [turnComplete - Español]: ${textoEspanolAcumulado.trim()}`);
                    guardarFragmento('proveedor', textoEspanolAcumulado.trim());
                    textoEspanolAcumulado = '';
                }
            }
        } catch (e) {
            console.error("Error Canal Español:", e);
        }
    });

    geminiWsToSpanish.on('close', () => { 
        geminiWsToSpanish = null; 
        console.log('🔌 Gemini [Español] desconectado');
    });
    geminiWsToSpanish.on('error', (err) => console.error('Error Canal Español:', err));
}

// ==================== WEBSOCKETS ====================
wss.on('connection', (ws, req) => {
    const urlClara = new URL(req.url, `http://${req.headers.host}`);
    const pathname = urlClara.pathname;

    if (pathname === '/browser-stream') {
        console.log('🖥️ Navegador conectado');
        browserConnections.add(ws);
        initGeminiToEnglish();

        ws.on('message', (message) => {
            if (geminiWsToEnglish && geminiWsToEnglish.readyState === WebSocket.OPEN) {
                try {
                    const ulawBuffer = Buffer.from(message.toString(), 'base64');
                    const convertedAudio = twilioToGemini(ulawBuffer);
                    geminiWsToEnglish.send(JSON.stringify({
                        realtimeInput: {
                            mediaChunks: [{ mimeType: "audio/pcm", data: convertedAudio }]
                        }
                    }));
                } catch (err) {
                    console.error("Error audio navegador:", err);
                }
            }
        });

        ws.on('close', () => {
            browserConnections.delete(ws);
            console.log('🔌 Navegador desconectado');
        });
    } 
    
    else if (pathname === '/media-stream') {
        console.log('📞 Twilio conectado');
        twilioWs = ws;
        initGeminiToSpanish();

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                
                if (data.event === 'start') {
                    twilioStreamSid = data.start.streamSid;
                    console.log(`📞 Stream Twilio: ${twilioStreamSid}`);
                }

                if (data.event === 'media') {
                    twilioPacketsIn++;
                    if (geminiWsToSpanish && geminiWsToSpanish.readyState === WebSocket.OPEN) {
                        const convertedAudio = twilioToGemini(Buffer.from(data.media.payload, 'base64'));
                        geminiWsToSpanish.send(JSON.stringify({
                            realtimeInput: {
                                mediaChunks: [{ mimeType: "audio/pcm", data: convertedAudio }]
                            }
                        }));
                    }
                }
            } catch (err) {
                console.error("Error Twilio:", err);
            }
        });

        ws.on('close', () => {
            twilioWs = null;
            twilioStreamSid = null;
            console.log('🔌 Twilio desconectado');
        });
    }
});
