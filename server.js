// server.js — GroupMe + Twilio + OpenAI voice with speaker-labeled transcripts
import express from "express";
import fetch, { FormData, Blob } from "node-fetch";
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

  // Chronological turns (placeholders, then filled at end)
  // Each entry: { role: 'assistant'|'caller', text?: string }
  const turns = [];
  const callerTurns = []; // placeholders for caller chunks (indices map to turns entries)

  // Speaker-labeled capture
  let assistantTranscript = "";           // total assistant words (still kept for summary)
  let ulawChunks = [];                    // caller μ-law frames (base64 -> Buffer)

  // Realtime plumbing
  let hasBufferedAudio = false;
  let oai = null;
  let oaiReady = false;
  let commitTimer = null;
  const DEBOUNCE_MS = 700;

  // Track assistant response boundaries for proper turn segmentation
  let currentAssistantText = "";
  let assistantTurnOpen = false;

  function openAssistantTurn() {
    if (assistantTurnOpen) return; // avoid double-open
    assistantTurnOpen = true;
    currentAssistantText = "";
    turns.push({ role: "assistant" });
  }
  function closeAssistantTurn() {
    if (!assistantTurnOpen) return;
    assistantTurnOpen = false;
    const idx = turns.findIndex((t) => t.role === "assistant" && t.text === undefined);
    if (idx !== -1) turns[idx].text = currentAssistantText.trim();
  }

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
      oai.send(JSON.stringify({
        type: "session.update",
        session: {
          voice: "ash",
          modalities: ["audio", "text"],
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "server_vad" },
          instructions:
            "You are a friendly but concise phone agent. Keep responses short, natural, and never mention AI or internal tools.",
        },
      }));
      // First assistant intro -> open a turn now
      openAssistantTurn();
      oai.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: `Start with: "Hello! I am Oscar's personal call assistant. Oscar has a message for you." Then clearly deliver this message: "${prompt}". Pause and listen. Keep the rest of the conversation brief, natural, and helpful. Do not mention AI or system details.`,
        },
      }));
    });

    oai.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      const t = msg.type;
      const isAudio = t === "response.audio.delta" || t === "response.output_audio.delta";
      if (isAudio && msg.delta && streamSid) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: msg.delta },
          }));
        }
      }

      // Assistant transcript boundaries & deltas
      if (t === "response.created") {
        // A new assistant response is starting -> open a new assistant turn
        openAssistantTurn();
      }
      if ((t === "response.audio_transcript.delta" || t === "response.output_text.delta") && msg.delta) {
        assistantTranscript += msg.delta;
        if (assistantTurnOpen) currentAssistantText += msg.delta;
      }
      if (t === "response.completed" || t === "response.output_audio.done" || t === "response.error") {
        closeAssistantTurn();
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
      // Forward caller audio to OpenAI realtime
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
            // Debounce boundary reached -> close any open assistant turn (should have just finished),
            // and open a placeholder CALLER turn so we can interleave later
            turns.push({ role: "caller" });
            callerTurns.push({}); // placeholder slot matching this caller turn

            // Ask assistant to respond (which will open a new assistant turn when created)
            oai.send(JSON.stringify({
              type: "response.create",
              response: { modalities: ["audio", "text"] },
            }));
          } catch (err) {
            console.error("Commit/send error:", err);
          }
        }, DEBOUNCE_MS);
      }

      // Buffer μ-law frame for Whisper
      try {
        ulawChunks.push(Buffer.from(msg.media.payload, "base64"));
      } catch (e) {
        console.error("Failed to buffer μ-law chunk:", e);
      }
      return;
    }

    if (msg.event === "stop") {
      console.log("Call stopped. Building WAV & transcribing with Whisper…");

      // Close realtime socket
      try { if (oai && oai.readyState === WebSocket.OPEN) oai.close(); } catch {}

      // Build a single μ-law Buffer and transcribe
      const ulaw = Buffer.concat(ulawChunks);
      let callerTranscript = "";

      try {
        if (ulaw.length === 0) {
          console.warn("No μ-law audio captured.");
        } else {
          // Convert μ-law -> PCM16 -> WAV (8kHz)
          const pcm16 = ulawToPcm16(ulaw);
          const wav = pcm16ToWav(pcm16, 8000);

          // Transcribe with Whisper (verbose to keep room for future word/seg timing)
          const fd = new FormData();
          fd.append("model", "whisper-1");
          fd.append("response_format", "json");
          fd.append("file", new Blob([wav], { type: "audio/wav" }), "call.wav");

          const tr = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
            body: fd,
          });

          const tj = await tr.json();
          callerTranscript = String(tj?.text || "").trim();
        }
      } catch (err) {
        console.error("Whisper transcription error:", err);
      }

      // --- Distribute caller transcript across caller turns to preserve chronology ---
      const filledTurns = interleaveCallerText(turns, callerTranscript, callerTurns.length);

      // Build final labeled transcript
      const labeled = filledTurns
        .map((t) => t.role === "assistant"
          ? (t.text ? `Assistant: ${t.text}` : null)
          : (t.text ? `Caller: ${t.text}` : null))
        .filter(Boolean)
        .join('\n');

      // Post to GroupMe (full transcript + optional summary)
      try {
        if (labeled) {
          await sendGroupMe(`🗣️ Transcript
${labeled}`);
        } else {
          await sendGroupMe("🗣️ Transcript unavailable.");
        }
      } catch (e) {
        console.error("GroupMe post error:", e);
      }

      // Optional compact summary (2–3 sentences) using total text
      try {
        const base = filledTurns
          .map((t) => `${t.role === 'assistant' ? 'Assistant' : 'Caller'}: ${t.text || ''}`)
          .join('
')
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
                { role: "system", content: "You summarize phone calls in 2–3 crisp sentences." },
                { role: "user", content: base },
              ],
              max_tokens: 160,
            }),
          });
          const data = await summaryResponse.json();
          const summary = data.choices?.[0]?.message?.content?.trim();
          if (summary) await sendGroupMe(`📝 Summary: ${summary}`);
        }
      } catch (err) {
        console.error("Summary error:", err);
      }

      try { ws.close(); } catch {}
      return;
    }
  });

  ws.on("error", (err) => console.error("Twilio WS error:", err));
  ws.on("close", () => {
    if (oai && oai.readyState === WebSocket.OPEN) {
      try { oai.close(); } catch {}
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

// === Audio conversion helpers: μ-law -> PCM16 -> WAV (8kHz mono) ===
function ulawByteToLinearSample(uVal) {
  // ITU-T G.711 μ-law decode
  const MULAW_BIAS = 0x84; // 132
  uVal = ~uVal & 0xff;
  const sign = uVal & 0x80;
  const exponent = (uVal & 0x70) >> 4;
  const mantissa = uVal & 0x0f;
  let sample = ((mantissa << 4) + 0x08) << (exponent + 3);
  sample -= MULAW_BIAS;
  if (sign) sample = -sample;
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;
  return sample;
}

function ulawToPcm16(ulawBuf) {
  const out = new Int16Array(ulawBuf.length);
  for (let i = 0; i < ulawBuf.length; i++) out[i] = ulawByteToLinearSample(ulawBuf[i]);
  return out;
}

function pcm16ToWav(pcm16, sampleRate = 8000) {
  const numChannels = 1;
  const bytesPerSample = 2;
  const byteRate = sampleRate * numChannels * bytesPerSample;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = pcm16.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  // fmt chunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);              // PCM chunk size
  buffer.writeUInt16LE(1, 20);               // PCM format
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);              // bits per sample

  // data chunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  // samples
  for (let i = 0; i < pcm16.length; i++) buffer.writeInt16LE(pcm16[i], 44 + i * 2);
  return buffer;
}

// === Caller text interleaving ===
function splitIntoSentences(text) {
  const s = text.trim();
  if (!s) return [];
  // Simple sentence split: ., !, ? followed by space/newline; keep punctuation
  const parts = s.match(/[^.!?
]+[.!?]?/g) || [s];
  return parts.map((x) => x.trim()).filter(Boolean);
}

function interleaveCallerText(turns, callerTranscript, callerTurnCount) {
  // If there are no caller turns, just return assistant turns as-is
  if (!callerTurnCount) return turns.map((t) => ({ ...t }));

  const sentences = splitIntoSentences(callerTranscript);
  if (sentences.length === 0) {
    // Nothing to fill
    return turns.map((t) => ({ ...t }));
  }

  // Distribute sentences across caller turns as evenly as possible
  const buckets = Array.from({ length: callerTurnCount }, () => []);
  for (let i = 0; i < sentences.length; i++) {
    buckets[i % callerTurnCount].push(sentences[i]);
  }

  // Construct new turns with caller text filled in order
  let callerIdx = 0;
  const filled = turns.map((t) => {
    if (t.role === "caller") {
      const chunk = buckets[callerIdx] || [];
      callerIdx++;
      return { role: "caller", text: chunk.join(" ").trim() };
    }
    return { role: "assistant", text: (t.text || "").trim() };
  });

  return filled;
}
