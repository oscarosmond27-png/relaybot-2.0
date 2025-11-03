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

  // Escape for XML attribute (& and " must be encoded)
  const wsAttr = wsUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Say>Hello, I have a quick message for you.</Say>` +
    `<Connect><Stream url="${wsAttr}" /></Connect>` +
    `</Response>`;
  console.log("TwiML served for prompt:", prompt, "loop:", loopFlag);
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
  const url = new URL(req.url, "https://example.com");
  const prompt = url.searchParams.get("prompt") || "";
  const loop = url.searchParams.get("loop") === "1";

  // Echo test: bounce caller audio back to caller (no OpenAI)
  if (loop) {
    let sid = null;
    ws.on("message", (buf) => {
      try {
        const msg = JSON.parse(buf.toString());
        if (msg.event === "start") {
          sid = msg.start?.streamSid;
        } else if (msg.event === "media" && sid) {
          ws.send(JSON.stringify({
            event: "media",
            streamSid: sid,
            media: { payload: msg.media.payload }
          }));
        } else if (msg.event === "stop") {
          try { ws.close(); } catch {}
        }
      } catch {}
    });
    return; // IMPORTANT: don’t connect to OpenAI in loopback
  }

  const oai = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview`,
    "realtime",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  let streamSid = null;
  let oaiReady = false;

  oai.on("open", () => {
    oai.send(JSON.stringify({
      type: "session.update",
      session: {
        voice: "alloy",
        modalities: ["audio"],
        input_audio_format: "g711_ulaw",   // Twilio -> us
        output_audio_format: "pcm16",      // OpenAI -> us (we convert to μ-law)
        sample_rate: 8000,
        turn_detection: { type: "server_vad" },
        instructions: `You are a friendly assistant speaking to a person on a phone call. Repeat back or respond clearly in natural English to: ${prompt}`,
      }
    }));
    oai.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio"],
        audio: { format: "pcm16", sample_rate: 8000 },
        instructions: `Deliver clearly and briefly: ${prompt}`
      }
    }));
  });


  // Twilio -> OpenAI (guard until OPEN)
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
      } else if (msg.event === "media" && streamSid) {
        if (oaiReady && oai.readyState === WebSocket.OPEN) {
          oai.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: msg.media.payload
          }));
        }
      } else if (msg.event === "stop") {
        try { oai.send(JSON.stringify({ type: "input_audio_buffer.commit" })); } catch {}
        try { oai.close(); } catch {}
        try { ws.close(); } catch {}
      }
    } catch (err) {
      console.error("Error handling Twilio message:", err);
    }
  });

  // OpenAI -> Twilio
  oai.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "response.audio.delta" && msg.delta && streamSid) {
        // Convert PCM16 (base64) -> μ-law (base64) for Twilio
        const muB64 = pcm16leBase64ToMulawBase64(msg.delta);
        ws.send(JSON.stringify({
          event: "media",
          streamSid: streamSid,
          media: { payload: muB64 }
        }));
      }
    } catch (err) {
      console.error("Error relaying OpenAI audio:", err);
    }
  });
  

  oai.on("close", () => { try { ws.close(); } catch {} });
  ws.on("close", () => { try { oai.close(); } catch {} });

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

