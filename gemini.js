const Anthropic = require('@anthropic-ai/sdk');

let client;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

const SYSTEM_PROMPT = `Eres el analizador de intenciones de un gestor de contraseñas personal seguro.
Tu única función es leer el mensaje del usuario y devolver un JSON estructurado.

REGLAS:
- El mensaje puede tener prefijo de chat exportado como "[27/03/2026 7:38] nombre: ..." — ignóralo completamente.
- Si el mensaje contiene credenciales (servicio + contraseña), la acción es "save" aunque no diga "guarda".
- El campo "service" debe ser siempre en minúsculas, sin espacios (ej: "gmail", "ionos", "netflix").
- Extrae la contraseña de forma EXACTA, sin modificarla ni truncarla.
- Si el usuario pide generar una contraseña segura, acción "generate".

ACCIONES:
- "save"     → guardar o actualizar credenciales
- "get"      → consultar una contraseña específica
- "list"     → listar todos los servicios guardados
- "delete"   → borrar credenciales de un servicio
- "generate" → generar una contraseña aleatoria segura
- "unknown"  → no se entiende la intención

FORMATO DE RESPUESTA (SOLO JSON, sin markdown, sin explicaciones):
{"action":"...","service":"..."|null,"username":"..."|null,"password":"..."|null,"notes":"..."|null,"length":16}

EJEMPLOS:
Mensaje: "[08:12] lixar: para ionos user: info@karting.com pass:Abc#2026!"
→ {"action":"save","service":"ionos","username":"info@karting.com","password":"Abc#2026!","notes":null,"length":null}

Mensaje: "cuál es la clave de netflix"
→ {"action":"get","service":"netflix","username":null,"password":null,"notes":null,"length":null}

Mensaje: "qué contraseñas tengo"
→ {"action":"list","service":null,"username":null,"password":null,"notes":null,"length":null}

Mensaje: "borra spotify"
→ {"action":"delete","service":"spotify","username":null,"password":null,"notes":null,"length":null}

Mensaje: "genera una contraseña de 20 caracteres"
→ {"action":"generate","service":null,"username":null,"password":null,"notes":null,"length":20}`;

async function parseIntent(message) {
  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }]
    });

    const text = response.content[0].text.trim().replace(/```json|```/g, '').trim();
    console.log('AI intent:', text);
    return JSON.parse(text);
  } catch (e) {
    console.warn('AI error, usando parser local:', e.message.split('\n')[0]);
    return localParser(message);
  }
}

function localParser(message) {
  const clean = message.replace(/^\[.*?\]\s*[\w\s]+:\s*/, '').trim();
  const lower = clean.toLowerCase();

  if (/genera|crea.*contrase|contrase.*aleatoria/i.test(lower)) {
    const lenMatch = clean.match(/(\d+)\s*(?:caracteres|chars|letras)/i);
    return { action: 'generate', service: null, username: null, password: null, notes: null, length: lenMatch ? parseInt(lenMatch[1]) : 16 };
  }
  if (/qu[eé]\s+(?:contrase[ñn]as|servicios)|lista|listar|todos|tengo guardad/i.test(lower)) {
    return { action: 'list', service: null, username: null, password: null, notes: null, length: null };
  }
  if (/borra|elimina/i.test(lower)) {
    const service = clean.replace(/.*(?:borra|elimina)\s*/i, '').trim().split(/\s+/)[0]?.toLowerCase() || null;
    return { action: 'delete', service, username: null, password: null, notes: null, length: null };
  }
  if (/cu[aá]l|dime|dame/i.test(lower) && !/pass|user/i.test(lower)) {
    const m = clean.match(/(?:de|del)\s+([\w.-]+)/i);
    return { action: 'get', service: m?.[1]?.toLowerCase() || null, username: null, password: null, notes: null, length: null };
  }

  const userMatch = clean.match(/(?:user(?:name)?|usuario|email|correo)\s*:?\s*(\S+@\S+|\S+)/i);
  const passMatch = clean.match(/(?:pass(?:word)?|contrase[ñn]a|clave)\s*:?\s*(\S+)/i);
  const panelMatch = clean.match(/panel\s+de\s+([\w.-]+)/i) || clean.match(/(?:de|a)\s+([\w.-]+)\s+(?:user|pass|contrase)/i);

  if (passMatch) {
    return { action: 'save', service: panelMatch?.[1]?.toLowerCase() || null, username: userMatch?.[1] || null, password: passMatch[1], notes: null, length: null };
  }

  return { action: 'unknown', service: null, username: null, password: null, notes: null, length: null };
}

module.exports = { parseIntent };
