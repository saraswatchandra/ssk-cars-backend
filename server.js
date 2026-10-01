// 4. Core Lead Processing & Storage Core Engine
async function processAndSaveLead(rawText, phone_number) {
  let parsedLead;
  let usedFallback = false;

  console.log(`Processing lead for phone: ${phone_number}, text: "${rawText}"`);

  // Step A: Claude NLP Extraction
  try {
    const response = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022', // Updated model name standard
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

  console.log("Parsed Lead Data:", JSON.stringify(parsedLead));
  console.log("Supabase Client Status:", supabase ? "Connected" : "NULL (Check Environment Variables!)");

  // Step B: Supabase Persistence with Deduplication
  let savedRecord = null;
  let isDuplicateUpdate = false;

  if (supabase) {
    let existingLead = null;

    if (phone_number) {
      const { data, fetchError } = await supabase
        .from('leads')
        .select('*')
        .eq('phone_number', phone_number)
        .maybeSingle();

      if (fetchError) console.error("Supabase Fetch Error:", fetchError);
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

      if (data) {
        savedRecord = data[0];
        console.log("Supabase Lead Updated Successfully:", savedRecord.id);
      }
      if (error) console.error("Supabase Update Error:", JSON.stringify(error));
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

      if (data) {
        savedRecord = data[0];
        console.log("Supabase New Lead Inserted Successfully:", savedRecord.id);
      }
      if (error) console.error("Supabase Insertion Error:", JSON.stringify(error));
    }
  } else {
    console.error("CRITICAL: Supabase client is not initialized! Check SUPABASE_URL and SUPABASE_ANON_KEY on Render.");
  }

  return {
    is_existing_lead_updated: isDuplicateUpdate,
    extracted_lead: parsedLead,
    db_record: savedRecord,
    fallback_used: usedFallback
  };
}
