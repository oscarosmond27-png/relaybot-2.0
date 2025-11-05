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

  // Use a clean URL and pass values via <Parameter>
  let wsUrl = `wss://${host}/twilio`;

  // Escape prompt for XML attribute
  const promptAttr = String(prompt)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    //`<Say>Hello, I have a quick message for you.</Say>` +
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
        try {
          ws.close();
        } catch {}
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
  let summaryText = "";
  let summaryTimeout = null;

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
      try {
        oai.ping?.();
      } catch {}
    }, 15000);

    oai.on("open", () => {
      oaiReady = true;
      oai.send(
        JSON.stringify({
          type: "session.update",
          session: {
            voice: "coral",
            modalities: ["audio", "text"], // must include both
            input_audio_format: "g711_ulaw", // Twilio -> us
            output_audio_format: "g711_ulaw", // match Twilio exactly
            turn_detection: { type: "server_vad" },
            instructions:
              "You are a friendly phone agent. Speak ONLY in clear American English. Never switch languages, unless you are spoken to in another language. Be concise and natural. Keep the phone call under 2 minutes.",
          },
        })
      );
      oai.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            instructions: `Say exactly: "Hello! I am Oscar's personal call assistant. Oscar has a message for you. He says ". Then say: "${prompt}". Then you may follow up with something related to the message you are carrying, which is "${prompt}". Keep in mind that you are speaking to whoever the message was meant for, not the sender of the message. Always ask if they would like to reply to Oscar or ask some other follow up question.`,
          },
        })
      );
    });

    // Handle both audio (for the call) and text (for the end-of-call summary)
    oai.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const t = msg.type || "(no type)";
    
        // 1) Audio streaming from OpenAI -> Twilio (unchanged)
        if ((t === "response.audio.delta" || t === "response.output_audio.delta") && msg.delta && streamSid) {
          ws.send(JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: msg.delta }
          }));
        }

        if (awaitingSummary && t === "response.output_text.delta" && msg.delta) {
          console.log("Summary token:", msg.delta);
          summaryText += msg.delta;
        }
        
        // 2) Text deltas (summary chunks)
        if (awaitingSummary && t === "response.output_text.delta" && msg.delta) {
          summaryText += msg.delta;
        }
    
        // 3) Summary completion: send to GroupMe, then clean up the sockets
        if (awaitingSummary && t === "response.completed") {
          console.log("Summary complete:", summaryText);
          awaitingSummary = false;
          if (summaryTimeout) { clearTimeout(summaryTimeout); summaryTimeout = null; }
          const text = summaryText.trim();
          summaryText = "";
          if (text) {
            try {
              await sendGroupMe(`📝 Call summary: ${text}`);
            } catch (e) {
              console.error("Failed to send summary to GroupMe:", e);
            }
          } else {
            try {
              await sendGroupMe("📝 Call summary unavailable.");
            } catch {}
          }
          // after we’ve posted the summary, close sockets
          try { oai.close(); } catch {}
          try { ws.close(); } catch {}
        }
    
      } catch (err) {
        console.error("Error relaying OpenAI message:", err);
      }
    });

    oai.on("error", (err) => console.error("OpenAI WS error:", err));
    oai.on("close", () => {
      clearInterval(pingIv);
      // Only force-close Twilio if we're NOT waiting on a summary
      if (!awaitingSummary) {
        try { ws.close(); } catch {}
      }
    });
  }

  ws.on("error", (err) => console.error("Twilio WS error:", err));

  // Single message handler to process connected -> start -> media -> stop
  ws.on("message", async (buf) => {
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
      if (typeof cp.prompt === "string" && cp.prompt.trim())
        prompt = cp.prompt.trim();
      echoMode = cp.loop === "1";

      console.log("Start received. prompt:", prompt, "echoMode:", echoMode);

      if (echoMode) {
        console.log("Loopback mode enabled");
        return; // stay in handler; we'll echo 'media' below
      } else {
        ensureOpenAI();
        return;
      }
    }

    if (msg.event === "media" && streamSid) {
      if (echoMode) {
        // Bounce caller audio back unchanged
        ws.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: msg.media.payload },
          })
        );
      } else {
        // Forward to OpenAI and auto-commit after brief silence
        if (oai && oaiReady && oai.readyState === WebSocket.OPEN) {
          // Append this audio chunk
          oai.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: msg.media.payload,
            })
          );

          // Debounce: when caller pauses, commit and ask for a reply
          if (commitTimer) clearTimeout(commitTimer);
          commitTimer = setTimeout(() => {
            try {
              oai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
              oai.send(
                JSON.stringify({
                  type: "response.create",
                  response: { modalities: ["audio", "text"] },
                })
              );
            } catch (err) {
              console.error("Commit/send error:", err);
            }
          }, DEBOUNCE_MS);
        }
      }
      return;
    }

    // Optional: respond immediately when Twilio sends a 'mark'
    if (msg.event === "mark" && oai && oaiReady) {
      try {
        oai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        oai.send(
          JSON.stringify({
            type: "response.create",
            response: { modalities: ["audio", "text"] },
          })
        );
      } catch (e) {
        console.error("mark commit error", e);
      }
      return;
    }

    if (msg.event === "stop") {
      if (oai && oaiReady) {
        try {
          // Finalize any buffered input before summary
          oai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

          // Small delay to let OpenAI finish its last turn
          await new Promise(r => setTimeout(r, 1000));

          console.log("Requesting summary from OpenAI...");

          // Ask the same realtime session for a short text summary of the call.
          awaitingSummary = true;
          summaryText = "";

          // Safety timeout in case the summary never arrives
          summaryTimeout = setTimeout(async () => {
            if (awaitingSummary) {
              awaitingSummary = false;
              try { await sendGroupMe("📝 Call summary unavailable (timeout)."); } catch {}
              try { oai.close(); } catch {}
              try { ws.close(); } catch {}
            }
          }, 40000);

          oai.send(JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["text"],
              instructions: "Summarize the phone conversation that just ended in 2–3 complete sentences. Include who spoke and what was said. Respond immediately."
            }
          }));

          // IMPORTANT: stop here so we don't close sockets before we get the summary.
          return;
        } catch (err) {
          console.error("Error requesting summary:", err);
          // fall through to existing close logic if something goes wrong
        }
      }
      if (oai && oaiReady) {
        try {
          oai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        } catch {}
        try {
          oai.close();
        } catch {}
      }
      try {
        ws.close();
      } catch {}
      return;
    }
  });

  // Don't kill OpenAI while we're waiting on the summary
  ws.on("close", () => {
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

  const streamUrl = `wss://${
    process.env.BASE_HOST || "relaybot-2-0.onrender.com"
  }/twilio`;

  const twiml =
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    //`<Say>Hello, I have a quick message for you.</Say>` +
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
