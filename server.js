const express = require('express');
const cors = require('cors');
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Initialize Anthropic Claude SDK
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = (supabaseUrl && supabaseKey) 
  ? createClient(supabaseUrl, supabaseKey) 
  : null;

function parseClaudeJSON(text) {
  try {
    const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error('Failed to parse AI JSON response: ' + err.message);
  }
}

// Root Status Endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'SSK CARS AI Backend Running',
    version: '1.0.0',
    database_connected: !!supabase
  });
});

// Feature 1: Lead Parse Endpoint
app.post('/api/leads/parse', async (req, res) => {
  try {
    const { rawText, phone_number } = req.body;
    if (!rawText) return res.status(400).json({ success: false, error: 'rawText is required' });

    const response = await anthropic.messages.create({
      model: 'claude-3-haiku-20240307', // Universally available across all Anthropic tiers
      max_tokens: 1000,
      system: `You are the Lead Parsing Engine for SSK Cars in Lucknow. Parse notes into raw JSON:
{
  "customer_name": string or null,
  "budget_max": number or null,
  "target_models": string[],
  "trade_in_car": string or null,
  "financing_required": boolean,
  "intent_score": number
}`,
      messages: [{ role: 'user', content: rawText }]
    });

    const parsedLead = parseClaudeJSON(response.content[0].text);

    let savedRecord = null;
    if (supabase) {
      const { data, error } = await supabase.from('leads').insert([{
        customer_name: parsedLead.customer_name || 'New Lead',
        phone_number: phone_number || null,
        budget_max: parsedLead.budget_max,
        target_models: parsedLead.target_models,
        trade_in_car: parsedLead.trade_in_car,
        financing_required: parsedLead.financing_required,
        intent_score: parsedLead.intent_score || 50,
        raw_transcript: rawText
      }]).select();

      if (data) savedRecord = data[0];
      if (error) console.error("Supabase Error:", error);
    }

    res.json({ success: true, extracted_lead: parsedLead, db_record: savedRecord });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
