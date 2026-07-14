/**
 * REACH DIALER — Twilio backend reference implementation
 * -------------------------------------------------------
 * This is the real call + auto-text logic (not the prototype simulation).
 * Deploy this as a Node/Express server with a public URL (Render, Railway,
 * Fly.io, or similar) — Twilio needs to reach your webhooks over the internet.
 *
 * Flow:
 *  1. POST /call/start  -> places an outbound call to the candidate, using
 *     Answering Machine Detection (AMD) so Twilio tells us if it hit voicemail.
 *  2. POST /call/status -> Twilio calls this webhook with the AMD result.
 *     If no-answer/machine, we fire the SMS from the SAME number within seconds.
 *  3. POST /sms/inbound -> Twilio calls this when the candidate replies,
 *     so replies land back in your system tied to that candidate.
 *
 * Local presence: buy a small pool of numbers by area code (Twilio Console
 * or Buy Number API) and pick the closest match to the candidate's area code
 * before placing the call — see pickOutboundNumber() below.
 */

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const twilio = require('twilio');

const app = express();
app.use(cors()); // allows the browser-based test page / dashboard to call this backend
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // e.g. https://reach-dialer.onrender.com

// --- Your local-presence number pool. Populate with numbers you buy in Twilio. ---
const NUMBER_POOL = [
  { areaCode: '647', number: '+16475030473' }, // Toronto — your first live number
  { areaCode: '416', number: '+16475030473' },
];
const DEFAULT_NUMBER = NUMBER_POOL[0].number;
// As you buy more numbers (e.g. 514/438 Montreal, 418 Quebec City, 613 Ottawa)
// for the ifm efector search, add them here as { areaCode: 'XXX', number: '+1XXXXXXXXXX' }

function pickOutboundNumber(candidatePhone) {
  const areaCode = candidatePhone.replace(/\D/g, '').slice(-10, -7);
  const match = NUMBER_POOL.find(n => n.areaCode === areaCode);
  return match ? match.number : DEFAULT_NUMBER;
}

// In-memory candidate store for this reference implementation.
// Swap for your real DB (Postgres, Supabase, etc.) in production.
const candidates = new Map(); // key: phone, value: { name, status, lastFrom, template }

// ---------------------------------------------------------------------------
// 1. Start a call
// ---------------------------------------------------------------------------
app.post('/call/start', async (req, res) => {
  const { candidatePhone, candidateName, smsTemplate } = req.body;
  const fromNumber = pickOutboundNumber(candidatePhone);

  candidates.set(candidatePhone, {
    name: candidateName,
    status: 'calling',
    lastFrom: fromNumber,
    template: smsTemplate || 'Hi {first_name}, tried you by phone — Conor here, working a search that might fit your background. Good time this week for a quick call?',
  });

  try {
    const call = await client.calls.create({
      to: candidatePhone,
      from: fromNumber,
      url: `${PUBLIC_BASE_URL}/call/twiml`,           // what happens if it connects
      statusCallback: `${PUBLIC_BASE_URL}/call/status`,
      statusCallbackEvent: ['completed'],
      machineDetection: 'DetectMessageEnd',             // <-- AMD: tells us voicemail vs human
      asyncAmd: 'true',
      asyncAmdStatusCallback: `${PUBLIC_BASE_URL}/call/amd`,
    });
    res.json({ ok: true, callSid: call.sid, from: fromNumber });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// TwiML for when the call actually connects to a human — bridges to your phone/browser
app.post('/call/twiml', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.dial(process.env.RECRUITER_PHONE); // bridge to Conor's phone or browser client
  res.type('text/xml').send(twiml.toString());
});

// ---------------------------------------------------------------------------
// 2. Answering Machine Detection result — this is the trigger for the auto-text
// ---------------------------------------------------------------------------
app.post('/call/amd', async (req, res) => {
  const { AnsweredBy, To } = req.body; // AnsweredBy: 'human' | 'machine_start' | 'machine_end_beep' | etc.
  const record = candidates.get(To);
  if (!record) return res.sendStatus(200);

  if (AnsweredBy === 'human') {
    record.status = 'connected';
  } else {
    // Voicemail or no answer — fire the SMS immediately, from the SAME number that just called
    record.status = 'no_answer';
    const message = record.template.replace('{first_name}', record.name.split(' ')[0]);

    await client.messages.create({
      to: To,
      from: record.lastFrom,
      body: message,
    });

    record.status = 'texted';
  }

  res.sendStatus(200);
});

// ---------------------------------------------------------------------------
// 3. Inbound SMS replies land here
// ---------------------------------------------------------------------------
app.post('/sms/inbound', (req, res) => {
  const { From, Body } = req.body;
  const record = candidates.get(From);
  if (record) {
    record.status = 'replied';
    record.lastReply = Body;
    // TODO: push a notification to your dashboard / send yourself a text or email
  }
  res.type('text/xml').send('<Response></Response>'); // empty ack, no auto-reply
});

// ---------------------------------------------------------------------------
// Status check for the dashboard to poll
// ---------------------------------------------------------------------------
app.get('/candidates/:phone/status', (req, res) => {
  const record = candidates.get(req.params.phone);
  res.json(record || { status: 'unknown' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Reach Dialer backend running on port ${PORT}`));

/**
 * SETUP CHECKLIST when you're ready to go live:
 * 1. npm init -y && npm install express body-parser twilio
 * 2. Buy your number pool in the Twilio Console (Phone Numbers > Buy a Number),
 *    matching the area codes you call into most. Update NUMBER_POOL above.
 * 3. Set env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, PUBLIC_BASE_URL, RECRUITER_PHONE
 * 4. Deploy to Render/Railway/Fly.io (any host with a public HTTPS URL).
 * 5. In Twilio Console, set each number's "A Message Comes In" webhook to
 *    {PUBLIC_BASE_URL}/sms/inbound
 * 6. Test with your own cell first before pointing it at real candidates.
 */
