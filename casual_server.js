import express from "express";
import path from "path";
import OpenAI from "openai";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config();

if (!process.env.OPENAI_API_KEY) {
  console.error("Error: OPENAI_API_KEY is not set in .env");
  process.exit(1);
}

const app = express();
app.use(express.json());

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Cache for OpenAI responses to avoid redundant calls (simple Map, expires after 5 min or on restart)
const responseCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Helper to get cached or new response with TTL
const getOrCacheResponse = async (key, fn) => {
  const cached = responseCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  const data = await fn();
  responseCache.set(key, { data, timestamp: Date.now() });
  return data;
};

// Serve HTML
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "casual.html"));
});
app.get("/gameOver_casual.html", (req, res) => {
  res.sendFile(path.join(__dirname, "gameOver_casual.html"));
});

// ----------------------
// /stocks endpoint (optimized with caching)
// ----------------------
app.get("/stocks", async (req, res) => {
  const cacheKey = 'stocks';
  try {
    const stocks = await getOrCacheResponse(cacheKey, async () => {
      const response = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: `
Generate 4 fictional stocks as JSON ONLY.
Each stock must include:
  - ticker (3-4 uppercase letters)
  - name (fictional company)
  - price (number between 1 and 500)
  - previousDayPrice (within ±10% of today's price)
  - priceChange (percentage change from previousDayPrice to price)
  - volatility (random % between 1 and 5)
Return a valid JSON array. Do not include markdown, code blocks, or any text outside the JSON array
`
          }
        ]
      });

      const content = response.choices[0].message.content;
      let stocks;
      try {
        stocks = JSON.parse(content);
        if (!Array.isArray(stocks)) throw new Error("Response is not an array");
        stocks = stocks.filter(stock =>
          stock &&
          typeof stock.ticker === "string" &&
          typeof stock.name === "string" &&
          typeof stock.price === "number" &&
          typeof stock.previousDayPrice === "number" &&
          typeof stock.priceChange === "number" &&
          typeof stock.volatility === "number"
        );
        if (stocks.length === 0) throw new Error("No valid stocks returned");
      } catch (parseErr) {
        throw new Error("Failed to parse stocks JSON");
      }
      return stocks;
    });

    res.json(stocks);
  } catch (err) {
    console.error("Error in /stocks:", err.message);
    res.status(500).json({ error: "Failed to generate stocks. Please try again later." });
  }
});

// ----------------------
// /simulateDays endpoint (optimized: reduced string ops, better fallback)
// ----------------------
app.post("/simulateDays", async (req, res) => {
  const { stocks, days, predictions = [], currentDay } = req.body;

  if (!Array.isArray(stocks) || !Number.isInteger(days) || days < 1) {
    return res.status(400).json({ error: "Invalid input" });
  }

  const cacheKey = `simulate_${currentDay}_${days}_${JSON.stringify({ predictions })}`; // Simplified key
  try {
    const simulated = await getOrCacheResponse(cacheKey, async () => {
      const prompt = `
Current day: ${currentDay}
Simulate ${days} day(s) for these stocks:
${JSON.stringify(stocks)}

Predictions:
${JSON.stringify(predictions)}

For each stock, generate exactly one entry per day from day ${currentDay + 1} to day ${currentDay + days}.
If a prediction exists for a stock on a given day:
- Bias price in that direction (e.g., increase for "rise", decrease for "fall")
- Not guaranteed; include randomness
- Ignore predictions for days <= ${currentDay}

On days that are multiples of 10 (e.g., 10, 20, 30):
- Generate an earnings call news item for each stock
- Headline: e.g., "Q1 Earnings Call" (use appropriate quarter, e.g., Q1 for day 10, Q2 for day 20, Q3 for day 30)
- Description: Indicate performance (e.g., "Reports strong revenue growth" or "Misses earnings expectations")
- Bias price significantly (e.g., ±20% for positive/negative earnings) but include randomness

For other days:
- Generate regular news with headline and description
- Price change: ±10% random change based on previous price

Return a JSON array with objects containing:
- ticker: matches stock ticker
- day: integer from ${currentDay + 1} to ${currentDay + days}
- price: number, based on previous price and influenced by predictions or earnings
- headline: short string (e.g., "Tech Boom" or "Q1 Earnings Call")
- description: brief string (e.g., "New product announced" or "Reports strong revenue")

Output JSON ONLY, no markdown, code blocks, or extra text.
Example: [{"ticker":"XYZT","day":${currentDay + 1},"price":150,"headline":"Market Update","description":"Price changed"}]
`;

      const response = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.9,
        messages: [{ role: "user", content: prompt }]
      });

      let content = response.choices[0].message.content.replace(/```json\n|\n```/g, "").trim();

      let simulated;
      try {
        simulated = JSON.parse(content);
        if (!Array.isArray(simulated)) throw new Error("Response is not an array");
        simulated = simulated.filter(s =>
          s.ticker &&
          typeof s.day === "number" &&
          s.day >= currentDay + 1 &&
          s.day <= currentDay + days &&
          typeof s.price === "number" &&
          s.price >= 0 &&
          typeof s.headline === "string" &&
          typeof s.description === "string"
        );
        if (simulated.length === 0) throw new Error("No valid simulation data");
      } catch (parseErr) {
        // Fallback simulation (optimized with for-of loop for better perf)
        simulated = [];
        for (const stock of stocks) {
          for (let i = 0; i < days; i++) {
            const day = currentDay + i + 1;
            const isEarningsDay = day % 10 === 0;
            const quarter = isEarningsDay ? `Q${Math.floor(day / 10)}` : "";
            const performance = isEarningsDay ? (Math.random() > 0.5 ? "positive" : "negative") : "";
            const priceChange = isEarningsDay ? (performance === "positive" ? 0.2 : -0.2) : (Math.random() - 0.5) * 0.2;
            const price = stock.price * (1 + priceChange);

            simulated.push({
              ticker: stock.ticker,
              day,
              price,
              headline: isEarningsDay ? `${quarter} Earnings Call` : `Update for ${stock.name}`,
              description: isEarningsDay
                ? performance === "positive"
                  ? `${stock.name} reports strong revenue growth`
                  : `${stock.name} misses earnings expectations`
                : `Price changed on day ${day}`
            });
          }
        }
      }

      return simulated;
    });

    res.json(simulated);
  } catch (err) {
    console.error("Error in /simulateDays:", err.message);
    res.status(500).json({ error: "Failed to simulate days" });
  }
});

