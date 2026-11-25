// Agenda por Voz - servidor
// Fluxo: áudio -> transcrição (OpenAI) -> Claude extrai o(s) compromisso(s) -> salva na agenda do app (SQLite)

import express from "express";
import multer from "multer";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { timingSafeEqual, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const TZ = process.env.TZ || "America/Sao_Paulo";
const APP_PIN = process.env.APP_PIN || "1234";

// ---------- Banco de dados ----------
mkdirSync(path.join(__dirname, "data"), { recursive: true });
const db = new DatabaseSync(path.join(__dirname, "data", "agenda.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    date TEXT NOT NULL,          -- AAAA-MM-DD
    start TEXT,                  -- HH:MM (null = dia inteiro)
    end TEXT,                    -- HH:MM
    location TEXT,
    notes TEXT,
    source TEXT NOT NULL DEFAULT 'manual',  -- 'voz' ou 'manual'
    transcript TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
`);

const insertEvent = db.prepare(`
  INSERT INTO events (id, title, date, start, end, location, notes, source, transcript)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// ---------- Validação ----------
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const EventInput = z.object({
  title: z.string().trim().min(1).max(200),
  date: z.string().regex(DATE),
  start: z.string().regex(TIME).nullable().optional(),
  end: z.string().regex(TIME).nullable().optional(),
  location: z.string().max(300).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

// ---------- IA ----------
const anthropic = new Anthropic(); // lê ANTHROPIC_API_KEY

// Schema que o Claude é obrigado a seguir (structured outputs)
const extractionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "query_from", "query_to", "events", "reply"],
  properties: {
    intent: {
      type: "string",
      enum: ["agendar", "consultar"],
      description: "agendar = a pessoa quer marcar compromisso(s); consultar = a pessoa pergunta o que tem marcado",
    },
    query_from: { type: ["string", "null"], description: "Se consultar: primeiro dia do período perguntado (AAAA-MM-DD)" },
    query_to: { type: ["string", "null"], description: "Se consultar: último dia do período perguntado (AAAA-MM-DD). Um dia só = igual a query_from" },
    events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "date", "start", "end", "location", "notes"],
        properties: {
          title: { type: "string", description: "Título curto do compromisso" },
          date: { type: "string", description: "Data no formato AAAA-MM-DD" },
          start: { type: ["string", "null"], description: "Hora de início HH:MM (24h) ou null se dia inteiro" },
          end: { type: ["string", "null"], description: "Hora de fim HH:MM (24h) ou null" },
          location: { type: ["string", "null"] },
          notes: { type: ["string", "null"], description: "Detalhes extras ditos no áudio (nome do cliente, telefone, valor...)" },
        },
      },
    },
    reply: { type: "string", description: "Frase curta em português confirmando o que foi agendado, ou explicando o que faltou" },
  },
};

const ExtractionResult = z.object({
  intent: z.enum(["agendar", "consultar"]),
  query_from: z.string().regex(DATE).nullable(),
  query_to: z.string().regex(DATE).nullable(),
  events: z.array(EventInput),
  reply: z.string(),
});

function todayInfo() {
  const now = new Date();
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(now); // AAAA-MM-DD
  const weekday = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, weekday: "long" }).format(now);
  const time = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(now);
  return { date, weekday, time };
}

async function transcribe(buffer, mimetype, filename) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurada no .env");
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimetype || "audio/webm" }), filename || "audio.webm");
  form.append("model", "gpt-4o-mini-transcribe");
  form.append("language", "pt");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Falha na transcrição (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return (data.text || "").trim();
}

async function extractEvents(text) {
  const t = todayInfo();
  const system = `Você é o assistente de uma agenda pessoal. O usuário fala (por áudio já transcrito) e você decide se ele quer AGENDAR ou CONSULTAR.
Hoje é ${t.weekday}, ${t.date}, agora são ${t.time} (fuso ${TZ}).

CONSULTAR: quando a pessoa pergunta o que tem marcado ("o que eu tenho dia 15?", "tenho algo amanhã?", "como está minha semana?").
- intent = "consultar", events = [], preencha query_from e query_to (semana = segunda a domingo da semana citada; "esta semana" = de hoje até domingo).
- reply pode ficar vazio; o sistema monta a resposta com os compromissos reais.

AGENDAR: quando a pessoa fala um ou mais compromissos para marcar.
- intent = "agendar", query_from e query_to = null.
Regras para agendar:
- Resolva datas relativas ("amanhã", "sexta que vem", "dia 15") para AAAA-MM-DD a partir de hoje. "Sexta" sem mais nada = a próxima sexta a partir de hoje (se hoje for sexta e o horário ainda não passou, é hoje).
- Horário em 24h. "3 da tarde" = 15:00; "meio-dia" = 12:00; "de manhã" sem hora = deixe start null e cite "manhã" nas notas.
- Se não disser a duração, deixe end null.
- Título curto e claro (ex.: "Reunião com João", "Dentista"). Coloque o resto em notes.
- Se o áudio não tiver nenhum compromisso claro (sem data dá para assumir hoje só se a pessoa disser "hoje"), devolva events vazio e explique em reply o que faltou.
- reply: uma frase curta, simpática, em português do Brasil.`;

  const response = await anthropic.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: extractionSchema },
    },
    system,
    messages: [{ role: "user", content: text }],
  });

  if (response.stop_reason === "refusal") {
    return { intent: "agendar", query_from: null, query_to: null, events: [], reply: "Não consegui processar esse pedido. Tente falar de outro jeito." };
  }
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("Resposta da IA sem texto");
  const parsed = ExtractionResult.safeParse(JSON.parse(textBlock.text));
  if (!parsed.success) throw new Error("A IA devolveu um formato inesperado");
  return parsed.data;
}

