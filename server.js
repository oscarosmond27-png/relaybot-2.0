// server.js — All-in-one Render bot: GroupMe + Twilio + OpenAI voice
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
    const text = (req.body.text || "").trim();
    const senderType = req.body.sender_type || "";
    if (senderType === "bot") return res.send("ok");

    const m = text.match(/call\s+([\d\s\-\(\)\+]+)\s+(?:and\s+)?(?:tell|say|ask)\s+(.+)/i);
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

    const twimlUrl = `${process.env.BASE_URL}/twiml?prompt=${encodeURIComponent(prompt)}`;
    const call = await makeTwilioCall(to, twimlUrl);

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
  // Handle calls even if Twilio strips the extra parameters
  let prompt = req.query.prompt || "test";
  let loopFlag = req.query.loop === "1";
  const host = req.get("host");

  // Log what’s being served (for debugging)
  console.log("TwiML served for prompt:", prompt, "loop:", loopFlag);

  // If Twilio didn’t include &loop=1, we’ll just turn it on automatically
  if (!loopFlag) {
    console.log("No loop flag detected — forcing loop mode for safety.");
    loopFlag = true;
  }


  // Build WS URL and include loop=1 when requested
  let wsUrl = `wss://${host}/twilio?prompt=${encodeURIComponent(prompt)}`;
  if (loopFlag) wsUrl += "&loop=1";

  // Escape prompt for XML attribute
  const promptAttr = String(prompt).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Say>Hello, I have a quick message for you.</Say>` +
    `<Connect>` +
    `  <Stream url="wss://${host}/twilio">` +
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
  console.log("WS upgrade request:", req.url);
  if (req.url.startsWith("/twilio")) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log("WS upgraded to /twilio");
      handleTwilio(ws, req).catch(err => {
        console.error("handleTwilio error:", err);
        try { ws.close(); } catch {}
      });
    });
  } else {
    socket.destroy();
  }
});


async function handleTwilio(ws, req) {
  console.log("WS handler entered with URL:", req.url);

  // State we’ll fill once Twilio sends "start"
  let prompt = "test";
  let echoMode = false;
  let streamSid = null;
  let started = false;

  // OpenAI socket + state (created lazily after "start" if not echo)
  let oai = null;
  let oaiReady = false;

  // Helper to spin up OpenAI once (after "start")
  function ensureOpenAI() {
    if (oai) return; // already created

    oai = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview`,
      "realtime",
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1"
        }
      }
    );

    oai.on("open", () => {
      oai.send(JSON.stringify({
        type: "session.update",
        session: {
          voice: "alloy",
          modalities: ["audio"],
          input_audio_format: "g711_ulaw",   // Twilio -> us (we receive μ-law from Twilio)
          output_audio_format: "pcm16",      // OpenAI -> us (we’ll downsample + μ-law)
          turn_detection: { type: "server_vad" },
          instructions: `You are a friendly assistant speaking to a person on a phone call. Repeat back or respond clearly in natural English to: ${prompt}`
        }
      }));
      oai.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio"],
          audio: { format: "pcm16" },  // let OpenAI default to 16 kHz; we’ll resample
          instructions: `Deliver clearly and briefly: ${prompt}`
        }
      }));
    });


    // OpenAI -> Twilio (PCM16@8k -> μ-law)
    oai.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "response.audio.delta" && msg.delta && streamSid) {
          // Convert OpenAI PCM16@16k → PCM16@8k → μ-law → base64
          const muB64 = pcm16le16kToMulaw8k(msg.delta);
          ws.send(JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: muB64 }
          }));
        }
      } catch (err) {
        console.error("Error relaying OpenAI audio:", err);
      }
    });


    oai.on("close", () => { try { ws.close(); } catch {} });
  }

  // Single message handler to process connected -> start -> media -> stop
  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }

    if (msg.event === "connected") {
      // First event from Twilio Media Streams. Nothing to do yet.
      return;
    }

    if (msg.event === "start" && !started) {
      started = true;
      streamSid = msg.start?.streamSid || null;
      const cp = msg.start?.customParameters || {};
      if (typeof cp.prompt === "string" && cp.prompt.trim()) prompt = cp.prompt.trim();
      echoMode = (cp.loop === "1");

      console.log("Start received. prompt:", prompt, "echoMode:", echoMode);

      if (echoMode) {
        console.log("Loopback mode enabled");
        return; // stay in the same ws.on('message') handler; we’ll echo 'media' below
      } else {
        ensureOpenAI();
        return;
      }
    }

    if (msg.event === "media" && streamSid) {
      if (echoMode) {
        // Bounce caller audio back unchanged
        ws.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.media.payload }
        }));
      } else {
        // Forward to OpenAI only when ready
        if (oai && oaiReady && oai.readyState === WebSocket.OPEN) {
          oai.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: msg.media.payload
          }));
        }
      }
      return;
    }

    if (msg.event === "stop") {
      if (oai && oaiReady) {
        try { oai.send(JSON.stringify({ type: "input_audio_buffer.commit" })); } catch {}
        try { oai.close(); } catch {}
      }
      try { ws.close(); } catch {}
      return;
    }
  });

  ws.on("close", () => {
    try { if (oai) oai.close(); } catch {}
  });
}



