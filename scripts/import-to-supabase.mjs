import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SOURCES = ["data/preguntas-bateria-comun.json", "data/preguntas-celador.json"];
const CHUNK_SIZE = 200;

function repairMojibake(value) {
  const text = String(value ?? "");
  if (!/[ÃƒÃ¢â‚¬]/.test(text)) {
    return text;
  }

  try {
    const bytes = Uint8Array.from(Array.from(text, (char) => char.charCodeAt(0)));
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return decoded.includes("ï¿½") ? text : decoded;
  } catch {
    return text;
  }
}

function cleanText(value) {
  let text = repairMojibake(value);
  text = text.replace(
    /(?:En cumpimiento|En cumplimiento|Totono:|Telono:).+?Ramon Montenegro 32,\s*27002\s*\(LUGO\)/gi,
    " ",
  );
  text = text.replace(
    /Puede ejercer sus derechos de acceso.+?Ramon Montenegro 32,\s*27002\s*\(LUGO\)/gi,
    " ",
  );
  text = text.replace(/\(\s*(?:Correct|Correcta|Incorrecta|Jncorrecta)\s*\)/gi, " ");
  text = text.replace(/\(\s*(?:Cor|Incor)-\s*recta\s*\)/gi, " ");
  text = text.replace(/\s*~\s*/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

function normalizeOptions(options) {
  const letters = ["a", "b", "c", "d"];

  return letters.map((letter, index) => {
    const current = Array.isArray(options) ? options[index] || {} : {};
    return {
      letra: letter,
      texto: cleanText(current.texto || ""),
      estado: current.estado === "Correcta" ? "Correcta" : "Incorrecta",
    };
  });
}

async function readSource(name) {
  const filepath = path.join(rootDir, name);
  const raw = await readFile(filepath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} no contiene un array de preguntas.`);
  }

  return parsed.map((item) => ({
    documento: item.documento,
    question_number: Number(item.id),
    pregunta: cleanText(item.pregunta),
    opciones: normalizeOptions(item.opciones),
    review_status: "published",
    is_active: true,
    editor_note: "",
  }));
}

async function importChunk(chunk) {
  const endpoint = new URL("/rest/v1/questions", SUPABASE_URL);
  endpoint.searchParams.set("on_conflict", "documento,question_number");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(chunk),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase ha rechazado un bloque (${response.status}): ${text}`);
  }
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Define SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY antes de lanzar el importador.");
  }

  const payloads = (await Promise.all(SOURCES.map(readSource))).flat();
  for (let index = 0; index < payloads.length; index += CHUNK_SIZE) {
    const chunk = payloads.slice(index, index + CHUNK_SIZE);
    await importChunk(chunk);
    console.log(`Importadas ${Math.min(index + CHUNK_SIZE, payloads.length)} / ${payloads.length}`);
  }

  console.log("Importación completada.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
