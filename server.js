const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { Anthropic } = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();
app.use(express.json());

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

// Initialize Anthropic Client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Middleware: Authentication Guard
const authenticateApiKey = (req, res, next) => {
  const authHeader = req.headers['x-api-key'] || req.headers['authorization'];
  const secretKey = process.env.API_SECRET_KEY;

  if (secretKey && authHeader !== secretKey && authHeader !== `Bearer ${secretKey}`) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid or missing API key' });
  }
  next();
};

// JSON Parsing Helper for Claude Response
function parseClaudeJSON(text) {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return JSON.parse(text);
  } catch (err) {
    throw new Error('Failed to parse Claude JSON output');
  }
}

// Fallback Regex Parser for Zero-Downtime Resilience
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

// Lead Parsing Endpoint
app.post('/api/leads/parse', authenticateApiKey, async (req, res) => {
  try {
    const { rawText, phone_number } = req.body;
    if (!rawText) return res.status(400).json({ success: false, error: 'rawText is required' });

    let parsedLead;
    let usedFallback = false;

    // 1. Primary AI Extraction via Anthropic
    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1000,
        system: `You are the Lead Parsing Engine for SSK Cars in Lucknow. Parse raw dealer notes into this strict JSON format:
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

    // 2. Supabase Storage with Phone Deduplication
    let savedRecord = null;
    let isDuplicateUpdate = false;

    if (supabase) {
      let existingLead = null;

      // Check if lead already exists by phone number
      if (phone_number) {
        const { data } = await supabase
          .from('leads')
          .select('*')
          .eq('phone_number', phone_number)
          .maybeSingle();

        existingLead = data;
      }

      if (existingLead) {
        // UPDATE EXISTING LEAD (Merge car models & append transcript)
        isDuplicateUpdate = true;
        
        const mergedModels = Array.from(new Set([
          ...(existingLead.target_models || []),
          ...(parsedLead.target_models || [])
        ]));

        const updatedTranscript = `${existingLead.raw_transcript}\n\n[Follow-up Note]: ${rawText}`;

        const { data, error } = await supabase
          .from('leads')
          .update({
            customer_name: parsedLead.customer_name || existingLead.customer_name,
            budget_max: parsedLead.budget_max || existingLead.budget_max,
            target_models: mergedModels,
            trade_in_car: parsedLead.trade_in_car || existingLead.trade_in_car,
            financing_required: parsedLead.financing_required ?? existingLead.financing_required,
            intent_score: parsedLead.intent_score || existingLead.intent_score,
            raw_transcript: updatedTranscript
          })
          .eq('id', existingLead.id)
          .select();

        if (data) savedRecord = data[0];
        if (error) console.error("Deduplication Update Error:", error);
      } else {
        // INSERT NEW LEAD
        const { data, error } = await supabase.from('leads').insert([{
          customer_name: parsedLead.customer_name || 'New Lead',
          phone_number: phone_number || null,
          budget_max: parsedLead.budget_max,
          target_models: parsedLead.target_models,
          trade_in_car: parsedLead.trade_in_car,
          financing_required: parsedLead.financing_required,
          intent_score: parsedLead.intent_score || 0.50,
          raw_transcript: rawText
        }]).select();

        if (data) savedRecord = data[0];
        if (error) console.error("Supabase Insertion Error:", error);
      }
    }

    res.json({
      success: true,
      is_existing_lead_updated: isDuplicateUpdate,
      extracted_lead: parsedLead,
      db_record: savedRecord,
      fallback_used: usedFallback
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
