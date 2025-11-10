// server.js — fixed syntax issues, robust caller/assistant interleaving, cleaner turn lifecycle
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
    `<Stream url="${wsUrl}" track="inbound_track">` +
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
  const DEBOUNCE_MS = 500; // quicker interleave

  let currentCallerBytes = 0; // bytes since last commit for per-turn mapping
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
    if (idx !== -1) turns[idx].text = (currentAssistantText || "").trim();
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
          instructions: `Start with: "Hello! I am Oscar's personal call assistant..." and deliver: ${prompt}`,
        },
      }));
    });

    // ********** UPDATED TURN/INTERLEAVE LOGIC **********
    oai.on("message", (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      const t = msg.type;

      // If a new assistant response is created while caller audio is buffered,
      // force a commit and materialize a caller turn so it interleaves properly.
      if (t === "response.created") {
        try {
          if (hasBufferedAudio) {
            oai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            hasBufferedAudio = false;

            if (currentCallerBytes > 0) {
              turns.push({ role: "caller" });
              callerTurns.push({ bytes: currentCallerBytes });
              currentCallerBytes = 0;
            }
          }
        } catch (e) {
          console.error("forced commit on response.created failed:", e);
        }
        openAssistantTurn(); // ensure assistant turn is open
        return;
      }

      const isAudio = t === "response.audio.delta" || t === "response.output_audio.delta";
      if (isAudio && msg.delta && streamSid) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: msg.delta } }));
        }
      }

      if ((t === "response.audio_transcript.delta" || t === "response.output_text.delta") && msg.delta) {
        assistantTranscript += msg.delta;
        if (assistantTurnOpen) currentAssistantText += msg.delta;
        return;
      }

      if (t === "response.completed" || t === "response.output_audio.done" || t === "response.error") {
        closeAssistantTurn();
        return;
      }
    });
    // ********** END UPDATED LOGIC **********
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

    // ********** UPDATED MEDIA DEBOUNCE/COMMIT LOGIC **********
    if (msg.event === "media" && streamSid) {
      if (oai && oaiReady) {
        oai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
        hasBufferedAudio = true;

        // reset debounce timer
        if (commitTimer) clearTimeout(commitTimer);
        commitTimer = setTimeout(() => {
          try {
            if (hasBufferedAudio) {
              oai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
              hasBufferedAudio = false;
            }

            // Close any assistant turn that has finished
            closeAssistantTurn();

            // materialize caller turn from accumulated bytes
            if (currentCallerBytes > 0) {
              turns.push({ role: "caller" });
              callerTurns.push({ bytes: currentCallerBytes });
              currentCallerBytes = 0;
            }

            // prompt assistant to respond; assistant turn opens on response.created
            oai.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio", "text"] } }));
          } catch (err) {
            console.error("Commit/send error:", err);
          }
        }, DEBOUNCE_MS);
      }

      const chunk = Buffer.from(msg.media.payload, "base64");
      ulawChunks.push(chunk);
      currentCallerBytes += chunk.length;
      return;
    }
    // ********** END UPDATED MEDIA LOGIC **********

    if (msg.event === "stop") {
      // ensure any in-progress assistant turn is flushed
      closeAssistantTurn();

      // attribute any remaining caller bytes
      if (currentCallerBytes > 0) {
        turns.push({ role: "caller" });
        callerTurns.push({ bytes: currentCallerBytes });
        currentCallerBytes = 0;
      }

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

      // Build caller texts proportionally to audio bytes per turn
      const callerTexts = distributeByBytes(callerTranscript, callerTurns);
      let callerIdx = 0;

      // explode assistant multi-line turns; for caller, map proportional text
      const chron = [];
      for (const t of turns) {
        if (t.role === "assistant") {
          const exploded = explodeTurnsByNewlines([t]);
          for (const e of exploded) if (e.text) chron.push(e);
        } else {
          const txt = normalizeTurnText(callerTexts[callerIdx++] || "");
          if (!txt) continue;
          const lines = txt.split(/\n+/).map(x => x.trim()).filter(Boolean);
          for (const line of lines) chron.push({ role: "caller", text: line });
        }
      }

      const labeled = chron
        .map((t) => `${t.role === "assistant" ? "Assistant" : "Caller"}: ${t.text}`)
        .join('\n');

      await sendGroupMe(`🗣️ Transcript\n${labeled}`);

      const base = chron
        .map((t) => `${t.role === 'assistant' ? 'Assistant' : 'Caller'}: ${t.text}`)
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
    `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${streamUrl}" track="inbound_track">` +
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

// Keep newlines as real \n, collapse whitespace
function normalizeTurnText(s) {
  return String(s || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function explodeTurnsByNewlines(turns) {
  const out = [];
  for (const t of turns) {
    const text = normalizeTurnText(t.text);
    if (!text) continue;
    const lines = text.split(/\n+/).map(x => x.trim()).filter(Boolean);
    for (const line of lines) out.push({ role: t.role, text: line });
  }
  return out;
}

function splitIntoSentences(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  // Greedy-ish sentence splitting that respects ?, !, . and newlines
  return (s.match(/[^.!?\n]+[.!?]?/g) || [s]).map((x) => x.trim()).filter(Boolean);
}

// Distribute caller sentences to turns in proportion to captured bytes per turn
function distributeByBytes(text, buckets) {
  const sentences = splitIntoSentences(String(text || '').replace(/\n+/g, ' '));
  if (!sentences.length || !buckets?.length) return (buckets || []).map(() => "");
  const totalBytes = buckets.reduce((a, b) => a + (b?.bytes || 0), 0) || 1;
  const targets = buckets.map(b => ((b?.bytes || 0) / totalBytes) * sentences.length);

  // Largest-remainder allocation
  const baseCounts = targets.map(x => Math.floor(x));
  let assigned = baseCounts.reduce((a, b) => a + b, 0);
  const remainders = targets
    .map((x, i) => ({ i, r: x - Math.floor(x) }))
    .sort((a, b) => b.r - a.r);
  for (let k = 0; assigned < sentences.length && k < remainders.length; k++) {
    baseCounts[remainders[k].i]++; assigned++;
  }

  // Slice sentences in order
  const out = [];
  let cursor = 0;
  for (let i = 0; i < buckets.length; i++) {
    const n = Math.max(0, baseCounts[i] | 0);
    out.push(sentences.slice(cursor, cursor + n).join(' ').trim());
    cursor += n;
  }
  // In case of any leftover due to rounding, append to last
  if (cursor < sentences.length && out.length) {
    out[out.length - 1] += (out[out.length - 1] ? ' ' : '') + sentences.slice(cursor).join(' ');
  }
  return out;
}
