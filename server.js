// server.js — All-in-one Render bot: GroupMe + Twilio + OpenAI voice (cleaned)
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
    // Optional simple shared-secret header to prevent random abuse
    if (process.env.GROUPME_SHARED_SECRET) {
      if (req.get("x-shared-secret") !== process.env.GROUPME_SHARED_SECRET) {
        return res.status(403).send("forbidden");
      }
    }

    const text = (req.body?.text || "").trim();
    const senderType = req.body?.sender_type || "";
    if (senderType === "bot") return res.send("ok");

    // More forgiving parse: handles trailing punctuation and optional comma
    const m = text
      .replace(/[.,!?]$/i, "")
      .match(/call\s+([\d\s\-\(\)\+]+)\s*(?:,|\s+)?(?:and\s+)?(?:tell|say|ask)\s+(.+)/i);

    if (!m) {
      await sendGroupMe(
        "Try: call 4355551212 and tell Dr. Lee the results are ready."
      );
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
  // Handle calls even if Twilio strips extra parameters
  let prompt = req.query.prompt || "test";
  let loopFlag = req.query.loop === "1";
  const host = req.get("host");

  console.log("TwiML served for prompt:", prompt, "loop:", loopFlag);

  // If Twilio didn’t include &loop=1, force loop mode for safety (prevents silence)
  if (!loopFlag) {
    console.log("No loop flag detected — forcing loop mode for safety.");
    loopFlag = true;
  }

  let wsUrl = `wss://${host}/twilio`;

  // Escape prompt for XML attribute
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
  console.log("WS handler entered with URL:", req.url);

  // State filled once Twilio sends "start"
  let prompt = "test";
  let echoMode = false;
  let streamSid = null;
  let started = false;

  // --- summary capture state ---
  let awaitingSummary = false;
  let pendingSummaryRequest = false; // wait to send until idle
  let summaryRequested = false;
  let summaryText = "";
  let summaryTimeout = null;
  let transcriptText = "";   // collect audio transcript tokens here (fallback)
  let keepalive = null;      // interval handle so we can clear it from anywhere

  // audio buffering tracker to avoid empty commits
  let hasBufferedAudio = false;

  // OpenAI socket + state (created lazily after "start" if not echo)
  let oai = null;
  let oaiReady = false;
  let commitTimer = null;
  const DEBOUNCE_MS = 700; // try 500–900ms if you want faster/slower replies

  function ensureOpenAI() {
    if (oai) return; // already created

    oai = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview`,
      "realtime",
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    // Keepalive pings to avoid idle disconnects
    const pingIv = setInterval(() => {
      try { oai.ping?.(); } catch {}
    }, 15000);

    oai.on("open", () => {
      oaiReady = true;
      oai.send(JSON.stringify({
        type: "session.update",
        session: {
          voice: "coral",
          modalities: ["audio", "text"],
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "server_vad" },
          instructions:
            "You are a friendly phone agent. Speak ONLY in clear American English. Never switch languages unless the other party does. Be concise and natural. Keep the phone call under 2 minutes.",
        },
      }));
      oai.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: `Say exactly: "Hello! I am Oscar's personal call assistant. Oscar has a message for you. He says ". Then say: "${prompt}". Then you may follow up briefly, keeping context to "${prompt}". Ask if they'd like to reply to Oscar.`,
        },
      }));
    });

    // Handle both audio (for the call) and text (for the end-of-call summary)
    oai.on("message", async (data) => {
      try {
        const raw = data.toString();
        let msg;
        try { msg = JSON.parse(raw); } catch {
          console.error("OpenAI non-JSON frame:", raw.slice(0, 120));
          return;
        }

        const t = msg.type || "(no type)";

        if (t === "error") {
          console.error("OpenAI error:", msg);
          // Don't return; sometimes the stream continues after a soft error
        }

        // visibility while awaiting summary
        if (awaitingSummary) console.log("OAI event during summary:", t);

        // 1) Audio streaming from OpenAI -> Twilio (unchanged, guarded)
        const isAudioDelta =
          (t === "response.audio.delta" || t === "response.output_audio.delta");
        if (isAudioDelta && msg.delta && streamSid) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: msg.delta }
            }));
          } else {
            console.warn("Skipped sending audio delta — Twilio WS not open");
          }
        }

        // 2) Audio transcript deltas (logs showed these)
        if (awaitingSummary && t === "response.audio_transcript.delta" && msg.delta) {
          console.log("Transcript token:", msg.delta);
          transcriptText += msg.delta;
        }

        // 3) Text deltas (if the model sends actual text tokens, capture them)
        const isTextDelta =
          (t === "response.output_text.delta" || t === "response.text.delta");
        if (awaitingSummary && isTextDelta && msg.delta) {
          console.log("Summary token:", msg.delta);
          summaryText += msg.delta;
        }

        // 4) Defensive: sometimes a single blob lands without .delta
        if (awaitingSummary && (t === "response.output_text" || t === "response.text")) {
          const txt = (msg.text || msg.output_text || "").trim();
          if (txt) summaryText += txt;
        }

        // 5) Idle detection to start summary request
        const isDone = (t === "response.completed" || t === "response.complete" || t === "response.done");
        if (isDone && awaitingSummary && pendingSummaryRequest && !summaryRequested) {
          // Now safe to ask for the summary
          summaryRequested = true;
          oai.send(JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["text"],
              instructions: "Write a neutral, factual summary of the phone conversation in 1–2 sentences, mentioning who spoke and the key point. If there is not enough information to summarize, respond exactly: No conversation captured. Do not apologize or refuse.",
            }
          }));
          console.log("Summary request sent (after idle).");
        }

        // 6) Completion (finish summary)
        if (awaitingSummary && isDone && summaryRequested) {
          awaitingSummary = false;
          pendingSummaryRequest = false;
          summaryRequested = false;

          if (summaryTimeout) { clearTimeout(summaryTimeout); summaryTimeout = null; }
          if (keepalive) { clearInterval(keepalive); keepalive = null; }

          let finalText = (summaryText || "").trim();
          if (!finalText && transcriptText.trim()) {
            finalText = transcriptText.trim();
            console.log("Using transcript fallback for summary.");
          }
          summaryText = "";
          transcriptText = "";

          if (finalText) {
            try { await sendGroupMe(`📝 Call summary: ${finalText}`); }
            catch (e) { console.error("Failed to send summary to GroupMe:", e); }
          } else {
            try { await sendGroupMe("📝 Call summary unavailable."); } catch {}
          }
          try { oai.close(); } catch {}
          try { ws.close(); } catch {}
          return;
        }

      } catch (err) {
        console.error("Error relaying OpenAI message:", err);
      }
    });

    oai.on("error", (err) => console.error("OpenAI WS error:", err));
    oai.on("close", () => {
      clearInterval(pingIv);
      if (!awaitingSummary) {
        try { ws.close(); } catch {}
      }
    });
  }

  ws.on("error", (err) => console.error("Twilio WS error:", err));

  // Single message handler to process connected -> start -> media -> stop
  ws.on("message", async (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.event === "connected") return;

    if (msg.event === "start" && !started) {
      started = true;

      // fresh buffers per call
      awaitingSummary = false;
      pendingSummaryRequest = false;
      summaryRequested = false;
      summaryText = "";
      transcriptText = "";
      hasBufferedAudio = false;
      if (summaryTimeout) { clearTimeout(summaryTimeout); summaryTimeout = null; }
      if (keepalive) { clearInterval(keepalive); keepalive = null; }

      streamSid = msg.start?.streamSid || null;
      const cp = msg.start?.customParameters || {};
      if (typeof cp.prompt === "string" && cp.prompt.trim()) prompt = cp.prompt.trim();
      echoMode = cp.loop === "1";

      console.log("Start received. prompt:", prompt, "echoMode:", echoMode);

      if (echoMode) {
        console.log("Loopback mode enabled");
        return;
      } else {
        ensureOpenAI();
        return;
      }
    }

    if (msg.event === "media" && streamSid) {
      if (echoMode) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: msg.media.payload },
          }));
        }
      } else {
        if (oai && oaiReady && oai.readyState === WebSocket.OPEN) {
          // Append this audio chunk
          oai.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: msg.media.payload,
          }));
          hasBufferedAudio = true;

          // Debounce: when caller pauses, commit and ask for a reply
          if (commitTimer) clearTimeout(commitTimer);
          commitTimer = setTimeout(() => {
            try {
              if (hasBufferedAudio) {
                oai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
                hasBufferedAudio = false;
              }
              oai.send(JSON.stringify({
                type: "response.create",
                response: { modalities: ["audio","text"] }
              }));
            } catch (err) {
              console.error("Commit/send error:", err);
            }
          }, DEBOUNCE_MS);
        }
      }
      return;
    }

    if (msg.event === "mark" && oai && oaiReady) {
      try {
        if (hasBufferedAudio) {
          oai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          hasBufferedAudio = false;
        }
        oai.send(JSON.stringify({
          type: "response.create",
          response: { modalities: ["audio","text"] }
        }));
      } catch (e) {
        console.error("mark commit error", e);
      }
      return;
    }

    if (msg.event === "stop") {
      if (oai && oaiReady) {
        try {
          // Finalize any buffered input before summary (only if we actually have some)
          if (hasBufferedAudio) {
            oai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            hasBufferedAudio = false;
          }

          // Cancel any in-flight audio so the model focuses on a text reply
          oai.send(JSON.stringify({ type: "response.cancel" }));

          // Small settle delay
          await new Promise(r => setTimeout(r, 600));

          console.log("Requesting summary from OpenAI (will wait for idle)...");

          // Prepare to request summary once idle
          awaitingSummary = true;
          pendingSummaryRequest = true;
          summaryRequested = false;
          summaryText = "";
          transcriptText = "";

          // Safety timeout in case the summary never arrives or idle never detected
          summaryTimeout = setTimeout(async () => {
            if (awaitingSummary) {
              awaitingSummary = false;
              pendingSummaryRequest = false;
              summaryRequested = false;
              try { await sendGroupMe("📝 Call summary unavailable (timeout)."); } catch {}
              try { oai.close(); } catch {}
              try { ws.close(); } catch {}
            }
          }, 40000);

          // --- Keepalive pings so the socket stays open until summary arrives ---
          let keepaliveCount = 0;
          keepalive = setInterval(() => {
            if (awaitingSummary && oai && oai.readyState === WebSocket.OPEN) {
              try {
                oai.ping?.();
                keepaliveCount++;
                console.log(`Keeping socket alive... (${keepaliveCount})`);
              } catch (err) {
                console.error("Keepalive ping failed:", err);
              }
            } else {
              if (keepalive) { clearInterval(keepalive); keepalive = null; }
            }
          }, 3000); // every 3 seconds

          // Fallback: if for some reason we never get a done event,
          // try issuing the summary after 1500ms anyway.
          setTimeout(() => {
            if (awaitingSummary && pendingSummaryRequest && !summaryRequested && oai && oai.readyState === WebSocket.OPEN) {
              summaryRequested = true;
              oai.send(JSON.stringify({
                type: "response.create",
                response: {
                  modalities: ["text"],
                  instructions: "Write a neutral, factual summary of the phone conversation in 1–2 sentences, mentioning who spoke and the key point. If there is not enough information to summarize, respond exactly: No conversation captured. Do not apologize or refuse.",
                }
              }));
              console.log("Summary request sent (fallback).");
            }
          }, 1500);

          return; // don't close sockets yet
        } catch (err) {
          console.error("Error requesting summary:", err);
          // fall through to close logic if something goes wrong
        }
      }
      if (oai && oaiReady) {
        try { oai.send(JSON.stringify({ type: "input_audio_buffer.commit" })); } catch {}
        try { oai.close(); } catch {}
      }
      try { ws.close(); } catch {}
      return;
    }
  });

  // Don't kill OpenAI while we're waiting on the summary
  ws.on("close", () => {
    // Clean up timers on WS close
    try {
      if (summaryTimeout) { clearTimeout(summaryTimeout); summaryTimeout = null; }
      if (keepalive) { clearInterval(keepalive); keepalive = null; }
    } catch {}
    try {
      if (oai && !awaitingSummary) oai.close();
    } catch {}
  });
}

// === Helper functions ===
function normalizePhone(s) {
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (/^\+\d{8,15}$/.test(s)) return s; // light E.164 check
  return null;
}

async function makeTwilioCallWithTwiml(to, promptText) {
  const api = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Calls.json`;
  const auth = Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString("base64");

  // escape prompt for XML attribute
  const safePrompt = String(promptText)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");

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

// (Removed unused PCM/μ-law conversion helpers — OpenAI already outputs g711 μ-law @ 8k)
