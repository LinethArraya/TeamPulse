// Lee los últimos mensajes de un canal de Discord, detecta los "Daily Status"
// con el formato Yesterday / Today y líneas "* CODE | tarea", y escribe data.json.
//
// Uso (en CI): DISCORD_BOT_TOKEN=... DISCORD_CHANNEL_ID=... node scripts/sync-discord.mjs
//
// El parser se exporta para poder testearlo sin llamar a Discord.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const API = 'https://discord.com/api/v10';

// --- Parser -----------------------------------------------------------------

// Extrae de un bloque de texto las líneas "* CODE | tarea".
// Devuelve un objeto { CODE: [tarea, tarea, ...] }.
function extractTasks(block) {
  const byCode = {};
  if (!block) return byCode;
  const re = /(?:^|\n)\s*[*\-•]\s*([A-Za-z0-9]{1,8})\s*\|\s*(.+?)\s*(?=\n|$)/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    const code = m[1].toUpperCase();
    const task = m[2].trim();
    if (!task) continue;
    (byCode[code] ||= []).push(task);
  }
  return byCode;
}

// Parsea el contenido de un mensaje. Si no parece un daily, devuelve null.
export function parseDaily(content) {
  if (!content) return null;

  const yMatch = content.match(/Yesterday\s*(?:\(([^)]*)\))?\s*:/i);
  const tMatch = content.match(/\bToday\s*:/i);

  // Necesitamos al menos una de las dos secciones para considerarlo un daily.
  if (!yMatch && !tMatch) return null;

  let yesterdayBlock = '';
  let todayBlock = '';
  const yesterdayLabel = yMatch && yMatch[1] ? yMatch[1].trim() : '';

  if (yMatch && tMatch) {
    const yStart = yMatch.index + yMatch[0].length;
    yesterdayBlock = content.slice(yStart, tMatch.index);
    todayBlock = content.slice(tMatch.index + tMatch[0].length);
  } else if (tMatch) {
    todayBlock = content.slice(tMatch.index + tMatch[0].length);
  } else if (yMatch) {
    yesterdayBlock = content.slice(yMatch.index + yMatch[0].length);
  }

  const yByCode = extractTasks(yesterdayBlock);
  const tByCode = extractTasks(todayBlock);

  const codes = new Set([...Object.keys(yByCode), ...Object.keys(tByCode)]);
  if (codes.size === 0) return null;

  const people = {};
  for (const code of codes) {
    people[code] = {
      yesterday: yByCode[code] || [],
      today: tByCode[code] || [],
    };
  }

  return { yesterdayLabel, people };
}

// --- Discord ----------------------------------------------------------------

async function fetchMessages(channelId, token, limit = 50) {
  const res = await fetch(`${API}/channels/${channelId}/messages?limit=${limit}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord API ${res.status}: ${body}`);
  }
  return res.json();
}

function loadTeam() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'team.json'), 'utf8'));
  } catch {
    return {};
  }
}

// --- Main -------------------------------------------------------------------

async function main() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  if (!token || !channelId) {
    console.error('Faltan DISCORD_BOT_TOKEN o DISCORD_CHANNEL_ID en el entorno.');
    process.exit(1);
  }

  const team = loadTeam();
  const messages = await fetchMessages(channelId, token);
  // Discord devuelve los mensajes del más nuevo al más viejo; así el primer
  // daily que encontremos para cada código es el más reciente.
  const seen = new Map();

  for (const msg of messages) {
    const parsed = parseDaily(msg.content);
    if (!parsed) continue;
    for (const [code, tasks] of Object.entries(parsed.people)) {
      if (seen.has(code)) continue;
      const info = team[code] || {};
      seen.set(code, {
        code,
        name: info.name || code,
        project: info.project || '',
        yesterdayLabel: parsed.yesterdayLabel,
        yesterday: tasks.yesterday,
        today: tasks.today,
        postedAt: msg.timestamp,
        author: msg.author?.username || '',
      });
    }
  }

  // Orden estable: por el orden en que aparecen en team.json y luego el resto.
  const teamOrder = Object.keys(team);
  const people = [...seen.values()].sort((a, b) => {
    const ia = teamOrder.indexOf(a.code);
    const ib = teamOrder.indexOf(b.code);
    if (ia === -1 && ib === -1) return a.code.localeCompare(b.code);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  const data = { updatedAt: new Date().toISOString(), people };
  writeFileSync(join(ROOT, 'data.json'), JSON.stringify(data, null, 2) + '\n');
  console.log(`data.json actualizado: ${people.length} recurso(s).`);
}

// Ejecutar main solo si se corre directamente (no al importar para tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