function saveEvents(events, source, transcript) {
  const saved = [];
  for (const e of events) {
    const id = randomUUID();
    insertEvent.run(id, e.title, e.date, e.start ?? null, e.end ?? null, e.location ?? null, e.notes ?? null, source, transcript ?? null);
    saved.push({ id, ...e, source });
  }
  return saved;
}

const fmtLong = new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });
const fmtShortDay = new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", weekday: "short", day: "numeric" });
const isoToDate = (s) => new Date(`${s}T12:00:00Z`);

// Consulta a agenda e monta a resposta com os compromissos reais (nada inventado pela IA)
function answerQuery(from, to) {
  if (to < from) [from, to] = [to, from];
  const rows = db
    .prepare(`SELECT * FROM events WHERE date BETWEEN ? AND ? ORDER BY date, COALESCE(start, '00:00'), created_at`)
    .all(from, to);
  const oneDay = from === to;
  const label = oneDay ? fmtLong.format(isoToDate(from)) : `${fmtShortDay.format(isoToDate(from))} a ${fmtShortDay.format(isoToDate(to))}`;
  if (!rows.length) return { rows, reply: `Você não tem nada marcado ${oneDay ? "em" : "de"} ${label}. 🙂` };
  const lines = rows.map((e) => {
    const when = e.start ? (e.end ? `${e.start}–${e.end}` : e.start) : "dia todo";
    const day = oneDay ? "" : `${fmtShortDay.format(isoToDate(e.date))} · `;
    return `• ${day}${when} — ${e.title}${e.location ? ` (${e.location})` : ""}`;
  });
  const n = rows.length;
  return { rows, reply: `${oneDay ? `Em ${label}` : `De ${label}`} você tem ${n} compromisso${n > 1 ? "s" : ""}:\n${lines.join("\n")}` };
}

// Processa o que foi dito (áudio transcrito ou texto digitado)
async function handleUtterance(transcript) {
  const result = await extractEvents(transcript);
  if (result.intent === "consultar" && result.query_from) {
    const { rows, reply } = answerQuery(result.query_from, result.query_to || result.query_from);
    return { transcript, intent: "consultar", from: result.query_from, to: result.query_to || result.query_from, events: rows, reply };
  }
  return { transcript, intent: "agendar", events: saveEvents(result.events, "voz", transcript), reply: result.reply };
}

// ---------- App ----------
const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Proteção simples por PIN
function requirePin(req, res, next) {
  const given = Buffer.from(String(req.get("x-pin") || ""));
  const expected = Buffer.from(APP_PIN);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return res.status(401).json({ error: "PIN inválido" });
  }
  next();
}
app.use("/api", requirePin);

app.get("/api/ping", (_req, res) => res.json({ ok: true }));

// Lista eventos de um intervalo: /api/events?from=2026-11-01&to=2026-11-30
app.get("/api/events", (req, res) => {
  const { from, to } = req.query;
  if (!DATE.test(String(from)) || !DATE.test(String(to))) return res.status(400).json({ error: "from/to inválidos" });
  const rows = db
    .prepare(`SELECT * FROM events WHERE date BETWEEN ? AND ? ORDER BY date, COALESCE(start, '00:00'), created_at`)
    .all(from, to);
  res.json(rows);
});

app.post("/api/events", (req, res) => {
  const parsed = EventInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos" });
  res.status(201).json(saveEvents([parsed.data], "manual")[0]);
});

app.put("/api/events/:id", (req, res) => {
  const parsed = EventInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos" });
  const e = parsed.data;
  const r = db
    .prepare(`UPDATE events SET title=?, date=?, start=?, end=?, location=?, notes=? WHERE id=?`)
    .run(e.title, e.date, e.start ?? null, e.end ?? null, e.location ?? null, e.notes ?? null, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: "Não encontrado" });
  res.json({ id: req.params.id, ...e });
});

app.delete("/api/events/:id", (req, res) => {
  db.prepare(`DELETE FROM events WHERE id=?`).run(req.params.id);
  res.status(204).end();
});

// Áudio -> agenda
app.post("/api/voice", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Nenhum áudio enviado" });
    const transcript = await transcribe(req.file.buffer, req.file.mimetype, req.file.originalname);
    if (!transcript) return res.json({ transcript: "", intent: "agendar", events: [], reply: "Não ouvi nada no áudio. Tente de novo." });
    res.json(await handleUtterance(transcript));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Erro ao processar áudio" });
  }
});

// Texto -> agenda (mesmo fluxo, sem transcrição; útil para digitar ou testar)
app.post("/api/text", async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim().slice(0, 2000);
    if (!text) return res.status(400).json({ error: "Texto vazio" });
    res.json(await handleUtterance(text));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Erro ao processar texto" });
  }
});

app.listen(PORT, () => {
  console.log(`Agenda por Voz rodando em http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn("Aviso: ANTHROPIC_API_KEY não configurada");
  if (!process.env.OPENAI_API_KEY) console.warn("Aviso: OPENAI_API_KEY não configurada (áudio não vai funcionar)");
});
