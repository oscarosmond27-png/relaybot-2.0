// server.js — fixed join() newline syntax and improved chronological interleaving
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

  const turns = [];
  const callerTurns = [];

  let assistantTranscript = "";
  let ulawChunks = [];
  let hasBufferedAudio = false;
  let oai = null;
  let oaiReady = false;
  let commitTimer = null;
  const DEBOUNCE_MS = 700;

  let currentAssistantText = "";
  let assistantTurnOpen = false;

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
          turn_detection: { type: "server_vad" },
          instructions: "You are a friendly but concise phone agent.",
        },
      }));
      openAssistantTurn();
      oai.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: `Start with: \"Hello! I am Oscar's personal call assistant...\" and deliver: ${prompt}`,
        },
      }));
    });

    oai.on("message", (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      const t = msg.type;
      const isAudio = t === "response.audio.delta" || t === "response.output_audio.delta";
      if (isAudio && msg.delta && streamSid) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: msg.delta } }));
      }
      if (t === "response.created") { closeAssistantTurn(); openAssistantTurn(); }
      if ((t === "response.audio_transcript.delta" || t === "response.output_text.delta") && msg.delta) {
        assistantTranscript += msg.delta;
        if (assistantTurnOpen) currentAssistantText += msg.delta;
      }
      if (["response.completed", "response.output_audio.done", "response.error"].includes(t)) closeAssistantTurn();
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
      if (oai && oaiReady) {
        oai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
        hasBufferedAudio = true;
        if (commitTimer) clearTimeout(commitTimer);
        commitTimer = setTimeout(() => {
          try {
            if (hasBufferedAudio) {
              oai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
              hasBufferedAudio = false;
            }
            // Close any assistant turn that just finished speaking
            closeAssistantTurn();
            // Record a caller turn placeholder at this boundary
            turns.push({ role: "caller" });
            callerTurns.push({});
            // Ask assistant to respond (a new assistant turn will open on response.created)
            oai.send(JSON.stringify({
              type: "response.create",
              response: { modalities: ["audio", "text"] },
            }));
          } catch (err) {
            console.error("Commit/send error:", err);
          }
        }, DEBOUNCE_MS);
      }
      ulawChunks.push(Buffer.from(msg.media.payload, "base64"));
      return;
    }

    if (msg.event === "stop") {
      // ensure any in-progress assistant turn is flushed
      closeAssistantTurn();
      try { if (oai && oai.readyState === WebSocket.OPEN) oai.close(); } catch {}
      const ulaw = Buffer.concat(ulawChunks);
      let callerTranscript = "";

      if (ulaw.length) {
        const pcm16 = ulawToPcm16(ulaw);
        const wav = pcm16ToWav(pcm16, 8000);
        const fd = new FormData();
        fd.append("model", "whisper-1");
        fd.append("file", new Blob([wav], { type: "audio/wav" }), "call.wav");
        const tr = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          body: fd,
        });
        const tj = await tr.json();
        callerTranscript = (tj.text || "").trim();
      }

      const filledTurns = interleaveCallerText(turns, callerTranscript, callerTurns.length);
      const labeled = filledTurns
        .map((t) => {
          const line = (t.role === "assistant" ? `Assistant: ${t.text || ""}` : `Caller: ${t.text || ""}`).trim();
          return line.length ? line : null;
        })
        .filter(Boolean)
        .join('\\n');

      await sendGroupMe(`🗣️ Transcript
${labeled}`);

      const base = filledTurns
        .map((t) => `${t.role === 'assistant' ? 'Assistant' : 'Caller'}: ${t.text || ''}`)
        .join('\n')
        .trim();
      if (base.length > 30) {
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
    `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${streamUrl}">` +
    `<Parameter name="prompt" value="${safePrompt}"/><Parameter name="loop" value="0"/>` +
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

// === Audio conversion & interleaving ===
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
function splitIntoSentences(text) {
  const s = text.trim();
  if (!s) return [];
  return (s.match(/[^.!?\n]+[.!?]?/g) || [s]).map((x) => x.trim()).filter(Boolean);
}
function interleaveCallerText(turns, callerTranscript, callerTurnCount) {
  if (!callerTurnCount) return turns.map((t) => ({ ...t }));
  const sentences = splitIntoSentences(callerTranscript);
  if (!sentences.length) return turns.map((t) => ({ ...t }));
  const buckets = Array.from({ length: callerTurnCount }, () => []);
  for (let i = 0; i < sentences.length; i++) buckets[i % callerTurnCount].push(sentences[i]);
  let idx = 0;
  return turns.map((t) => t.role === "caller" ? { role: "caller", text: buckets[idx++].join(" ") } : { role: "assistant", text: t.text || "" });
}
