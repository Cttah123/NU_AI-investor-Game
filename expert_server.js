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

// Store for predicted economic event (in-memory, reset on server restart)
let predictedEconEvent = null;

// Serve HTML
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "expert.html"));
});
app.get("/gameOver_expert.html", (req, res) => {
  res.sendFile(path.join(__dirname, "gameOver_expert.html"));
});

// /stocks endpoint (optimized with caching)
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
Generate 8 fictional stocks as JSON ONLY.
Each stock must include:
  - ticker (3-4 uppercase letters)
  - name (fictional company)
  - price (number between 1 and 500)
  - previousDayPrice (within ±10% of today's price)
  - priceChange (percentage change from previousDayPrice to price)
  - volatility (random % between 1 and 20, allow high-volatility stocks)
  - sector (short text either "Technology", "Healthcare", "Finance", "Energy", "Consumer Goods", or "Utilities")
  - tidbit (1-2 sentence description of the company and what it makes)
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
          typeof stock.volatility === "number" &&
          typeof stock.sector === "string" &&
          typeof stock.tidbit === "string"
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

// /simulateDays endpoint (optimized: reduced string ops, better fallback)
app.post("/simulateDays", async (req, res) => {
  const { stocks, days, predictions = [], currentDay, activeEconEffects = [] } = req.body;

  if (!Array.isArray(stocks) || !Number.isInteger(days) || days < 1) {
    return res.status(400).json({ error: "Invalid input" });
  }

  const cacheKey = `simulate_${currentDay}_${days}_${JSON.stringify({ predictions, activeEconEffects })}`; // Simplified key
  try {
    const { simulated, newEconEvents } = await getOrCacheResponse(cacheKey, async () => {
      // Determine if economic news should be generated
      const lastEconEventDay = activeEconEffects.length > 0
        ? Math.max(...activeEconEffects.map(e => e.startDay || currentDay))
        : 0;
      const daysSinceLastEvent = currentDay - lastEconEventDay;
      const generateEconEvent = daysSinceLastEvent >= 6 && Math.random() < (daysSinceLastEvent >= 10 ? 1 : 0.5);
      const sectors = ["Technology", "Healthcare", "Finance", "Energy", "Consumer Goods", "Utilities"];
      let newEconEvents = [];

      // Check if a predicted event is scheduled within the simulation days
      if (predictedEconEvent && predictedEconEvent.day >= currentDay + 1 && predictedEconEvent.day <= currentDay + days) {
        newEconEvents.push({
          sector: predictedEconEvent.sector,
          headline: predictedEconEvent.headline,
          daysLeft: predictedEconEvent.daysLeft,
          startDay: predictedEconEvent.day,
          direction: predictedEconEvent.direction
        });
        predictedEconEvent = null; // Clear prediction after use
      }

      // Generate new economic event if conditions are met and no predicted event is used
      if (generateEconEvent && !newEconEvents.length) {
        const sector = sectors[Math.floor(Math.random() * sectors.length)];
        const daysLast = 3 + Math.floor(Math.random() * 2); // 3-4 days
        const direction = Math.random() > 0.5 ? "positive" : "negative";
        newEconEvents.push({
          sector,
          headline: `${direction.charAt(0).toUpperCase() + direction.slice(1)} Market Shift in ${sector}`,
          daysLeft: daysLast,
          startDay: currentDay + 1,
          direction
        });
      }

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
- previousDayPrice: number
- priceChange: percentage change
- volatility: daily volatility used
- headline: short string (e.g., "Tech Boom" or "Q1 Earnings Call")
- description: brief string (e.g., "New product announced" or "Reports strong revenue")

Output JSON ONLY, no markdown, code blocks, or extra text.
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
          let prevPrice = stock.price; // Use current price as starting point
          for (let i = 0; i < days; i++) {
            const day = currentDay + i + 1;
            const isEarningsDay = day % 10 === 0;
            const quarter = isEarningsDay ? `Q${Math.floor(day / 10)}` : "";
            const performance = isEarningsDay ? (Math.random() > 0.5 ? "positive" : "negative") : "";
            const dailyVolatility = stock.volatility * (0.5 + Math.random());
            let priceChange = isEarningsDay ? (performance === "positive" ? 0.2 : -0.2) : (Math.random() - 0.5) * (dailyVolatility / 100);
            const price = Math.max(0.1, prevPrice * (1 + priceChange));
            const previousDayPrice = prevPrice;

            simulated.push({
              ticker: stock.ticker,
              day,
              price,
              previousDayPrice,
              priceChange: ((price - previousDayPrice) / previousDayPrice) * 100,
              volatility: dailyVolatility,
              headline: isEarningsDay ? `${quarter} Earnings Call` : `Update for ${stock.name}`,
              description: isEarningsDay
                ? performance === "positive"
                  ? `${stock.name} reports strong revenue growth`
                  : `${stock.name} misses earnings expectations`
                : `Price changed on day ${day}`
            });

            prevPrice = price; // Chain the price for next day
          }
        }
      }

      return { simulated, newEconEvents };
    });

    res.json({ simulated, newEconEvents });
  } catch (err) {
    console.error("Error in /simulateDays:", err.message);
    res.status(500).json({ error: "Failed to simulate days" });
  }
});

// /predictNews endpoint (optimized with caching)
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

// /predictEconEvent endpoint (no major changes needed, minor streamlining)
app.post("/predictEconEvent", async (req, res) => {
  const { currentDay, activeEconEffects = [] } = req.body;

  if (typeof currentDay !== "number") {
    return res.status(400).json({ error: "Invalid input" });
  }

  try {
    // Clear prediction if the predicted day has passed
    if (predictedEconEvent && currentDay >= predictedEconEvent.day) {
      predictedEconEvent = null;
    }

    // Return existing prediction if it hasn't passed
    if (predictedEconEvent) {
      return res.json(predictedEconEvent);
    }

    // Calculate days until next event
    const lastEconEventDay = activeEconEffects.length > 0
      ? Math.max(...activeEconEffects.map(e => e.startDay || currentDay))
      : 0;
    const daysSinceLastEvent = currentDay - lastEconEventDay;
    let daysUntilNext = 6 + Math.floor(Math.random() * 5); // 6-10 days
    if (daysSinceLastEvent >= 6) {
      daysUntilNext = Math.min(daysUntilNext, 10 - daysSinceLastEvent); // Respect 6-10 day rule
    }

    const sectors = ["Technology", "Healthcare", "Finance", "Energy", "Consumer Goods", "Utilities"];
    const sector = sectors[Math.floor(Math.random() * sectors.length)];
    const daysLast = 3 + Math.floor(Math.random() * 2); // 3-4 days
    const direction = Math.random() > 0.5 ? "positive" : "negative";
    const prediction = {
      sector,
      headline: `${direction.charAt(0).toUpperCase() + direction.slice(1)} Market Shift in ${sector}`,
      day: currentDay + daysUntilNext,
      daysLeft: daysLast,
      direction
    };

    // Store the prediction
    predictedEconEvent = prediction;
    res.json(prediction);
  } catch (err) {
    console.error("Error in /predictEconEvent:", err.message);
    res.status(500).json({ error: "Failed to generate economic event prediction" });
  }
});

// /analyzePerformance endpoint (fixed validation, added caching)
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

Provide a brief, casual analysis of the player's performance in plain text, though make it a bit short but informative. Mention any good or bad trades, overall strategy, and suggestions for improvement. The player started with $8000, so having more than $8000 at the end is a good sign.
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Expert server running at http://localhost:${PORT}`));