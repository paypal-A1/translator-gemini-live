require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const twilio = require('twilio');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 10000;
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Cliente para resúmenes (modelo Flash-Lite)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

let activeCallSid = null;
let callStartTime = null;

// ==================== REGISTRO DE CONVERSACIÓN ====================
let conversacionTemporal = [];
let resumenConversacion = null;

function guardarFragmento(tipo, textoCompleto) {
    if (textoCompleto && textoCompleto.trim().length > 0) {
        conversacionTemporal.push({
            timestamp: new Date().toISOString(),
            tipo: tipo,
            texto: textoCompleto.trim()
        });
        console.log(`📝 [${tipo}]: ${textoCompleto.trim()}`);
    }
}

// ==================== FUNCIONES DE AUDIO (INTACTAS) ====================
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

// ==================== GENERACIÓN DE RESUMEN AL FINAL ====================
async function generarResumen(conversacion) {
    if (!conversacion || conversacion.length === 0) return "No hay conversación para resumir.";
    let contenido = '';
    for (const linea of conversacion) {
        const hora = new Date(linea.timestamp).toLocaleTimeString([], { hour: '2-digit', minute:'2-digit', second:'2-digit' });
        const emisor = linea.tipo === 'tu' ? 'Tú' : 'Proveedor';
        contenido += `[${hora}] ${emisor}: ${linea.texto}\n`;
    }
    try {
        const respuesta = await ai.models.generateContent({
            model: 'gemini-2.5-flash-lite',
            contents: `Resume la siguiente conversación de forma breve, destacando los puntos clave:\n\n${contenido}`
        });
        return respuesta.text;
    } catch (error) {
        console.error('Error generando resumen:', error);
        return "Error al generar resumen.";
    }
}

app.get('/descargar-conversacion', (req, res) => {
    if (conversacionTemporal.length === 0) {
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', 'attachment; filename="conversacion_vacia.txt"');
        return res.send("No hay conversación registrada aún.");
    }
    
    let contenido = '';
    if (resumenConversacion && resumenConversacion !== "No hay conversación para resumir.") {
        contenido += "=== RESUMEN ===\n" + resumenConversacion + "\n\n=== TRANSCRIPCIÓN ===\n\n";
    }
    for (const linea of conversacionTemporal) {
        const hora = new Date(linea.timestamp).toLocaleTimeString([], { hour: '2-digit', minute:'2-digit', second:'2-digit' });
        if (linea.tipo === 'tu') {
            contenido += `[${hora}] Tú: ${linea.texto}\n`;
        } else {
            contenido += `[${hora}] Proveedor: ${linea.texto}\n`;
        }
    }
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="conversacion.txt"');
    res.send(contenido);
    conversacionTemporal = [];
    resumenConversacion = null;
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
        resumenConversacion = null;
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
            // Generar resumen en segundo plano
            (async () => {
                resumenConversacion = await generarResumen(conversacionTemporal);
                console.log('✅ Resumen generado');
            })();
            
            if (geminiWsToEnglish && geminiWsToEnglish.readyState === WebSocket.OPEN) geminiWsToEnglish.close();
            if (geminiWsToSpanish && geminiWsToSpanish.readyState === WebSocket.OPEN) geminiWsToSpanish.close();
            if (transcriberWs && transcriberWs.readyState === WebSocket.OPEN) transcriberWs.close();
            
            const duracion = callStartTime ? ((Date.now() - callStartTime) / 1000).toFixed(1) : 'desconocida';
            console.log(`📊 Llamada finalizada. Duración: ${duracion}s`);
            browserConnections.forEach(client => {
                if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'call_duration', duration: duracion }));
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

// ==================== CONEXIONES ORIGINALES (AUDIO) ====================
let geminiWsToEnglish = null;
let geminiWsToSpanish = null;
let twilioWs = null;
let twilioStreamSid = null;
let twilioPacketsIn = 0;
const browserConnections = new Set();

function broadcastToBrowsers(audioData) {
    const toRemove = [];
    browserConnections.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'audio', payload: audioData }));
        else toRemove.push(ws);
    });
    toRemove.forEach(ws => browserConnections.delete(ws));
}

// CANAL 1: Español -> Inglés (AUDIO, INTACTO)
function initGeminiToEnglish() {
    if (geminiWsToEnglish && geminiWsToEnglish.readyState === WebSocket.OPEN) return;
    console.log('Conectando Gemini [Español ➡️ Inglés]...');
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;
    geminiWsToEnglish = new WebSocket(url);
    geminiWsToEnglish.on('open', () => {
        console.log('✅ Gemini [Inglés] conectado');
        geminiWsToEnglish.send(JSON.stringify({
            setup: {
                model: "models/gemini-3.5-live-translate-preview",
                generationConfig: {
                    responseModalities: ["TEXT", "AUDIO"],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } }
                },
                systemInstruction: { parts: [{ text: "Translate Spanish to English. Provide both text and audio." }] }
            }
        }));
    });
    geminiWsToEnglish.on('message', (message) => {
        try {
            const response = JSON.parse(message);
            if (response.serverContent?.modelTurn?.parts) {
                for (const part of response.serverContent.modelTurn.parts) {
                    if (part.inlineData && part.inlineData.data && twilioWs && twilioStreamSid) {
                        const converted = geminiToTwilio(part.inlineData.data);
                        twilioWs.send(JSON.stringify({ event: "media", streamSid: twilioStreamSid, media: { payload: converted } }));
                    }
                }
            }
        } catch(e) { console.error(e); }
    });
    geminiWsToEnglish.on('close', () => { geminiWsToEnglish = null; });
}

