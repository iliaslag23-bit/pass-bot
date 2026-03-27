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
- El campo "service" debe ser siempre en minúsculas, puede tener espacios (ej: "gmail", "schneider electric", "ionos").
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
{"action":"...","service":"..."|null,"username":"..."|null,"password":"..."|null,"notes":"..."|null,"length":null}

EJEMPLOS:
Mensaje: "[08:12] lixar: para ionos user: info@karting.com pass:Abc#2026!"
→ {"action":"save","service":"ionos","username":"info@karting.com","password":"Abc#2026!","notes":null,"length":null}

Mensaje: "guarda schneider electric user:iliaslag23@gmail.com pass:BJ8YUnkmw2U8Cd#"
→ {"action":"save","service":"schneider electric","username":"iliaslag23@gmail.com","password":"BJ8YUnkmw2U8Cd#","notes":null,"length":null}

Mensaje: "borra la contraseña de ionos"
→ {"action":"delete","service":"ionos","username":null,"password":null,"notes":null,"length":null}

Mensaje: "cuál es la clave de netflix"
→ {"action":"get","service":"netflix","username":null,"password":null,"notes":null,"length":null}

Mensaje: "qué contraseñas tengo"
→ {"action":"list","service":null,"username":null,"password":null,"notes":null,"length":null}

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
  const clean = message.replace(/^\[[\d/: ]+\]\s*[\w\s]+:\s*/, '').trim();
  const lower = clean.toLowerCase();
  const EMPTY = { service: null, username: null, password: null, notes: null, length: null };

  // Generar
  if (/genera|contrase[ñn]a aleatoria/i.test(lower) && !/user\s*:|pass\s*:/i.test(lower)) {
    const len = (clean.match(/(\d+)\s*(?:caracteres|chars)/i) || [])[1];
    return { action: 'generate', ...EMPTY, length: len ? parseInt(len) : 16 };
  }

  // Listar
  if (/qu[eé]\s+(?:contrase[ñn]as|servicios|tengo)|lista|listar|todos.*servic|tengo guardad/i.test(lower)) {
    return { action: 'list', ...EMPTY };
  }

  // Borrar — quitar palabras vacías y extraer el nombre real del servicio
  if (/borra|elimina/i.test(lower)) {
    const afterVerb = clean.replace(/^.*?(?:borra|elimina)\s+/i, '').trim();
    const service = afterVerb
      .replace(/^(?:la|el|las|los)\s+/i, '')
      .replace(/^(?:contrase[ñn]a|clave)\s+(?:de\s+)?/i, '')
      .replace(/^(?:de|del)\s+/i, '')
      .trim().toLowerCase() || null;
    return { action: 'delete', ...EMPTY, service };
  }

  // Consultar — "dime la de X", "cuál es X", "contraseña de X", solo el nombre del servicio
  if (/cu[aá]l|d[ií]me|dame|consulta|clave\s+de|contrase[ñn]a\s+de|pass\s+de/i.test(lower) && !/user\s*:|pass\s*:/i.test(lower)) {
    const m = clean.match(/\bde\s+([\w\s.-]+?)(?:\s*[?.,]?\s*$)/i)
           || clean.match(/\bla\s+([\w\s.-]+?)(?:\s*[?.,]?\s*$)/i);
    return { action: 'get', ...EMPTY, service: m?.[1]?.trim().toLowerCase() || null };
  }

  // Si el mensaje es solo un nombre de servicio sin credenciales ni verbos → consultar
  if (/^[\w\s.-]{2,40}$/.test(clean) && !/^(?:hola|ok|gracias|si|no)\s*$/i.test(lower)) {
    return { action: 'get', ...EMPTY, service: lower.trim() };
  }

  // Guardar — detectar credenciales
  const userMatch = clean.match(/(?:user(?:name)?|usuario|email|correo)\s*:\s*(\S+)/i);
  const passMatch = clean.match(/(?:pass(?:word)?|contrase[ñn]a|clave)\s*:\s*(\S+)/i)
                 || clean.match(/(?:^|\s)\/(\S{4,})/);

  if (passMatch || userMatch) {
    const credPos = clean.search(/(?:user(?:name)?|usuario|email|correo|pass(?:word)?|contrase[ñn]a|clave)\s*:/i);
    const slashPos = clean.search(/(?:\s)\/\S{4,}/);
    const cutAt = credPos > 0 ? credPos : slashPos > 0 ? slashPos : clean.length;

    const service = clean.substring(0, cutAt)
      .replace(/^(?:guarda|crea|crear|añade|agrega|nueva?|ccrea|salva)\s+/i, '')
      .replace(/^(?:la\s+)?(?:contrase[ñn]a|clave|credenciales?)\s+(?:de|para)\s+/i, '')
      .replace(/^(?:para|de|del)\s+/i, '')
      .replace(/[/:,]+$/, '')
      .trim().toLowerCase() || null;

    return { action: 'save', service, username: userMatch?.[1] || null, password: passMatch?.[1] || null, notes: null, length: null };
  }

  return { action: 'unknown', ...EMPTY };
}

module.exports = { parseIntent };