// === Helper functions ===
function normalizePhone(s) {
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (s.startsWith("+")) return s;
  return null;
}

async function makeTwilioCall(to, twimlUrl) {
  const api = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Calls.json`;
  const params = new URLSearchParams({ To: to, From: process.env.TWILIO_FROM_NUMBER, Url: twimlUrl });
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
  return fetch(api, { method: "POST", headers: { Authorization: `Basic ${auth}` }, body: params });
}

async function sendGroupMe(text) {
  await fetch("https://api.groupme.com/v3/bots/post", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bot_id: process.env.GROUPME_BOT_ID, text }),
  });
}

// --- PCM16LE (8k) -> μ-law base64 for Twilio Stream ---
function pcm16leBase64ToMulawBase64(b64) {
  const buf = Buffer.from(b64, "base64");
  const out = Buffer.alloc(Math.floor(buf.length / 2));
  const BIAS = 0x84;

  for (let i = 0, j = 0; i + 1 < buf.length; i += 2, j++) {
    // little-endian 16-bit signed
    let sample = buf.readInt16LE(i); // -32768..32767
    let sign = (sample >> 8) & 0x80;
    if (sample < 0) sample = -sample;
    if (sample > 32635) sample = 32635;
    sample = sample + BIAS;

    // find exponent
    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) exponent--;

    // mantissa
    const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;

    // μ-law encode (invert bits)
    const mu = ~(sign | (exponent << 4) | mantissa) & 0xff;
    out[j] = mu;
  }
  return out.toString("base64");
}

// Downsample PCM16LE 16 kHz → 8 kHz, then μ-law encode for Twilio (base64)
function pcm16le16kToMulaw8k(b64) {
  const buf = Buffer.from(b64, "base64");
  // 16-bit little-endian samples → Int16 array
  const sampleCount16k = Math.floor(buf.length / 2);
  // Downsample by 2 (naive decimation): take every other sample
  const out8kCount = Math.floor(sampleCount16k / 2);

  // μ-law output bytes (1 byte per 8k sample)
  const out = Buffer.alloc(out8kCount);
  const BIAS = 0x84;

  let j = 0;
  for (let i = 0; i + 3 < buf.length; i += 4) {
    // Take every other sample: use the first of each 2-sample pair
    const sample = buf.readInt16LE(i); // little-endian 16-bit signed
    let s = sample;
    let sign = (s >> 8) & 0x80;
    if (s < 0) s = -s;
    if (s > 32635) s = 32635;
    s = s + BIAS;

    // exponent
    let exponent = 7;
    for (let expMask = 0x4000; (s & expMask) === 0 && exponent > 0; expMask >>= 1) exponent--;

    // mantissa
    const mantissa = (s >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;

    // μ-law encode (invert bits)
    const mu = ~(sign | (exponent << 4) | mantissa) & 0xff;
    out[j++] = mu;
  }
  return out.toString("base64");
}
