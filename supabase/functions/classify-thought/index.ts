/**
 * Classify-Thought Edge Function
 *
 * Analyzes a message and returns structured metadata:
 * type, topics, people, action_items, is_memorable.
 *
 * Used by the relay to auto-detect facts/decisions/goals
 * without requiring explicit [REMEMBER:] tags.
 *
 * Secrets required:
 *   OPENAI_API_KEY — stored in Supabase Edge Function secrets
 *
 * POST body:
 *   { content: string, role?: "user" | "assistant" }
 *
 * Returns:
 *   { type, topics, people, action_items, is_memorable, summary }
 */

Deno.serve(async (req) => {
  try {
    const { content, role = "user" } = await req.json();

    if (!content) {
      return new Response("Missing content", { status: 400 });
    }

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      return new Response("OPENAI_API_KEY not configured", { status: 500 });
    }

    const systemPrompt = `You are a message classifier for a personal AI assistant. Analyze the user message and extract structured metadata. Respond ONLY with valid JSON, no markdown.

Rules:
- type: one of "observation", "task", "idea", "reference", "decision", "question", "greeting"
- topics: array of 1-3 short topic keywords (lowercase, in the language of the message)
- people: array of names mentioned (empty if none)
- action_items: array of actionable items detected (empty if none)
- is_memorable: true if this message contains a fact, decision, preference, or important information worth remembering long-term. false for greetings, small talk, simple questions, or transient messages.
- summary: one sentence summary of the message content (in the same language as the message)

Be conservative with is_memorable — only flag truly important information.`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `[${role}]: ${content}` },
        ],
        temperature: 0,
        max_tokens: 300,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return new Response(`OpenAI error: ${err}`, { status: 500 });
    }

    const completion = await response.json();
    const raw = completion.choices[0]?.message?.content || "{}";

    // Parse the JSON response, handle potential markdown wrapping
    let cleaned = raw.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const classification = JSON.parse(cleaned);

    return new Response(JSON.stringify(classification), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(String(error), { status: 500 });
  }
});
