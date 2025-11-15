// server.js — GroupMe + Twilio + OpenAI voice

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
    // Optional shared-secret protection
    if (process.env.GROUPME_SHARED_SECRET) {
      if (req.get("x-shared-secret") !== process.env.GROUPME_SHARED_SECRET) {
        return res.status(403).send("forbidden");
      }
    }

    const text = (req.body?.text || "").trim();
    const senderType = req.body?.sender_type || "";

    // Ignore messages from the bot itself
    if (senderType === "bot") {
      return res.send("ok");
    }

    // Parse commands like: "call 4355551212 and tell Dr. Lee the results are ready."
    const m = text
      .replace(/[.,!?]$/i, "")
      .match(
        /call\s+([\d\s\-\(\)\+]+)\s*(?:,|\s+)?(?:and\s+)?(?:tell|say|ask)\s+(.+)/i
      );

    if (!m) {
      await sendGroupMe(
        "Try: call 4355551212 and tell Dr. Lee the results are ready."
      );
      return res.send("ok");
    }

    const to = normalizePhone(m[1]);
    const prompt = m[2].trim();

    if (!to) {
      await sendGroupMe(
        `Could not find a valid phone number in "${m[1].trim()}".`
      );
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
  const prompt = (req.query.prompt || "test").toString();
  const loopFlag = req.query.loop === "1";

  const host = req.get("host") || process.env.BASE_HOST;
  const wsUrl = `wss://${host}/twilio`;

  const promptAttr = String(prompt)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="prompt" value="${promptAttr}"/>
      <Parameter name="loop" value="${loopFlag ? "1" : "0"}"/>
    </Stream>
  </Connect>
</Response>`;



  res.set("Content-Type", "text/xml").send(xml);
});

// === WebSocket bridge (Twilio <-> OpenAI Realtime) ===
const server = app.listen(process.env.PORT || 10000, () => {
  const address = server.address();
  console.log("Server listening on", address && address.port);
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  console.log("WS upgrade request:", req.url);

  if (req.url && req.url.startsWith("/twilio")) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log("WS upgraded to /twilio");
      handleTwilio(ws, req).catch((err) => {
        console.error("handleTwilio error:", err);
        try {
          ws.close();
        } catch {
          // ignore
        }
      });
    });
  } else {
    socket.destroy();
  }
});

async function handleTwilio(ws, req) {
  console.log("WS handler entered:", req.url);

  let prompt = "test";
  let echoMode = false; // currently unused, but kept for future behavior
  let streamSid = null;
  let started = false;

  let transcriptText = ""; // collect everything said
  let transcriptEntries = []; // structured events
  let sequenceCounter = 0;     // guarantees ordering even with identical timestamps
  let hasBufferedAudio = false;
  let oai = null;
  let oaiReady = false;
  let commitTimer = null;
  let allowAssistantAudio = true; // <- controls barge-in: whether Twilio is allowed to play assistant audio
  let currentResponseId = null; // NEW

  const DEBOUNCE_MS = 700;

  function ensureOpenAI() {
    if (oai) return;
  
    if (!process.env.OPENAI_API_KEY) {
      console.error("Missing OPENAI_API_KEY env var");
      return;
    }
  
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

  oai.send(
    JSON.stringify({
      type: "session.update",
      session: {
        voice: "ash",
        modalities: ["audio", "text"],
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad" },
        instructions:
          "You are a friendly but concise phone assistant. Speak in clear American English. Keep calls under 2 minutes, with replies no longer than 1–2 short sentences. Sound natural and conversational. If asked directly whether you are an AI, answer honestly but briefly and redirect back to helping.",
        input_audio_transcription: {
          model: "whisper-1",
          language: "en",
        },
      },
    })
  );
});


  
oai.on("message", (data) => {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return;
  }

  const t = msg.type;
  const isAudio =
    t === "response.audio.delta" || t === "response.output_audio.delta";

  // ====== TRACK CURRENT RESPONSE FOR CANCELLATION ======
  if (t === "response.created") {
    currentResponseId = msg.response?.id || null;
    allowAssistantAudio = true; // new assistant turn -> allow audio
  }

  // ====== INIT TRANSCRIPT BUFFERS ======
  if (!globalThis._assistantBuffer) globalThis._assistantBuffer = "";
  if (!globalThis._callerLastItemId) globalThis._callerLastItemId = null;

  // ====== ASSISTANT TRANSCRIPT (buffered into sentences) ======
  if (t === "response.audio_transcript.delta" && msg.delta) {
    globalThis._assistantBuffer += msg.delta;

    if (/[.!?"]$/.test(msg.delta.trim())) {
      const sentence = globalThis._assistantBuffer.trim();

      transcriptEntries.push({
        speaker: "Assistant",
        text: sentence,
        time: Date.now(),
        seq: sequenceCounter++,
      });

      setTimeout(() => {
        sendGroupMeBatched("Assistant", sentence);
      }, 1000);

      globalThis._assistantBuffer = "";
    }
  }

// ====== CALLER TRANSCRIPT + SAFE BARGE-IN ======
if (t === "conversation.item.input_audio_transcription.completed" && msg.transcript) {
  const callerText = msg.transcript.trim();
  const words = callerText.split(/\s+/).filter(Boolean);

  // Debug: see exactly what Whisper heard
  console.log("WHISPER COMPLETED:", JSON.stringify(callerText));

  // 🔒 STRONG FILTER:
  // - at least 15 characters
  // - at least 3 words
  if (callerText.length < 15 || words.length < 3) {
    // too short / not a real phrase -> do NOT barge in
    return;
  }

  // Don't double-process same utterance
  if (globalThis._callerLastItemId === msg.item_id) return;
  globalThis._callerLastItemId = msg.item_id;

  // Store transcript
  transcriptEntries.push({
    speaker: "Caller",
    text: callerText,
    time: Date.now(),
    seq: sequenceCounter++,
  });

  sendGroupMeBatched("Caller", callerText);

  // 🔥 REAL BARGE-IN TRIGGER (on actual sentence)
//  allowAssistantAudio = false;

  // Stop Twilio playback
  //if (ws.readyState === WebSocket.OPEN && streamSid) {
    //ws.send(JSON.stringify({ event: "clear", streamSid }));
  //}

  // Stop OpenAI assistant speech
//  if (currentResponseId && oai && oai.readyState === WebSocket.OPEN) {
  //  oai.send(
     // JSON.stringify({
       // type: "response.cancel",
        //response_id: currentResponseId,
      //})
    //);
  //}
}





  // ====== FORWARD ASSISTANT AUDIO TO TWILIO (gated) ======
  if (isAudio && msg.delta && streamSid && allowAssistantAudio) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.delta },
        })
      );
    }
  }
});




  
    oai.on("error", (err) => console.error("OpenAI WS error:", err));
    oai.on("close", () => console.log("OpenAI socket closed"));
  }


  ws.on("message", async (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }

    if (msg.event === "connected") return;

    if (msg.event === "start" && !started) {
      started = true;
      streamSid = msg.start?.streamSid || null;
    
      const cp = msg.start?.customParameters || {};
      if (typeof cp.prompt === "string" && cp.prompt.trim()) {
        prompt = cp.prompt.trim();
      }
    
      echoMode = cp.loop === "1";
      console.log("Start received. prompt:", prompt);
    
      ensureOpenAI();
    
      // 🔥 Wait until the OpenAI WS is ready, THEN send the intro
      const introTimer = setInterval(() => {
        if (oaiReady && oai && oai.readyState === WebSocket.OPEN) {
          clearInterval(introTimer);
    
          oai.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio", "text"],
                output_audio_transcription: { enable: true },
                instructions: `At the start of the call, say exactly: "Hello! I am Oscar's personal call assistant. Oscar has a message for you. He says: ${prompt}" Then pause and wait for the caller to respond.`,
              },
            })
          );
        }
      }, 50);
    
      return;
    }



    if (msg.event === "media" && streamSid) {
      if (oai && oaiReady && oai.readyState === WebSocket.OPEN) {
        // Append audio to OpenAI input buffer
        oai.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: msg.media.payload,
          })
        );
        hasBufferedAudio = true;

        // Debounce commits
        if (commitTimer) clearTimeout(commitTimer);
        commitTimer = setTimeout(() => {
          try {
            if (hasBufferedAudio) {
              oai.send(
                JSON.stringify({
                  type: "input_audio_buffer.commit"
                })
              );
              hasBufferedAudio = false;
            }
            // NO response.create
            // NO ws.send
          } catch (err) {
            console.error("Commit error:", err);
          }
        }, DEBOUNCE_MS);
        

      }
      return;
    }

    if (msg.event === "stop") {
      console.log("Call stopped. Summarizing via GPT-4o-mini…");

      if (oai && oai.readyState === WebSocket.OPEN) {
        try {
          oai.close();
        } catch {
          // ignore
        }
      }

      try {
        // Sort events by time, fallback to seq for same-ms cases
        transcriptEntries.sort((a, b) =>
          a.time === b.time ? a.seq - b.seq : a.time - b.time
        );
        
        // Build final transcript
        const transcript = transcriptEntries
          .map((e) => `${e.speaker}: ${e.text}`)
          .join("\n");

          // 🔹 NEW: send full transcript to GroupMe
          await sendGroupMe(`📄 Full transcript:\n${transcript}`);
        
        if (transcript.length < 30) {
          await sendGroupMe("📝 Call summary: No usable transcript captured.");
          try {
            ws.close();
          } catch {
            // ignore
          }
          return;
        }

        if (!process.env.OPENAI_API_KEY) {
          console.error("Missing OPENAI_API_KEY env var for summary");
          await sendGroupMe("📝 Call summary unavailable (missing API key).");
          try {
            ws.close();
          } catch {
            // ignore
          }
          return;
        }

        const summaryResponse = await fetch(
          "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "gpt-4o-mini",
              messages: [
                {
                  role: "system",
                  content:
                    "You are a neutral assistant that summarizes phone calls in plain English.",
                },
                {
                  role: "user",
                  content: `Here is the transcript of a phone call:\n\n${transcript}\n\nSummarize what was said in 2–3 sentences. Be factual and concise.`,
                },
              ],
            }),
          }
        );

        const data = await summaryResponse.json();
        const summary = data?.choices?.[0]?.message?.content?.trim();

        if (summary) {
          await sendGroupMe(`📝 Call summary: ${summary}`);
        } else {
          await sendGroupMe("📝 Call summary unavailable.");
        }
      } catch (err) {
        console.error("Error generating summary:", err);
        await sendGroupMe("📝 Call summary failed due to error.");
      }

      try {
        ws.close();
      } catch {
        // ignore
      }

      return;
    }
  });

  ws.on("error", (err) => console.error("Twilio WS error:", err));

  ws.on("close", () => {
    if (commitTimer) clearTimeout(commitTimer);
    if (oai && oai.readyState === WebSocket.OPEN) {
      try {
        oai.close();
      } catch {
        // ignore
      }
    }
  });
}

// === Helper functions ===

async function sendCaptionToGPT(role, text) {
  try {
    await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You receive caller and assistant captions in real time."
          },
          {
            role: "user",
            content: `${role}: ${text}`
          }
        ]
      })
    });
  } catch (err) {
    console.error("GPT caption forward error:", err);
  }
}

// === GroupMe Caption Batcher ===
let gmBatch = [];
let gmBatchTimer = null;

async function sendGroupMeBatched(role, text) {
  gmBatch.push(`${role}: ${text}`);

  if (gmBatchTimer) clearTimeout(gmBatchTimer);

  // Send in a single combined message after 400ms of silence
  gmBatchTimer = setTimeout(async () => {
    const combined = gmBatch.join("\n");
    gmBatch = [];

    try {
      await sendGroupMe(combined);
    } catch (err) {
      console.error("GroupMe batch send error:", err);
    }
  }, 400);
}




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

  const safePrompt = String(promptText)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");

  const streamUrl = `wss://${process.env.BASE_HOST || "relaybot-2-0.onrender.com"}/twilio`;

const twiml =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<Response>` +
  `<Connect><Stream url="${streamUrl}">` +
  `<Parameter name="prompt" value="${safePrompt}"/>` +
  `<Parameter name="loop" value="0"/>` +
  `</Stream></Connect>` +
  `</Response>`;


  const body = new URLSearchParams({
    To: to,
    From: process.env.TWILIO_FROM_NUMBER,
    Twiml: twiml,
  });

  return fetch(api, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
    },
    body,
  });
}

async function sendGroupMe(text) {
  await fetch("https://api.groupme.com/v3/bots/post", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bot_id: process.env.GROUPME_BOT_ID,
      text,
    }),
  });
}
