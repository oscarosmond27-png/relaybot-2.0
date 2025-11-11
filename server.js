// server.js — uses GPT-4o's built-in realtime transcription + live GroupMe streaming
import express from "express";
import fetch, { FormData, Blob } from "node-fetch";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
app.use(express.json());

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

    // === Handle hang-up commands ===
    if (/^(end|hang ?up|stop) call/i.test(text)) {
      if (!global.currentTwilioCallSid) {
        await sendGroupMe("No active call to end.");
        return res.send("ok");
      }
      const sid = global.currentTwilioCallSid;
      global.currentTwilioCallSid = null;
    
      const api = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Calls/${sid}.json`;
      const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
    
      await fetch(api, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ Status: "completed" }),
      });
    
      await sendGroupMe("☎️ Call ended.");
      return res.send("ok");
    }

    
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

// === TwiML endpoint ===
app.get("/twiml", (req, res) => {
  let prompt = req.query.prompt || "test";
  let loopFlag = req.query.loop === "1";
  const host = req.get("host");

  if (!loopFlag) loopFlag = true;

  const wsUrl = `wss://${host}/twilio`;
  const promptAttr = String(prompt).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Connect>` +
    `<Stream url="${wsUrl}" track="inbound_track">` +
    `<Parameter name="prompt" value="${promptAttr}"/>` +
    `<Parameter name="loop" value="${loopFlag ? "1" : "0"}"/>` +
    `</Stream>` +
    `</Connect></Response>`;

  res.set("Content-Type", "text/xml").send(xml);
});

const server = app.listen(process.env.PORT || 10000, () =>
  console.log("Server listening on", server.address().port)
);

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/twilio")) {
    wss.handleUpgrade(req, socket, head, (ws) => handleTwilio(ws, req));
  } else {
    socket.destroy();
  }
});

async function handleTwilio(ws, req) {
  let prompt = "test";
  let streamSid = null;
  let started = false;
  let stopped = false;

  const turns = [];
  const callerTurns = [];
  let totalBytes = 0;
  let currentCallerBytes = 0;
  const DEBOUNCE_MS = 600;
  const MIN_CALLER_BYTES = 2000;
  const LIVE_TO_GROUPME = true;

  let ulawChunks = [];
  let oai = null;
  let oaiReady = false;
  let debounceTimer = null;
  let awaitingAssistant = false;

  let currentAssistantText = "";
  let assistantTurnOpen = false;
  let assistantTranscript = "";
  let greeted = false;
  let assistantLiveBuf = "";

  async function emitAssistantIfBoundary() {
    if (!LIVE_TO_GROUPME) return;
    if (/[.!?]\s*$/.test(assistantLiveBuf) || assistantLiveBuf.length > 200) {
      const out = assistantLiveBuf.trim();
      assistantLiveBuf = "";
      if (!out) return;
      if (emitAssistantIfBoundary.lastSent === out) return;
      emitAssistantIfBoundary.lastSent = out;
      await sendGroupMe(`Assistant: ${out}`);
    }
  }
  async function flushAssistantLive() {
    const out = assistantLiveBuf.trim();
    if (out) await sendGroupMe(`Assistant: ${out}`);
    assistantLiveBuf = "";
  }

  function openAssistantTurn() {
    if (assistantTurnOpen) return;
    assistantTurnOpen = true;
    currentAssistantText = "";
    turns.push({ role: "assistant" });
  }
  function closeAssistantTurn() {
    if (!assistantTurnOpen) return;
    assistantTurnOpen = false;
    const idx = turns.findIndex((t) => t.role === "assistant" && !t.text);
    if (idx !== -1) turns[idx].text = currentAssistantText.trim();
  }

  function ensureOpenAI() {
    if (oai) return;

    oai = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview",
      "realtime",
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
    );

    oai.on("open", () => {
      oaiReady = true;
      oai.send(JSON.stringify({
        type: "session.update",
        session: {
          voice: "ash",
          modalities: ["audio", "text"],
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
          instructions: "You are a friendly but concise phone agent.",
        },
      }));

      if (!greeted) {
        greeted = true;
        openAssistantTurn();
        awaitingAssistant = true;
        oai.send(JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            instructions: `Hello! I am Oscar's personal call assistant. ${prompt}`,
          },
        }));
      }
    });

    // === Handle Realtime events ===
    oai.on("message", async (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      const t = msg.type;

      // --- Caller live transcription from model ---
      if (t === "input_audio_transcription.delta" && msg.delta) {
        const text = msg.delta.trim();
        if (text && LIVE_TO_GROUPME) {
          if (handleTwilio.lastCallerSent !== text) {
            handleTwilio.lastCallerSent = text;
            await sendGroupMe(`Caller: ${text}`);
          }
        }
        return;
      }

      if (t === "input_audio_transcription.completed" && msg.text) {
        const text = msg.text.trim();
        if (text && LIVE_TO_GROUPME) await sendGroupMe(`Caller: ${text}`);
        return;
      }

      if (t === "response.created") { openAssistantTurn(); return; }

      const isAudio = t === "response.audio.delta" || t === "response.output_audio.delta";
      if (isAudio && msg.delta && streamSid) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: msg.delta } }));
        }
      }

      if (t === "response.output_text.delta" && msg.delta) {
        assistantTranscript += msg.delta;
        if (assistantTurnOpen) currentAssistantText += msg.delta;
        if (LIVE_TO_GROUPME) {
          assistantLiveBuf += msg.delta;
          await emitAssistantIfBoundary();
        }
        return;
      }

      if (t === "response.completed" || t === "response.output_audio.done" || t === "response.error") {
        await flushAssistantLive();
        closeAssistantTurn();
        awaitingAssistant = false;
      }
    });
  }

  ws.on("message", async (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.event === "start" && !started) {
      started = true;
      streamSid = msg.start?.streamSid;
      const cp = msg.start?.customParameters || {};
      if (cp.prompt) prompt = cp.prompt.trim();
      ensureOpenAI();
      return;
    }

    if (msg.event === "media" && streamSid) {
      const chunk = Buffer.from(msg.media.payload, "base64");
      ulawChunks.push(chunk);
      totalBytes += chunk.length;
      currentCallerBytes += chunk.length;

      if (oai && oaiReady) {
        oai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          try {
            oai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          } catch {}
        }, DEBOUNCE_MS);
      }
      return;
    }

    if (msg.event === "stop") {
      stopped = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      try { oai?.close(); } catch {}
      await flushAssistantLive();
      closeAssistantTurn();

      // still run end-of-call Whisper for final transcript + summary
      const allUlaw = Buffer.concat(ulawChunks);
      const fd = new FormData();
      fd.append("model", "whisper-1");
      fd.append("file", new Blob([pcm16ToWav(ulawToPcm16(allUlaw), 8000)], { type: "audio/wav" }), "call.wav");
      const tr = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: fd,
      });
      const tj = await tr.json();
      const callerTranscript = (tj.text || "").trim();

      const labeled = [
        "🗣️ Transcript",
        `Caller: ${callerTranscript}`,
        `Assistant: ${assistantTranscript.trim()}`,
      ].join("\n");
      await sendGroupMe(labeled);

      if (callerTranscript.length > 30 || assistantTranscript.length > 30) {
        const base = `Caller: ${callerTranscript}\nAssistant: ${assistantTranscript}`;
        const summaryResponse = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: "You summarize phone calls in 2–3 sentences." },
              { role: "user", content: base },
            ],
          }),
        });
        const data = await summaryResponse.json();
        const summary = data.choices?.[0]?.message?.content?.trim();
        if (summary) await sendGroupMe(`📝 Summary: ${summary}`);
      }

      try { ws.close(); } catch {}
    }
  });
}

