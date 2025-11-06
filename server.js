// server.js — GroupMe + Twilio + OpenAI voice (cleaned, with full transcription)
import express from "express";
import fetch from "node-fetch";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
app.use(express.json());

// Health check
app.get("/", (_req, res) => res.type("text/plain").send("OK"));

// === GroupMe webhook ===
app.post("/groupme", async (req, res) => {
  try {
    if (process.env.GROUPME_SHARED_SECRET) {
      if (req.get("x-shared-secret") !== process.env.GROUPME_SHARED_SECRET) {
        return res.status(403).send("forbidden");
      }
    }

    const text = (req.body?.text || "").trim();
    const senderType = req.body?.sender_type || "";
    if (senderType === "bot") return res.send("ok");

    const m = text
      .replace(/[.,!?]$/i, "")
      .match(/call\s+([\d\s\-\(\)\+]+)\s*(?:,|\s+)?(?:and\s+)?(?:tell|say|ask)\s+(.+)/i);

    if (!m) {
      await sendGroupMe("Try: call 4355551212 and tell Dr. Lee the results are ready.");
      return res.send("ok");
    }

    const to = normalizePhone(m[1]);
    const prompt = m[2].trim();

    if (!to) {
      await sendGroupMe(`Could not find a valid phone number in "${m[1].trim()}"`);
      return res.send("ok");
    }

    const call = await makeTwilioCallWithTwiml(to, prompt);

    if (!call.ok) {
      await sendGroupMe("Twilio call failed.");
      return res.send("ok");
    }

    await sendGroupMe(`Calling ${to} now and saying: "${prompt}"`);
    res.send("ok");
  } catch (e) {
    console.error(e);
    res.status(500).send("error");
  }
});

// === TwiML for Twilio (voice instructions) ===
app.get("/twiml", (req, res) => {
  let prompt = req.query.prompt || "test";
  let loopFlag = req.query.loop === "1";
  const host = req.get("host");

  if (!loopFlag) loopFlag = true;

  const wsUrl = `wss://${host}/twilio`;
  const promptAttr = String(prompt).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Connect>` +
    `<Stream url="${wsUrl}">` +
    `<Parameter name="prompt" value="${promptAttr}"/>` +
    `<Parameter name="loop" value="${loopFlag ? "1" : "0"}"/>` +
    `</Stream>` +
    `</Connect>` +
    `</Response>`;

  res.set("Content-Type", "text/xml").send(xml);
});

// === WebSocket bridge (Twilio <-> OpenAI Realtime) ===
const server = app.listen(process.env.PORT || 10000, () =>
  console.log("Server listening on", server.address().port)
);

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  console.log("WS upgrade request:", req.url);
  if (req.url.startsWith("/twilio")) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log("WS upgraded to /twilio");
      handleTwilio(ws, req).catch((err) => {
        console.error("handleTwilio error:", err);
        try { ws.close(); } catch {}
      });
    });
  } else {
    socket.destroy();
  }
});

async function handleTwilio(ws, req) {
  console.log("WS handler entered:", req.url);

  let prompt = "test";
  let echoMode = false;
  let streamSid = null;
  let started = false;

  // collect all caller audio (μ-law) so we can transcribe with Whisper later
  const mulawChunks = [];

  // OpenAI realtime socket state
  let oai = null;
  let oaiReady = false;
  let commitTimer = null;
  let hasBufferedAudio = false;
  const DEBOUNCE_MS = 700;

  function ensureOpenAI() {
    if (oai) return;

    oai = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview",
      "realtime",
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    oai.on("open", () => {
      oaiReady = true;
      // session config
      oai.send(JSON.stringify({
        type: "session.update",
        session: {
          voice: "ash",                       // you can change voices here
          modalities: ["audio", "text"],
          input_audio_format: "g711_ulaw",    // Twilio -> us
          output_audio_format: "g711_ulaw",   // us -> Twilio
          turn_detection: { type: "server_vad" },
          instructions: "You are a friendly but concise phone agent. Speak in clear American English. Keep calls under 2 minutes.",
        },
      }));
      // opening line + your message
      oai.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: `Start the call by saying: "Hello! I am Oscar's personal call assistant. Oscar has a message for you. He says: " Then clearly deliver this message: "${prompt}". Speak warmly but professionally, like a real assistant making a quick call. After finishing, pause to allow the person to respond. Remember that you are not an AI; you are a person hired to make calls. Do not add extra small talk.`,
        },
      }));
    });

    // stream OpenAI audio back to Twilio
    oai.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      const t = msg.type;
      const isAudio =
        t === "response.audio.delta" || t === "response.output_audio.delta";
      if (isAudio && msg.delta && streamSid && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.delta },
        }));
      }
    });

    oai.on("error", (err) => console.error("OpenAI WS error:", err));
    oai.on("close", () => console.log("OpenAI socket closed"));
  }

  ws.on("message", async (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.event === "connected") return;

    if (msg.event === "start" && !started) {
      started = true;
      streamSid = msg.start?.streamSid || null;
      const cp = msg.start?.customParameters || {};
      if (typeof cp.prompt === "string" && cp.prompt.trim()) prompt = cp.prompt.trim();
      echoMode = cp.loop === "1";
      console.log("Start received. prompt:", prompt);
      ensureOpenAI();
      return;
    }

    if (msg.event === "media" && streamSid) {
      // keep a copy of raw μ-law from Twilio so we can transcribe later
      if (msg.media?.payload) {
        try { mulawChunks.push(Buffer.from(msg.media.payload, "base64")); } catch {}
      }

      // forward to OpenAI in realtime
      if (oai && oaiReady && oai.readyState === WebSocket.OPEN) {
        oai.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload,
        }));
        hasBufferedAudio = true;

        if (commitTimer) clearTimeout(commitTimer);
        commitTimer = setTimeout(() => {
          try {
            if (hasBufferedAudio) {
              oai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
              hasBufferedAudio = false;
            }
            oai.send(JSON.stringify({
              type: "response.create",
              response: { modalities: ["audio", "text"] },
            }));
          } catch (err) {
            console.error("Commit/send error:", err);
          }
        }, DEBOUNCE_MS);
      }
      return;
    }

    if (msg.event === "stop") {
      console.log("Call stopped. Building full transcript…");

      // close realtime socket (we've got the audio captured)
      try { if (oai && oai.readyState === WebSocket.OPEN) oai.close(); } catch {}

      try {
        if (mulawChunks.length) {
          // convert μ-law to WAV (PCM16 mono 8k) for Whisper
          const mulawBuffer = Buffer.concat(mulawChunks);
          const wavBuffer = mulawToWavPcm16Mono8k(mulawBuffer);
          const transcript = await openaiTranscribeWav(wavBuffer);

          if (transcript && transcript.trim().length) {
            await sendGroupMe(`🗣️ Full call transcript:\n${transcript.trim()}`);
          } else {
            await sendGroupMe("🗣️ Transcript unavailable (empty result).");
          }
        } else {
          await sendGroupMe("🗣️ Transcript unavailable (no audio).");
        }
      } catch (err) {
        console.error("Transcription error:", err);
        await sendGroupMe("🗣️ Transcript failed due to an error.");
      }

      try { ws.close(); } catch {}
      return;
    }
  });

  ws.on("error", (err) => console.error("Twilio WS error:", err));
  ws.on("close", () => {
    try { if (oai && oai.readyState === WebSocket.OPEN) oai.close(); } catch {}
  });
}

// === Helper functions ===
function normalizePhone(s) {
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (/^\+\d{8,15}$/.test(s)) return s;
  return null;
}

async function makeTwilioCallWithTwiml(to, promptText) {
  const api = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Calls.json`;
  const auth = Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString("base64");

  const safePrompt = String(promptText).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const streamUrl = `wss://${process.env.BASE_HOST || "relaybot-2-0.onrender.com"}/twilio`;

  const twiml =
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Connect><Stream url="${streamUrl}">` +
    `<Parameter name="prompt" value="${safePrompt}"/>` +
    `<Parameter name="loop" value="0"/>` +
    `</Stream></Connect></Response>`;

  const body = new URLSearchParams({
    To: to,
    From: process.env.TWILIO_FROM_NUMBER,
    Twiml: twiml,
  });

  return fetch(api, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}` },
    body,
  });
}