// ----------------------
// /predictNews endpoint (optimized with caching)
// ----------------------
app.post("/predictNews", async (req, res) => {
  const { stocks, currentDay } = req.body;

  if (!Array.isArray(stocks) || typeof currentDay !== "number") {
    return res.status(400).json({ error: "Invalid input" });
  }

  const cacheKey = `predictNews_${currentDay}`;
  try {
    const prediction = await getOrCacheResponse(cacheKey, async () => {
      const response = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.9,
        messages: [
          {
            role: "user",
            content: `
From these stocks:
${JSON.stringify(stocks)}

Generate 1 prediction as JSON:
- ticker: must match one stock's ticker
- day: integer between ${currentDay + 1} and ${currentDay + 7}
- direction: "rise" or "fall"

Return JSON ONLY, no markdown, code blocks, or extra text.
Example: {"ticker":"XYZT","day":${currentDay + 3},"direction":"rise"}
`
          }
        ]
      });

      let content = response.choices[0].message.content.replace(/```json\n|\n```/g, "").trim();

      let prediction;
      try {
        prediction = JSON.parse(content);
        if (!prediction.ticker || !Number.isInteger(prediction.day) || !["rise", "fall"].includes(prediction.direction)) {
          throw new Error("Invalid prediction format");
        }
        if (!stocks.some(stock => stock.ticker === prediction.ticker)) {
          throw new Error("Prediction ticker does not match any stock");
        }
        if (prediction.day < currentDay + 1 || prediction.day > currentDay + 7) {
          throw new Error("Prediction day out of range");
        }
      } catch (parseErr) {
        const randomStock = stocks[Math.floor(Math.random() * stocks.length)];
        prediction = {
          ticker: randomStock.ticker,
          day: currentDay + Math.floor(Math.random() * 7) + 1,
          direction: Math.random() > 0.5 ? "rise" : "fall"
        };
      }
      return prediction;
    });

    res.json(prediction);
  } catch (err) {
    console.error("Error in /predictNews:", err.message);
    res.status(500).json({ error: "Failed to generate prediction" });
  }
});

// ----------------------
// /analyzePerformance endpoint (fixed validation, added caching)
// ----------------------
app.post("/analyzePerformance", async (req, res) => {
  const { log, portfolio, budget } = req.body;

  // Fixed: Parse log if it's a string, then validate
  const parsedLog = typeof log === 'string' ? JSON.parse(log) : log;
  if (!Array.isArray(parsedLog) || typeof portfolio !== "object" || typeof budget !== "number") {
    return res.status(400).json({ error: "Invalid input" });
  }

  const cacheKey = `analyze_${JSON.stringify({ log: parsedLog, portfolio, budget })}`;
  try {
    const { analysis } = await getOrCacheResponse(cacheKey, async () => {
      const analysisResponse = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: `
You are given the following trading run data:
Activity log (JSON array): ${JSON.stringify(parsedLog)}
Portfolio: ${JSON.stringify(portfolio)}
Final budget: ${budget.toFixed(2)}

Provide a brief, casual analysis of the player's performance in plain text, though make it a bit short. Mention any good or bad trades, overall strategy, and suggestions for improvement. The player started with $1000, so having more than $1000 at the end is a good sign.
`
          }
        ]
      });

      const analysis = analysisResponse.choices[0].message.content.trim();
      return { analysis };
    });

    res.json({ analysis });
  } catch (err) {
    console.error("Error in /analyzePerformance:", err.message);
    res.status(500).json({ error: "Failed to analyze performance" });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Casual server running at http://localhost:${PORT}`));