// === Helpers ===
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
    `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${streamUrl}" track="inbound_track">` +
    `<Parameter name="prompt" value="${safePrompt}"/><Parameter name="loop" value="0"/>` +
    `</Stream></Connect></Response>`;
  const body = new URLSearchParams({ To: to, From: process.env.TWILIO_FROM_NUMBER, Twiml: twiml });
  const response = await fetch(api, { method: "POST", headers: { Authorization: `Basic ${auth}` }, body });
  const data = await response.json();
  
  // Store the current call SID so we can end it later
  if (data.sid) global.currentTwilioCallSid = data.sid;
  
  return response;

  
}

async function sendGroupMe(text) {
  await fetch("https://api.groupme.com/v3/bots/post", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bot_id: process.env.GROUPME_BOT_ID, text }),
  });
}

// === Audio conversion ===
function ulawByteToLinearSample(uVal) {
  const MULAW_BIAS = 0x84;
  uVal = ~uVal & 0xff;
  const sign = uVal & 0x80;
  const exponent = (uVal & 0x70) >> 4;
  const mantissa = uVal & 0x0f;
  let sample = ((mantissa << 4) + 0x08) << (exponent + 3);
  sample -= MULAW_BIAS;
  if (sign) sample = -sample;
  return Math.max(-32768, Math.min(32767, sample));
}
function ulawToPcm16(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = ulawByteToLinearSample(buf[i]);
  return out;
}
function pcm16ToWav(pcm16, rate = 8000) {
  const ch = 1, bps = 2, dataSize = pcm16.length * bps;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * ch * bps, 28);
  buf.writeUInt16LE(ch * bps, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < pcm16.length; i++) buf.writeInt16LE(pcm16[i], 44 + i * 2);
  return buf;
}
