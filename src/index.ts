import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

interface GeoResult {
  lat: number;
  lon: number;
  name: string;
}

interface DailyData {
  time: string[];
  temperature_2m_max: number[];
  temperature_2m_min: number[];
}

async function geocode(location: string): Promise<GeoResult> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=5&language=en&format=json`;
  const res = await fetch(url);
  const data = (await res.json()) as {
    results?: Array<{ latitude: number; longitude: number; name: string; country_code: string }>;
  };
  if (!data.results?.length) {
    throw new Error(`Location not found: "${location}". Try a city name like Tel Aviv, Jerusalem, Haifa, or Eilat.`);
  }
  // Prefer results in Israel (IL), fall back to first result
  const match = data.results.find((r) => r.country_code === "IL") ?? data.results[0];
  return { lat: match.latitude, lon: match.longitude, name: match.name };
}

async function fetchTemps(lat: number, lon: number, dateFrom: string, dateTo: string): Promise<DailyData> {
  const today = new Date().toISOString().split("T")[0];
  // Use archive API for fully historical ranges, forecast API otherwise
  const base =
    dateTo <= today
      ? "https://archive-api.open-meteo.com/v1/archive"
      : "https://api.open-meteo.com/v1/forecast";

  const url =
    `${base}?latitude=${lat}&longitude=${lon}` +
    `&start_date=${dateFrom}&end_date=${dateTo}` +
    `&daily=temperature_2m_max,temperature_2m_min` +
    `&timezone=Asia%2FJerusalem`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather API error: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { daily: DailyData };
  return data.daily;
}

const LISTED_CITIES = ["tel-aviv", "jerusalem", "haifa", "eilat", "beer-sheva", "tiberias"];

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "weather-israel", version: "1.0.0" });

  server.registerTool(
    "get_temperature",
    {
      description: "Get the min/max temperature for a location in Israel on a specific date. Works for past dates and forecasts up to 16 days ahead.",
      inputSchema: {
        location: z
          .string()
          .describe(
            "City or area in Israel, e.g. Tel Aviv, Jerusalem, Haifa, Eilat, Dead Sea, Tiberias, Nazareth, Beer Sheva"
          ),
        date: z.string().describe("Date in YYYY-MM-DD format"),
      },
    },
    async ({ location, date }) => {
      const { lat, lon, name } = await geocode(location);
      const daily = await fetchTemps(lat, lon, date, date);
      const i = daily.time.indexOf(date);
      if (i === -1)
        throw new Error(`No data for ${date}. Forecast is limited to 16 days ahead; older historical data is also available.`);
      return {
        content: [
          {
            type: "text" as const,
            text: `${name} on ${date}: max ${daily.temperature_2m_max[i]}°C, min ${daily.temperature_2m_min[i]}°C`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_temperature_range",
    {
      description: "Get day-by-day min/max temperatures for a location in Israel over a date range. Ideal for trip planning. Forecast available up to 16 days ahead; older dates return historical data.",
      inputSchema: {
        location: z
          .string()
          .describe(
            "City or area in Israel, e.g. Tel Aviv, Jerusalem, Haifa, Eilat, Dead Sea, Tiberias, Nazareth, Beer Sheva"
          ),
        date_from: z.string().describe("Start date in YYYY-MM-DD format"),
        date_to: z.string().describe("End date in YYYY-MM-DD format"),
      },
    },
    async ({ location, date_from, date_to }) => {
      const { lat, lon, name } = await geocode(location);
      const daily = await fetchTemps(lat, lon, date_from, date_to);
      const rows = daily.time.map(
        (d, i) =>
          `${d}: max ${daily.temperature_2m_max[i]}°C, min ${daily.temperature_2m_min[i]}°C`
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `${name} temperatures (${date_from} → ${date_to}):\n${rows.join("\n")}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_average_temperature",
    {
      description: "Get the average temperature for a location in Israel over a date range. Returns the mean of daily averages ((max+min)/2) across all days in the range. Useful for comparing periods or summarising seasonal data.",
      inputSchema: {
        location: z
          .string()
          .describe(
            "City or area in Israel, e.g. Tel Aviv, Jerusalem, Haifa, Eilat, Dead Sea, Tiberias, Nazareth, Beer Sheva"
          ),
        date_from: z.string().describe("Start date in YYYY-MM-DD format"),
        date_to: z.string().describe("End date in YYYY-MM-DD format"),
      },
    },
    async ({ location, date_from, date_to }) => {
      if (date_from > date_to) throw new Error(`date_from (${date_from}) must be on or before date_to (${date_to}).`);
      const { lat, lon, name } = await geocode(location);
      const daily = await fetchTemps(lat, lon, date_from, date_to);
      const count = daily.temperature_2m_max.length;
      if (count === 0) throw new Error(`No temperature data for ${name} between ${date_from} and ${date_to}.`);
      const sum = daily.temperature_2m_max.reduce((acc, max, i) => {
        const min = daily.temperature_2m_min[i];
        if (max == null || min == null) throw new Error(`Missing temperature data for ${name} on ${daily.time[i]}.`);
        return acc + (max + min) / 2;
      }, 0);
      const avg = (sum / count).toFixed(1);
      return {
        content: [
          {
            type: "text" as const,
            text: `${name} average temperature (${date_from} → ${date_to}): ${avg}°C (mean of ${count} day${count === 1 ? "" : "s"})`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_extreme_day",
    {
      description: "Find the hottest or coldest day for a location in Israel within a date range. Returns the date, max, and min temperature for that day.",
      inputSchema: {
        location: z
          .string()
          .describe(
            "City or area in Israel, e.g. Tel Aviv, Jerusalem, Haifa, Eilat, Dead Sea, Tiberias, Nazareth, Beer Sheva"
          ),
        date_from: z.string().describe("Start date in YYYY-MM-DD format"),
        date_to: z.string().describe("End date in YYYY-MM-DD format"),
        extreme: z.enum(["hottest", "coldest"]).describe("Whether to find the hottest or coldest day"),
      },
    },
    async ({ location, date_from, date_to, extreme }) => {
      if (date_from > date_to) throw new Error(`date_from (${date_from}) must be on or before date_to (${date_to}).`);
      const { lat, lon, name } = await geocode(location);
      const daily = await fetchTemps(lat, lon, date_from, date_to);
      const count = daily.time.length;
      if (count === 0) throw new Error(`No temperature data for ${name} between ${date_from} and ${date_to}.`);

      let bestIdx = 0;
      for (let i = 0; i < count; i++) {
        const max = daily.temperature_2m_max[i];
        const min = daily.temperature_2m_min[i];
        if (max == null || min == null) throw new Error(`Missing temperature data for ${name} on ${daily.time[i]}.`);
        if (extreme === "hottest" ? max > daily.temperature_2m_max[bestIdx] : min < daily.temperature_2m_min[bestIdx]) {
          bestIdx = i;
        }
      }

      const date = daily.time[bestIdx];
      const max = daily.temperature_2m_max[bestIdx];
      const min = daily.temperature_2m_min[bestIdx];
      return {
        content: [
          {
            type: "text" as const,
            text: `${name} ${extreme} day (${date_from} → ${date_to}): ${date} — max ${max}°C, min ${min}°C`,
          },
        ],
      };
    }
  );

  // ─── RESOURCE ────────────────────────────────────────────────────────────────
  //
  // A Resource is a URI-addressable, read-only data snapshot that the client can
  // fetch at any time without the model having to "call" anything. It works like
  // a file or an API endpoint that the client (e.g. Claude Desktop) can attach to
  // a conversation as background context.
  //
  // Why it's useful here: instead of the model calling get_temperature every time
  // it needs today's weather, a client can subscribe to weather://tel-aviv/today
  // and have the data available passively. This is great for dashboards, sidebars,
  // or any UI that wants to display live data alongside a chat.
  //
  // URI pattern:  weather://{city}/today
  // The {city} segment is a template variable — one registration handles all cities.

  server.registerResource(
    "city-today-weather",
    new ResourceTemplate("weather://{city}/today", {
      list: async () => ({
        resources: LISTED_CITIES.map((city) => ({
          name: `${city} – today`,
          uri: `weather://${city}/today`,
          mimeType: "text/plain",
        })),
      }),
    }),
    { description: "Today's min/max temperature for any Israeli city" },
    async (uri, { city }) => {
      const { lat, lon, name } = await geocode(city as string);
      const today = new Date().toISOString().split("T")[0];
      const daily = await fetchTemps(lat, lon, today, today);
      const i = daily.time.indexOf(today);
      const text =
        i === -1
          ? `No data available for ${name} today.`
          : `${name} today (${today}): max ${daily.temperature_2m_max[i]}°C, min ${daily.temperature_2m_min[i]}°C`;
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
    }
  );

  // ─── PROMPT ──────────────────────────────────────────────────────────────────
  //
  // A Prompt is a reusable message template that the server pre-fills with live
  // data before handing it to the model. The client calls it with typed arguments
  // and gets back a ready-to-send messages array — data fetching happens server-
  // side, not in the prompt text.
  //
  // Why it's useful here: instead of the user typing "what should I pack for Tel
  // Aviv from June 20 to June 25?" and hoping Claude decides to call the tool, a
  // client can surface a "Trip Packing Advice" button. Clicking it calls this
  // prompt, fetches the forecast, and opens a conversation that already has the
  // weather data embedded — no extra round-trip needed.

  server.registerPrompt(
    "trip-packing-advice",
    {
      description: "Fetch the forecast for a trip and ask the model what to pack",
      argsSchema: {
        city: z.string().describe("City in Israel"),
        date_from: z.string().describe("Trip start date (YYYY-MM-DD)"),
        date_to: z.string().describe("Trip end date (YYYY-MM-DD)"),
      },
    },
    async ({ city, date_from, date_to }) => {
      const { lat, lon, name } = await geocode(city);
      const daily = await fetchTemps(lat, lon, date_from, date_to);
      const rows = daily.time.map(
        (d, i) =>
          `${d}: max ${daily.temperature_2m_max[i]}°C, min ${daily.temperature_2m_min[i]}°C`
      );
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `I'm planning a trip to ${name} from ${date_from} to ${date_to}.\n` +
                `Here is the weather forecast:\n\n${rows.join("\n")}\n\n` +
                `What should I pack?`,
            },
          },
        ],
      };
    }
  );

  // ─── SAMPLING ────────────────────────────────────────────────────────────────
  //
  // Sampling flips the usual direction: the *server* asks the *client* to run an
  // LLM completion on its behalf. The server fetches data, composes a prompt, and
  // then asks Claude (via the client) to turn it into natural language — all
  // within a single tool call, without the client having to orchestrate anything.
  //
  // Why it's useful here: the tools above return raw numbers. With sampling this
  // tool returns a fully written, human-friendly weather briefing. The server
  // controls the prompt and the output format; the client just provides the model.
  //
  // Note: sampling requires the connected client to advertise the "sampling"
  // capability (Claude Desktop does; not all clients do). The tool gracefully
  // degrades to the raw forecast if sampling is unavailable.

  server.registerTool(
    "get_weather_briefing",
    {
      description: "Get a human-friendly weather briefing for a trip, written by the model based on the forecast data.",
      inputSchema: {
        location: z.string().describe("City or area in Israel"),
        date_from: z.string().describe("Start date in YYYY-MM-DD format"),
        date_to: z.string().describe("End date in YYYY-MM-DD format"),
      },
    },
    async ({ location, date_from, date_to }) => {
      const { lat, lon, name } = await geocode(location);
      const daily = await fetchTemps(lat, lon, date_from, date_to);
      const rows = daily.time.map(
        (d, i) =>
          `${d}: max ${daily.temperature_2m_max[i]}°C, min ${daily.temperature_2m_min[i]}°C`
      );
      const forecast = rows.join("\n");

      // Ask the client's LLM to turn the raw numbers into a friendly briefing.
      const samplingResult = await server.server.createMessage({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Here is the weather forecast for ${name} (${date_from} to ${date_to}):\n\n` +
                `${forecast}\n\n` +
                `Write a short, friendly 2-3 sentence travel weather briefing. ` +
                `Mention temperature range, how it feels, and one practical tip.`,
            },
          },
        ],
        maxTokens: 200,
      });

      const briefing =
        samplingResult.content.type === "text"
          ? samplingResult.content.text
          : forecast; // fallback if client returns non-text

      return { content: [{ type: "text" as const, text: briefing }] };
    }
  );

  return server;
}

if (process.env.MCP_TRANSPORT === "http") {
  const { createServer } = await import("node:http");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );

  const port = Number(process.env.PORT ?? 3000);

  // In stateless mode each request gets its own server + transport instance.
  // Sharing a single instance causes the transport to close after the first
  // SSE response, breaking all subsequent requests.
  const httpServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;

    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      res.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (err) {
      process.stderr.write(`HTTP handler error: ${err}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    }
  });

  httpServer.listen(port, () => {
    process.stderr.write(`MCP HTTP server listening on port ${port}\n`);
  });
} else {
  const transport = new StdioServerTransport();
  await createMcpServer().connect(transport);
}
