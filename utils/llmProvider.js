const generateText = async (prompt) => {
    const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;

    if (!apiKey) {
        console.log('[LLM Provider] No API key configured, returning mock response');
        return `[MOCK AI RESPONSE] Processed prompt: "${prompt.substring(0, 80)}..."`;
    }

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: process.env.LLM_MODEL || 'gpt-4o-mini',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 500,
                temperature: 0.7,
            }),
        });

        if (!response.ok) {
            console.error(`[LLM Provider] API error: ${response.status} ${response.statusText}`);
            return `[MOCK AI RESPONSE] API unavailable (${response.status}). Processed prompt: "${prompt.substring(0, 80)}..."`;
        }

        const data = await response.json();
        return data.choices?.[0]?.message?.content || '[MOCK AI RESPONSE] No content returned.';
    } catch (error) {
        console.error('[LLM Provider] Network error:', error.message);
        return `[MOCK AI RESPONSE] Network error. Processed prompt: "${prompt.substring(0, 80)}..."`;
    }
};

module.exports = { generateText };
