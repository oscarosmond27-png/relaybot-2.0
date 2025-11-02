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
  const prompt = req.query.prompt || "";
  const loopFlag = req.query.loop === "1"; // <-- detect echo test
  const host = req.get("host");

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
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  let streamSid = null;
  oai.on("open", () => {
    oai.send(JSON.stringify({
      type: "session.update",
      session: {
        voice: "alloy",
        modalities: ["audio"],
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad" },
        instructions: `You are a friendly assistant. Deliver this message: ${prompt}. Keep it short and polite.`,
      },
    }));
    oai.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio"] } }));
  });

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.event === "start") streamSid = msg.start.streamSid;
    else if (msg.event === "media" && streamSid)
      oai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    else if (msg.event === "stop") { oai.close(); ws.close(); }
  });

  oai.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "response.audio.delta" && msg.delta && streamSid) {
        ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: msg.delta } }));
      }
    } catch {}
  });

  oai.on("close", () => ws.close());
  ws.on("close", () => oai.close());
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
