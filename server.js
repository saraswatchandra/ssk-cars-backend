const express = require('express');
const cors = require('cors');
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Clean API key of unintended spaces or quotes
const cleanApiKey = process.env.ANTHROPIC_API_KEY 
  ? process.env.ANTHROPIC_API_KEY.replace(/['"]/g, '').trim() 
  : '';

const anthropic = new Anthropic({ apiKey: cleanApiKey });

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

// Fallback rule-based parser in case Anthropic API fails
function fallbackParse(text) {
  const nameMatch = text.match(/([A-Z][a-z]+\s[A-Z][a-z]+|[A-Z][a-z]+)/);
  const budgetMatch = text.match(/(\d+)\s*(Lakhs|Lakh|L)/i);
  
  return {
    customer_name: nameMatch ? nameMatch[0] : 'New Lead',
    budget_max: budgetMatch ? parseInt(budgetMatch[1]) * 100000 : null,
    target_models: ["Inquired Vehicle"],
    trade_in_car: text.toLowerCase().includes('trade') || text.toLowerCase().includes('trading') ? 'Exchange Vehicle' : null,
    financing_required: text.toLowerCase().includes('loan') || text.toLowerCase().includes('finance'),
    intent_score: 75
  };
}

app.get('/', (req, res) => {
  res.json({
    status: 'SSK CARS AI Backend Running',
    version: '1.0.0',
    database_connected: !!supabase
  });
});

app.post('/api/leads/parse', async (req, res) => {
  try {
    const { rawText, phone_number } = req.body;
    if (!rawText) return res.status(400).json({ success: false, error: 'rawText is required' });

    let parsedLead;
    let usedFallback = false;

    try {
      const response = await anthropic.messages.create({
      model: 'claude-3-5-haiku-latest',
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

      parsedLead = parseClaudeJSON(response.content[0].text);
    } catch (aiError) {
      console.error("Anthropic API Error, switching to fallback parser:", aiError.message);
      parsedLead = fallbackParse(rawText);
      usedFallback = true;
    }

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
      if (error) console.error("Supabase Insertion Error:", error);
    }

    res.json({ 
      success: true, 
      extracted_lead: parsedLead, 
      db_record: savedRecord,
      fallback_used: usedFallback
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