async function sendGroupMe(text) {
  await fetch("https://api.groupme.com/v3/bots/post", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bot_id: process.env.GROUPME_BOT_ID, text }),
  });
}

// === μ-law -> WAV (PCM16 mono 8k) and Whisper ===
function mulawToWavPcm16Mono8k(muBuf) {
  const pcm = Buffer.alloc(muBuf.length * 2);
  for (let i = 0; i < muBuf.length; i++) {
    const s = mulawDecodeSample(muBuf[i]);
    pcm.writeInt16LE(s, i * 2);
  }
  const wavHeader = makeWavHeader({
    sampleRate: 8000,
    channels: 1,
    bytesPerSample: 2,
    dataLength: pcm.length,
  });
  return Buffer.concat([wavHeader, pcm]);
}

function mulawDecodeSample(u) {
  // Standard G.711 μ-law decode (16-bit PCM)
  u = (~u) & 0xFF;

  // Build magnitude
  let t = ((u & 0x0F) << 3) + 0x84;          // 0x84 is the bias (132)
  t <<= ((u & 0x70) >> 4);                   // exponent shift

  // Apply sign and final bias
  let sample = (u & 0x80) ? (0x84 - t) : (t - 0x84);

  // Defensive clamp to int16 (prevents Buffer.writeInt16LE range errors)
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;

  return sample;
}

function makeWavHeader({ sampleRate, channels, bytesPerSample, dataLength }) {
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bytesPerSample * 8, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

async function openaiTranscribeWav(wavBuffer) {
  if (!process.env.OPENAI_API_KEY) return "";

  // Node 18+ has a global FormData (from undici), so we can use it directly.
  const form = new FormData();
  form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "call.wav");
  form.append("model", "whisper-1");

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });

  if (!resp.ok) {
    console.error("Whisper HTTP error:", resp.status, await resp.text());
    return "";
  }
  const json = await resp.json();
  return json.text || "";
}
