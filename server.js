// server.js — All-in-one Render bot: GroupMe + Twilio + OpenAI voice (with transcript sent to GroupMe)
import express from "express";
import fetch from "node-fetch";
import { WebSocketServer, WebSocket } from "ws";
// Using Node 18+ built-in FormData (no extra package needed)

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

// === TwiML for Twilio ===
app.get("/twiml", (req, res) => {
  let prompt = req.query.prompt || "test";
  let loopFlag = req.query.loop === "1";
  const host = req.get("host");

  console.log("TwiML served for prompt:", prompt, "loop:", loopFlag);

  if (!loopFlag) {
    console.log("No loop flag detected — forcing loop mode for safety.");
    loopFlag = true;
  }

  const wsUrl = `wss://${host}/twilio`;
  const promptAttr = String(prompt).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Connect>` +
    `  <Stream url="${wsUrl}">` +
    `    <Parameter name="prompt" value="${promptAttr}"/>` +
    `    <Parameter name="loop" value="${loopFlag ? "1" : "0"}"/>` +
    `  </Stream>` +
    `</Connect>` +
    `</Response>`;

  res.set("Content-Type", "text/xml").send(xml);
});

// === WebSocket audio bridge (Twilio <-> OpenAI) ===
const server = app.listen(process.env.PORT || 10000, () =>
  console.log("Server listening on", server.address().port)
);
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/twilio")) {
    wss.handleUpgrade(req, socket, head, (ws) => {
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
  let prompt = "test";
  let echoMode = false;
  let streamSid = null;
  let started = false;

  const mulawChunks = [];

  let oai = null;
  let oaiReady = false;
  let commitTimer = null;
  const DEBOUNCE_MS = 700;

  function ensureOpenAI() {
    if (oai) return;

    oai = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview`,
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
      oai.send(JSON.stringify({
        type: "session.update",
        session: {
          voice: "alloy",
          modalities: ["audio", "text"],
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "server_vad" },
          instructions: "You are a friendly phone agent. Speak ONLY in clear American English. Be concise and natural. Do not add extra questions or follow-ups.",
        },
      }));
      oai.send(JSON.stringify({
        type: "response.create",
        response: { modalities: ["audio", "text"], instructions: prompt },
      }));
    });

    oai.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const isDelta =
          msg.type === "response.audio.delta" || msg.type === "response.output_audio.delta";
        if (isDelta && msg.delta && streamSid) {
          ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: msg.delta } }));
        }
      } catch (err) {
        console.error("Error relaying OpenAI audio:", err);
      }
    });

    oai.on("error", (err) => console.error("OpenAI WS error:", err));
    oai.on("close", () => { try { ws.close(); } catch {} });
  }

  ws.on("message", async (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.event === "start" && !started) {
      started = true;
      streamSid = msg.start?.streamSid || null;
      const cp = msg.start?.customParameters || {};
      if (typeof cp.prompt === "string" && cp.prompt.trim()) prompt = cp.prompt.trim();
      echoMode = cp.loop === "1";
      if (!echoMode) ensureOpenAI();
      return;
    }

    if (msg.event === "media" && streamSid) {
      if (msg.media?.payload) {
        try { mulawChunks.push(Buffer.from(msg.media.payload, "base64")); } catch {}
      }
      if (!echoMode && oai && oaiReady && oai.readyState === WebSocket.OPEN) {
        oai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
        if (commitTimer) clearTimeout(commitTimer);
        commitTimer = setTimeout(() => {
          try {
            oai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            oai.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio", "text"] } }));
          } catch (err) { console.error("Commit/send error:", err); }
        }, DEBOUNCE_MS);
      }
      return;
    }

    if (msg.event === "stop") {
      try {
        if (oai && oaiReady) {
          try { oai.send(JSON.stringify({ type: "input_audio_buffer.commit" })); } catch {}
          try { oai.close(); } catch {}
        }
        if (mulawChunks.length) {
          const mulawBuffer = Buffer.concat(mulawChunks);
          const wavBuffer = mulawToWavPcm16Mono8k(mulawBuffer);
          const transcript = await openaiTranscribeWav(wavBuffer);
          if (transcript) {
            await sendGroupMe(`🗣️ Transcript from call: ${transcript}`);
          }
        }
      } catch (e) {
        console.error("stop handler error:", e);
      }
      try { ws.close(); } catch {}
      return;
    }
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
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const safePrompt = String(promptText).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const streamUrl = `wss://${process.env.BASE_HOST || "relaybot-2-0.onrender.com"}/twilio`;
  const twiml =
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Connect><Stream url="${streamUrl}">` +
    `<Parameter name="prompt" value="${safePrompt}"/>` +
    `<Parameter name="loop" value="0"/>` +
    `</Stream></Connect></Response>`;
  const body = new URLSearchParams({ To: to, From: process.env.TWILIO_FROM_NUMBER, Twiml: twiml });
  return fetch(api, { method: "POST", headers: { Authorization: `Basic ${auth}` }, body });
}

async function sendGroupMe(text) {
  await fetch("https://api.groupme.com/v3/bots/post", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bot_id: process.env.GROUPME_BOT_ID, text }),
  });
}

function mulawToWavPcm16Mono8k(muBuf) {
  const pcm = Buffer.alloc(muBuf.length * 2);
  for (let i = 0; i < muBuf.length; i++) {
    const s = mulawDecodeSample(muBuf[i]);
    pcm.writeInt16LE(s, i * 2);
  }
  const wavHeader = makeWavHeader({ sampleRate: 8000, channels: 1, bytesPerSample: 2, dataLength: pcm.length });
  return Buffer.concat([wavHeader, pcm]);
}

function mulawDecodeSample(mu) {
  mu = ~mu & 0xff;
  const sign = mu & 0x80;
  let exponent = (mu >> 4) & 0x07;
  let mantissa = mu & 0x0f;
  let sample = ((mantissa << 4) + 0x08) << (exponent + 3);
  sample -= 0x84;
  if (sign) sample = -sample;
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
  buffer.writeUInt16LE(1, 20);
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
  const form = new FormData();
  form.append("file", wavBuffer, { filename: "call.wav", contentType: "audio/wav" });
  form.append("model", "whisper-1");
  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!resp.ok) return "";
  const json = await resp.json();
  return json.text || "";
}
