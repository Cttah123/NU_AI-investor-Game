import 'dotenv/config'; // Loads .env into process.env
// printLLMResponse.js
import { OpenAI } from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY // Recommended: load from environment variable
});

export async function printLLMResponse(prompt) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: prompt }
    ]
  });

  console.log("LLM Response:", completion.choices[0].message.content.trim());
}