// CANAL 2: Inglés -> Español (AUDIO, INTACTO)
function initGeminiToSpanish() {
    if (geminiWsToSpanish && geminiWsToSpanish.readyState === WebSocket.OPEN) return;
    console.log('Conectando Gemini [Inglés ➡️ Español]...');
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;
    geminiWsToSpanish = new WebSocket(url);
    geminiWsToSpanish.on('open', () => {
        console.log('✅ Gemini [Español] conectado');
        geminiWsToSpanish.send(JSON.stringify({
            setup: {
                model: "models/gemini-3.5-live-translate-preview",
                generationConfig: {
                    responseModalities: ["TEXT", "AUDIO"],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } }
                },
                systemInstruction: { parts: [{ text: "Translate English to Spanish. Provide both text and audio." }] }
            }
        }));
    });
    geminiWsToSpanish.on('message', (message) => {
        try {
            const response = JSON.parse(message);
            if (response.serverContent?.modelTurn?.parts) {
                for (const part of response.serverContent.modelTurn.parts) {
                    if (part.inlineData && part.inlineData.data) {
                        const converted = geminiToTwilio(part.inlineData.data);
                        broadcastToBrowsers(converted);
                    }
                }
            }
        } catch(e) { console.error(e); }
    });
    geminiWsToSpanish.on('close', () => { geminiWsToSpanish = null; });
}

// ==================== NUEVO: TRANSCRIPCIÓN CON GEMINI 2.5 FLASH LIVE ====================
let transcriberWs = null;
let transcriberStreamSid = null;

function initTranscriber() {
    if (transcriberWs && transcriberWs.readyState === WebSocket.OPEN) return;
    console.log('🌐 Conectando Transcriber (Gemini Flash Live)...');
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;
    transcriberWs = new WebSocket(url);
    transcriberWs.on('open', () => {
        console.log('✅ Transcriber conectado');
        transcriberWs.send(JSON.stringify({
            setup: {
                model: "models/gemini-2.5-flash-live-preview-09-2025",
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    inputAudioTranscription: {}
                }
            }
        }));
    });
    transcriberWs.on('message', (message) => {
        try {
            const response = JSON.parse(message);
            // La transcripción llega en serverContent.inputAudioTranscription
            if (response.serverContent?.inputAudioTranscription?.text) {
                const texto = response.serverContent.inputAudioTranscription.text;
                // Determinar si viene del navegador (tu) o de Twilio (proveedor)
                // Usamos una variable global simple: si el último audio enviado fue del navegador, es 'tu'; si fue de Twilio, 'proveedor'
                if (transcriberStreamSid === 'browser') {
                    guardarFragmento('tu', texto);
                } else if (transcriberStreamSid === 'twilio') {
                    guardarFragmento('proveedor', texto);
                }
            }
        } catch(e) { console.error('Error transcriber:', e); }
    });
    transcriberWs.on('close', () => { transcriberWs = null; });
    transcriberWs.on('error', (err) => console.error('Error transcriber WS:', err));
}

// ==================== WEBSOCKETS EXTERNOS ====================
wss.on('connection', (ws, req) => {
    const urlClara = new URL(req.url, `http://${req.headers.host}`);
    const pathname = urlClara.pathname;

    if (pathname === '/browser-stream') {
        console.log('🖥️ Navegador conectado');
        browserConnections.add(ws);
        initGeminiToEnglish();
        initTranscriber();  // Iniciar transcriber

        ws.on('message', (message) => {
            // Enviar audio al traductor (inglés)
            if (geminiWsToEnglish && geminiWsToEnglish.readyState === WebSocket.OPEN) {
                const ulawBuffer = Buffer.from(message.toString(), 'base64');
                const converted = twilioToGemini(ulawBuffer);
                geminiWsToEnglish.send(JSON.stringify({ realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm", data: converted }] } }));
            }
            // Enviar UNA COPIA al transcriber para obtener el texto
            if (transcriberWs && transcriberWs.readyState === WebSocket.OPEN) {
                transcriberStreamSid = 'browser';  // Marcar origen
                const ulawBuffer = Buffer.from(message.toString(), 'base64');
                const converted = twilioToGemini(ulawBuffer);
                transcriberWs.send(JSON.stringify({ realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm", data: converted }] } }));
            }
        });
        ws.on('close', () => { browserConnections.delete(ws); });
    }
    else if (pathname === '/media-stream') {
        console.log('📞 Twilio conectado');
        twilioWs = ws;
        initGeminiToSpanish();
        initTranscriber();

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                if (data.event === 'start') {
                    twilioStreamSid = data.start.streamSid;
                    console.log(`Stream Twilio: ${twilioStreamSid}`);
                }
                if (data.event === 'media') {
                    twilioPacketsIn++;
                    // Enviar al traductor (español)
                    if (geminiWsToSpanish && geminiWsToSpanish.readyState === WebSocket.OPEN) {
                        const converted = twilioToGemini(Buffer.from(data.media.payload, 'base64'));
                        geminiWsToSpanish.send(JSON.stringify({ realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm", data: converted }] } }));
                    }
                    // Enviar COPIA al transcriber
                    if (transcriberWs && transcriberWs.readyState === WebSocket.OPEN) {
                        transcriberStreamSid = 'twilio';
                        const converted = twilioToGemini(Buffer.from(data.media.payload, 'base64'));
                        transcriberWs.send(JSON.stringify({ realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm", data: converted }] } }));
                    }
                }
            } catch(err) { console.error(err); }
        });
        ws.on('close', () => { twilioWs = null; twilioStreamSid = null; });
    }
});
