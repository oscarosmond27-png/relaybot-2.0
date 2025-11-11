// server.js — live GroupMe streaming + robust interleaving + per-turn transcription (cleaned)
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

  // Stream only inbound (caller) audio to us — avoids assistant playback in Whisper
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

  // Turn tracking
  const turns = [];            // [{role:'assistant'|'caller', text?}]
  const callerTurns = [];      // [{bytes, start, end}]
  let totalBytes = 0;          // cumulative inbound μ-law bytes
  let currentCallerBytes = 0;  // bytes since last caller turn
  let stopped = false;

  // Audio buffers
  let ulawChunks = [];
  let hasBufferedAudio = false;

  // OpenAI Realtime
  let oai = null;
  let oaiReady = false;

  // Debounce / single-flight
  let debounceTimer = null;
  let awaitingAssistant = false;

  // Tunables
  const DEBOUNCE_MS = 600;     // silence window to end caller turn
  const MIN_CALLER_BYTES = 2000; // ~0.25s @8kHz μ-law
  const LIVE_TO_GROUPME = true; // flip to false if you want to disable live streaming

  // Assistant text aggregation
  let currentAssistantText = "";
  let assistantTurnOpen = false;
  let assistantTranscript = "";
  let greeted = false;

  // === Live streaming helpers ===
  let assistantLiveBuf = "";

  async function emitAssistantIfBoundary() {
    if (!LIVE_TO_GROUPME) return;
    if (/[.!?]\s*$/.test(assistantLiveBuf) || assistantLiveBuf.length > 200) {
      const out = assistantLiveBuf.trim();
      if (out) await sendGroupMe(`Assistant: ${out}`);
      assistantLiveBuf = "";
    }
  }
  async function flushAssistantLive() {
    if (!LIVE_TO_GROUPME) return;
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
    if (idx !== -1) turns[idx].text = (currentAssistantText || "").trim();
  }

  function materializeCallerTurn() {
    if (currentCallerBytes < MIN_CALLER_BYTES) return false;
    const start = totalBytes - currentCallerBytes;
    const end = totalBytes;
    turns.push({ role: "caller" });
    callerTurns.push({ bytes: currentCallerBytes, start, end });

    // LIVE: transcribe and push this caller slice right now (fire-and-forget)
    transcribeAndSendCallerSlice(start, end).catch(e => console.error("live caller transcribe error:", e));

    currentCallerBytes = 0;
    return true;
  }

  function commitBufferedAudio() {
    if (!oai || !oaiReady || !hasBufferedAudio) return;
    try {
      oai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      hasBufferedAudio = false;
    } catch (e) {
      console.error("commit error:", e);
    }
  }

  function scheduleDebounce() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      commitBufferedAudio();
      if (materializeCallerTurn()) {
        closeAssistantTurn();
        maybeTriggerAssistant();
      }
    }, DEBOUNCE_MS);
  }

  function maybeTriggerAssistant() {
    if (!oai || !oaiReady || awaitingAssistant || stopped) return;
    awaitingAssistant = true;
    try {
      oai.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio", "text"] } }));
    } catch (e) {
      awaitingAssistant = false;
      console.error("response.create failed:", e);
    }
  }

  async function transcribeAndSendCallerSlice(start, end) {
    if (!LIVE_TO_GROUPME) return;
    const allUlaw = Buffer.concat(ulawChunks);
    const slice = allUlaw.subarray(start, end);
    if (!slice || slice.length < 800) return; // skip tiny noise

    const pcm16 = ulawToPcm16(slice);
    const wav = pcm16ToWav(pcm16, 8000);

    const fd = new FormData();
    fd.append("model", "whisper-1");
    fd.append("file", new Blob([wav], { type: "audio/wav" }), "live.wav");
    fd.append("temperature", "0");
    fd.append("language", "en");
    fd.append("response_format", "verbose_json");

    const tr = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: fd,
    });
    const tj = await tr.json();
    const cleaned = mergeWhisperSegmentsVerboseJson(tj);
    if (cleaned) await sendGroupMe(`Caller: ${cleaned}`);
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
          // no turn_detection; we orchestrate
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

    // Realtime streaming: send assistant partials live
    oai.on("message", async (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      const t = msg.type;

      if (t === "response.created") { openAssistantTurn(); return; }

      const isAudio = t === "response.audio.delta" || t === "response.output_audio.delta";
      if (isAudio && msg.delta && streamSid) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: msg.delta } }));
        }
      }

      if ((t === "response.audio_transcript.delta" || t === "response.output_text.delta") && msg.delta) {
        assistantTranscript += msg.delta;
        if (assistantTurnOpen) currentAssistantText += msg.delta;

        // LIVE: buffer and emit on boundaries
        if (LIVE_TO_GROUPME) {
          assistantLiveBuf += msg.delta;
          await emitAssistantIfBoundary();
        }
        return;
      }

      if (t === "response.completed" || t === "response.output_audio.done" || t === "response.error") {
        await flushAssistantLive(); // flush any trailing chunk
        closeAssistantTurn();
        awaitingAssistant = false; // allow next assistant response
        return;
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
      // inbound caller audio
      const chunk = Buffer.from(msg.media.payload, "base64");
      ulawChunks.push(chunk);
      totalBytes += chunk.length;
      currentCallerBytes += chunk.length;

      if (oai && oaiReady) {
        oai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
        hasBufferedAudio = true;
        // debounce end-of-turn on silence
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          commitBufferedAudio();
          if (materializeCallerTurn()) {
            closeAssistantTurn();
            maybeTriggerAssistant();
          }
        }, DEBOUNCE_MS);
      }
      return;
    }

    if (msg.event === "stop") {
      stopped = true;
      if (debounceTimer) clearTimeout(debounceTimer);

      // finalize any remaining caller audio
      commitBufferedAudio();
      materializeCallerTurn();

      // flush assistant turn
      await flushAssistantLive().catch(()=>{});
      closeAssistantTurn();

      try { if (oai && oai.readyState === WebSocket.OPEN) oai.close(); } catch {}

      // Final transcript build (non-live, for completeness + summary)
      // Transcribe each caller turn once more (cleanly) to ensure consistency
      const callerTexts = [];
      const allUlaw = Buffer.concat(ulawChunks);
      for (let i = 0; i < callerTurns.length; i++) {
        const { start, end } = callerTurns[i];
        const slice = allUlaw.subarray(start, end);
        if (!slice || slice.length < MIN_CALLER_BYTES / 2) {
          callerTexts.push("");
          continue;
        }
        const pcm16 = ulawToPcm16(slice);
        const wav = pcm16ToWav(pcm16, 8000);
        const fd = new FormData();
        fd.append("model", "whisper-1");
        fd.append("file", new Blob([wav], { type: "audio/wav" }), `turn_${i}.wav`);
        fd.append("temperature", "0");
        fd.append("language", "en");
        fd.append("response_format", "verbose_json");
        const tr = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          body: fd,
        });
        const tj = await tr.json();
        const cleaned = mergeWhisperSegmentsVerboseJson(tj);
        callerTexts.push(cleaned);
      }

      // Chronological transcript (assistant split smartly; caller 1:1)
      const chron = [];
      let callerIdx = 0;
      for (const t of turns) {
        if (t.role === "assistant") {
          const exploded = explodeTurnsSmart([t]);
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
        .join("\n");
      await sendGroupMe(`🗣️ Transcript\n${labeled}`);

      const base = chron
        .map((t) => `${t.role === "assistant" ? "Assistant" : "Caller"}: ${t.text}`)
        .join("\n")
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

// === Whisper cleaning helpers ===
function cleanCallerText(raw) {
  let t = String(raw || "").trim();
  t = t.replace(/\b(\w+)(\s+\1\b){1,}/gi, "$1");                 // "you you" -> "you"
  t = t.replace(/\b(\w+\s+\w+)(\s+\1\b){1,}/gi, "$1");            // 2-word repeat
  t = t.replace(/\b(\w+\s+\w+\s+\w+)(\s+\1\b){1,}/gi, "$1");      // 3-word repeat
  t = t.replace(/subscribe only the human caller.*?(audio\.)?/i, "");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}
function mergeWhisperSegmentsVerboseJson(json) {
  if (!json || !json.segments) return (json?.text || "").trim();
  const kept = json.segments.filter(seg => {
    const dur = Math.max(0, (seg.end || 0) - (seg.start || 0));
    const text = (seg.text || "").trim();
    if (!text) return false;
    if (seg.no_speech_prob !== undefined && seg.no_speech_prob > 0.6) return false;
    if (seg.avg_logprob !== undefined && seg.avg_logprob < -1.0) return false;
    if (dur < 0.45 && text.split(/\s+/).length <= 1) return false;
    return true;
  });
  let out = kept.map(s => s.text.trim()).join(" ");
  return cleanCallerText(out);
}

// === Text splitting/formatting ===
function normalizeTurnText(s) {
  return String(s || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}
function explodeTurnsSmart(turns) {
  const out = [];
  for (const t of turns) {
    const text = normalizeTurnText(t.text);
    if (!text) continue;

    const hasNewlines = /\n/.test(text);
    const parts = hasNewlines
      ? text.split(/\n+/).map(x => x.trim()).filter(Boolean)
      : splitIntoSentences(text);

    for (const part of parts) {
      if (part) out.push({ role: t.role, text: part });
    }
  }
  return out;
}
function splitIntoSentences(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  return (s.match(/[^.!?\n]+[.!?]?/g) || [s]).map((x) => x.trim()).filter(Boolean);
}
