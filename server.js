const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { Anthropic } = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();

// 1. CORS Middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-api-key, authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// 2. Initialize Clients
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// 3. API Key Auth Guard (for REST API)
const authenticateApiKey = (req, res, next) => {
  const authHeader = req.headers['x-api-key'] || req.headers['authorization'];
  const secretKey = process.env.API_SECRET_KEY;

  if (secretKey && authHeader !== secretKey && authHeader !== `Bearer ${secretKey}`) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid or missing API key' });
  }
  next();
};

// Helper: Parse Claude JSON Output (Hardened for Markdown & Extra Text)
function parseClaudeJSON(text) {
  try {
    // Strip markdown code blocks if Claude includes them
    let cleanText = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return JSON.parse(cleanText);
  } catch (err) {
    throw new Error('Failed to parse Claude JSON output');
  }
}

// Helper: Zero-Downtime Fallback Parser
function fallbackParse(rawText) {
  const nameMatch = rawText.match(/^([A-Z][a-z]+\s[A-Z][a-z]+)/);
  const budgetMatch = rawText.match(/(\d+)\s*(Lakhs|Lakh|L)/i);
  
  let budgetMax = null;
  if (budgetMatch) {
    budgetMax = parseInt(budgetMatch[1], 10) * 100000;
  }

  return {
    customer_name: nameMatch ? nameMatch[1] : 'New Customer',
    budget_max: budgetMax,
    target_models: ['Inquired Vehicle'],
    trade_in_car: rawText.toLowerCase().includes('trade') || rawText.toLowerCase().includes('trading') ? 'Exchange Vehicle' : null,
    financing_required: rawText.toLowerCase().includes('loan') || rawText.toLowerCase().includes('financing'),
    intent_score: 0.50
  };
}

// 4. Core Lead Processing & Storage Core Engine
async function processAndSaveLead(rawText, phone_number) {
  let parsedLead;
  let usedFallback = false;

  // Step A: Claude NLP Extraction
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1000,
      system: `You are the Lead Parsing Engine for SSK Cars in Lucknow. Parse raw dealer notes into this strict JSON format. IMPORTANT: Output ONLY valid JSON with no markdown backticks, no explanations, and no conversational filler.
{
  "customer_name": string or null,
  "budget_max": number or null,
  "target_models": string[],
  "trade_in_car": string or null,
  "financing_required": boolean,
  "intent_score": number (between 0.0 and 1.0)
}`,
      messages: [{ role: 'user', content: rawText }]
    });

    parsedLead = parseClaudeJSON(response.content[0].text);
  } catch (aiError) {
    console.error("Anthropic API Error:", aiError.message);
    parsedLead = fallbackParse(rawText);
    usedFallback = true;
  }

  // Step B: Supabase Persistence with Deduplication
  let savedRecord = null;
  let isDuplicateUpdate = false;

  if (supabase) {
    let existingLead = null;

    if (phone_number) {
      const { data } = await supabase
        .from('leads')
        .select('*')
        .eq('phone_number', phone_number)
        .maybeSingle();

      existingLead = data;
    }

    if (existingLead) {
      isDuplicateUpdate = true;
      const mergedModels = Array.from(new Set([
        ...(existingLead.target_models || []),
        ...(parsedLead.target_models || [])
      ]));

      const updatedTranscript = `${existingLead.raw_transcript}\n\n[WhatsApp Follow-up]: ${rawText}`;

      const { data, error } = await supabase
        .from('leads')
        .update({
          customer_name: parsedLead.customer_name || existingLead.customer_name,
          budget_max: parsedLead.budget_max || existingLead.budget_max,
          target_models: mergedModels,
          trade_in_car: parsedLead.trade_in_car || existingLead.trade_in_car,
          financing_required: parsedLead.financing_required ?? existingLead.financing_required ?? false,
          intent_score: parsedLead.intent_score || existingLead.intent_score,
          raw_transcript: updatedTranscript
        })
        .eq('id', existingLead.id)
        .select();

      if (data) savedRecord = data[0];
      if (error) console.error("Deduplication Update Error:", error);
    } else {
      const { data, error } = await supabase.from('leads').insert([{
        customer_name: parsedLead.customer_name || 'New Lead',
        phone_number: phone_number || null,
        budget_max: parsedLead.budget_max,
        target_models: parsedLead.target_models,
        trade_in_car: parsedLead.trade_in_car,
        financing_required: parsedLead.financing_required ?? false,
        intent_score: parsedLead.intent_score || 0.50,
        raw_transcript: rawText
      }]).select();

      if (data) savedRecord = data[0];
      if (error) console.error("Supabase Insertion Error:", error);
    }
  }

  return {
    is_existing_lead_updated: isDuplicateUpdate,
    extracted_lead: parsedLead,
    db_record: savedRecord,
    fallback_used: usedFallback
  };
}

// 5. REST Lead Parsing Endpoint (Manual / App Calls)
app.post('/api/leads/parse', authenticateApiKey, async (req, res) => {
  try {
    const { rawText, phone_number } = req.body;
    if (!rawText) return res.status(400).json({ success: false, error: 'rawText is required' });

    const result = await processAndSaveLead(rawText, phone_number);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. Meta WhatsApp Webhook: GET Verification Handshake
app.get('/api/whatsapp/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log("WhatsApp Webhook Verified Successfully!");
    return res.status(200).send(challenge);
  }
  
  return res.sendStatus(403);
});

// 7. Meta WhatsApp Webhook: POST Message Ingestion
app.post('/api/whatsapp/webhook', async (req, res) => {
  try {
    const body = req.body;

    // Verify event origin from WhatsApp Business Account
    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const message = value?.messages?.[0];

      // Process only text messages
      if (message && message.type === 'text') {
        const fromPhoneNumber = `+${message.from}`; // Format e.g., +919999988888
        const messageText = message.text.body;

        console.log(`Received WhatsApp message from ${fromPhoneNumber}: "${messageText}"`);

        // Asynchronously process lead in background
        await processAndSaveLead(messageText, fromPhoneNumber);
      }

      // Always return 200 OK quickly to acknowledge receipt to Meta
      return res.status(200).send('EVENT_RECEIVED');
    }

    res.sendStatus(404);
  } catch (error) {
    console.error('WhatsApp Webhook Error:', error.message);
    res.status(500).send('Internal Server Error');
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
