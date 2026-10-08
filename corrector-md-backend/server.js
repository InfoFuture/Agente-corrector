// Corrector de Mecanicas - backend de produccion
// Usa la API de Anthropic con las credenciales propias de MD (ANTHROPIC_API_KEY),
// no las del alumno. Pensado para desplegarse en cualquier host Node (Render,
// Railway, Fly.io, un VPS con PM2, etc.) y embeberse en Kajabi via iframe
// apuntando a /  (sirve public/index.html).

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 3000;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5'; // ajustar segun docs vigentes / coste deseado
const EFFORT = process.env.ANTHROPIC_EFFORT || 'medium'; // low | medium | high: mas esfuerzo = mas calidad y mas coste
const MAX_OUTPUT_TOKENS = 4000; // incluye el razonamiento del modelo; con 1000 la respuesta podia salir cortada o vacia
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'; // el widget llama a la API desde su propio dominio (iframe), no desde Kajabi
// dominios que pueden embeber el widget en un iframe (separados por espacios)
const FRAME_ANCESTORS = process.env.FRAME_ANCESTORS || 'https://instituto.mecanicadigital.com https://mecanicadigital.com';
const RATE_LIMIT_PER_HOUR = parseInt(process.env.RATE_LIMIT_PER_HOUR || '15', 10); // mensajes por IP y hora
const MAX_HISTORY_TURNS = 8;
const MESSAGES_BUDGET_BYTES = 60000; // tope para historial + fragmentos de clase (las fichas van aparte, en el system cacheado)
const CLASS_SUPPORT_BYTES = 20000; // fragmentos de clase que se anaden a cada pregunta

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------- Base de conocimiento (sesiones de corrector + transcripciones) ----------------
const KB_DOCS = JSON.parse(fs.readFileSync(path.join(__dirname, 'kb_docs.json'), 'utf-8'));
// las fichas de correccion ("sesion") van SIEMPRE enteras en el system; las clases se recuperan por pregunta
const CORRECTION_SHEETS = KB_DOCS.filter(d => d.kind === 'sesion');
const CLASS_DOCS = KB_DOCS.filter(d => d.kind !== 'sesion');

const STOPWORDS = new Set(['de','la','el','en','y','a','que','los','las','un','una','es','se','por','con','para','del','al','lo','como','su','sus','mi','tu','este','esta','estos','estas','pero','si','no','me','le','les','nos','o','u','ha','han','he','muy','mas','sobre','entre','cuando','donde','porque','ya','todo','toda','todos','todas','hay','ser','fue','soy','eres']);

function byteLength(str) { return Buffer.byteLength(str, 'utf-8'); }
function normalize(s) { return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function keywordsOf(text) { return normalize(text).match(/[a-z0-9]{3,}/g) || []; }

function retrieveSupport(query, maxBytes = CLASS_SUPPORT_BYTES) {
  const qWords = keywordsOf(query).filter(w => !STOPWORDS.has(w));
  if (qWords.length === 0) return [];
  const qSet = new Set(qWords);
  const scored = CLASS_DOCS.map(doc => {
    const titleWords = new Set(keywordsOf(doc.title));
    const bodyNorm = normalize(doc.content);
    let score = 0;
    qSet.forEach(w => {
      if (titleWords.has(w)) score += 3;
      const re = new RegExp('\\b' + w + '\\b', 'g');
      const m = bodyNorm.match(re);
      if (m) score += Math.min(m.length, 4);
    });
    return { doc, score };
  }).filter(x => x.score >= 5).sort((a, b) => b.score - a.score);

  const picked = [];
  let used = 0;
  for (const item of scored) {
    const full = item.doc.content;
    const fullBytes = byteLength(full);
    const budget = maxBytes - used;
    if (budget <= 1500) break;
    let content = full;
    if (fullBytes > budget) {
      const words = full.split(/\s+/);
      let acc = '';
      for (const w of words) {
        const candidate = acc ? acc + ' ' + w : w;
        if (byteLength(candidate) > budget - 20) break;
        acc = candidate;
      }
      content = acc + ' [...]';
    }
    picked.push({ title: item.doc.title, content });
    used += byteLength(content);
    if (picked.length >= 2) break;
  }
  return picked;
}

function buildSupportBlock(query, maxBytes) {
  const support = retrieveSupport(query, maxBytes);
  if (support.length === 0) return '';
  const parts = support.map(s => `--- ${s.title} ---\n${s.content}`).join('\n\n');
  return `\n\n=== FRAGMENTOS DE CLASE DE ALBA (transcripciones relacionadas con esta pregunta; uso interno, no los menciones) ===\n\n${parts}\n\n=== FIN FRAGMENTOS DE CLASE ===`;
}

// ---------------- Prompt del sistema (reglas fijas, cacheable) ----------------
const SYSTEM_PROMPT = `Eres el corrector del Master en Mecanica Digital (MD) y tutor de apoyo para las alumnas. Corriges exactamente como lo haria Alba, la autora del metodo.

Las alumnas se forman como "mecanicas digitales": profesionales que analizan el negocio de un cliente y montan y mantienen los sistemas que lo hacen funcionar por dentro. Muchas no vienen del mundo tecnico.

TUS FUENTES, EN ESTE ORDEN:
1. LAS FICHAS DE CORRECCION DE ALBA (al final de estas instrucciones, siempre presentes). Son tu base: reglas del metodo, preguntas del corrector, errores que debes detectar y la SECUENCIA DE CORRECCION de cada tipo de ejercicio (primera conversacion con cliente, requerimientos, MoSCoW, datos, flujogramas, busqueda de sistemas, mentalidad y profesion).
2. FRAGMENTOS DE CLASE: a veces se anaden al mensaje de la alumna trozos de las clases de Alba relacionados con su pregunta. Usalos para hablar con el vocabulario y los ejemplos de las clases.
3. Tu conocimiento general: SOLO para dudas sobre herramientas, conceptos tecnicos o negocio digital que las fichas y las clases no cubren. NUNCA para corregir un ejercicio.

ALCANCE: todo lo del master y la profesion de mecanica digital. Lo ajeno (recetas, politica, salud, temas personales…) lo rechazas en una frase amable y ofreces ayuda con algo del master.

MODO A — LA ALUMNA ENTREGA UN EJERCICIO O CUENTA LO QUE HA HECHO U OBSERVADO: CORRIGE CON EL METODO DE ALBA.
- Identifica el tipo de ejercicio y recorre en orden la SECUENCIA DE CORRECCION de su ficha. El primer punto de la secuencia que no se cumple es lo que corriges en esta respuesta; lo demas espera.
- Corrige con las reglas, las preguntas y las palabras de las fichas. Cuando la ficha tiene una pregunta o frase para ese caso, usala tal cual o casi tal cual. Ejemplos: "Eso es el titular. Ahora dime que tendra que ocurrir para poder afirmar que ese titular esta cumplido." / "¿Como vas a saber que esta bien hecho?" / "¿Para que necesita exactamente esto?" / "¿Podrian estas dos cosas funcionar o fallar independientemente?" / "¿Que pasa si esto no esta?".
- PROHIBIDO introducir conceptos, clasificaciones o terminos que no esten en las fichas ni en las clases, aunque sean correctos en general: por ejemplo "requerimiento no funcional", "restriccion de calendario", "condicion del proyecto", "criterios SMART", "historias de usuario", "criterios de aceptacion", "KPI", "bajar de abstraccion". Si el metodo no dice nada de algo que ves, no lo corrijas.
- No empieces valorando ("Antes de nada, esto tiene algo bien…", "¡Buen trabajo!"). Ve directa al punto de ruptura. Solo menciona algo bien hecho si es necesario para entender la correccion, en una frase.
- Una correccion por respuesta: el punto de ruptura, por que incumple el metodo (en una o dos frases) y una pregunta para que lo vea ella. Como mucho una segunda pregunta. Nada de listas de preguntas ni de pistas encadenadas.
- No redibujes ni reescribas el ejercicio por ella, ni des la version correcta. Si despues de intentarlo pide la solucion, dale una pista mas concreta, pero que lo reescriba ella.
- Distingue, como piden las fichas, "esto incumple el metodo" de "yo lo haria de otra manera"; no presentes recomendaciones o preferencias como reglas.

MODO B — LA ALUMNA PREGUNTA UNA DUDA: RESPONDE DIRECTAMENTE, COMO UNA BUENA TUTORA.
- Si la duda es sobre el propio metodo (que es un requerimiento, un trigger, un dato ECU, una M en MoSCoW, como se hace la primera conversacion…), responde con las definiciones, reglas y ejemplos de las fichas y las clases, con sus palabras. No anadas marcos de otras metodologias.
- Si es sobre herramientas o conceptos tecnicos que el metodo no cubre (Make, Zapier, Kajabi, ActiveCampaign, APIs, webhooks…), usa tu conocimiento general. Respeta igualmente el metodo: requerimientos antes que herramientas, nada de "modo solucion".
- Si la duda es para resolver un ejercicio del master, explica el concepto pero no le hagas el ejercicio.
- Clara y practica, con un ejemplo cercano cuando ayude; si usas un termino tecnico, explicalo.

ESTILO (el de las fichas): directo, concreto, practico, centrado en el razonamiento, permisivo con el error y exigente con el metodo. Nunca humillante. Tutea.
- Longitud: correcciones de 60 a 150 palabras; explicaciones de 150 a 250 palabras como maximo, salvo que pida mas detalle. Respeta el limite: si no cabe, quedate con lo esencial y ofrece ampliar.
- Puedes usar negritas y listas cortas en las explicaciones; en las correcciones, mejor texto corrido.
- Nunca menciones "fichas", "material", "fragmentos" ni "transcripciones", ni la jerga interna de las instrucciones ("punto de ruptura", "secuencia de correccion", "regla del corrector", "modo A/B"): para la alumna es "el metodo" o "lo que veis en el master". No copies bloques de texto; las preguntas del corrector si puedes usarlas literalmente.
- Nunca menciones numeros de sesion ("sesion 2", "sesion 4"): la numeracion interna no coincide con la del master. Habla del tema.
- No anuncies de donde sale cada respuesta.

HONESTIDAD:
- Si tu conocimiento general contradice el metodo, sigue el metodo.
- Precios, planes y menus de herramientas cambian: da la idea general y remite a la web oficial. No inventes cifras ni funciones.
- La informacion que las fichas marcan como coyuntural o antigua (precios de proyectos, ratios, plataformas de moda, logistica de ediciones antiguas…) no la uses como dato actual.

ADJUNTOS: fotos de flujogramas hechos a mano, capturas o documentos se tratan como si los hubiera escrito. Si una imagen no se ve bien, dilo y pide que la repita o la describa, en vez de adivinar.`;

// instrucciones + fichas completas: es el bloque fijo que se cachea (1 h)
const SYSTEM_TEXT = SYSTEM_PROMPT + '\n\n==================== FICHAS DE CORRECCION DE ALBA ====================\n\n'
  + CORRECTION_SHEETS.map(d => `##### FICHA: ${d.title}\n\n${d.content}`).join('\n\n')
  + '\n\n==================== FIN DE LAS FICHAS ====================';

// ---------------- Servidor ----------------
const app = express();
app.set('trust proxy', 1); // detras del proxy de Railway: necesario para que el limite vaya por IP real
app.use(cors({ origin: ALLOWED_ORIGIN }));
// impide que el widget se embeba en webs ajenas a MD
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${FRAME_ANCESTORS}`);
  next();
});
app.use(express.json({ limit: '15mb' })); // deja margen para imagenes en base64
app.use(express.static(path.join(__dirname, 'public')));

// body esperado:
// {
//   history: [{role:"user"|"assistant", content:"..."}],  // SIN incluir el system prompt
//   images: [{ data: "<base64 sin prefijo>", media_type: "image/png" }]  // opcional, solo en el ultimo turno
// }
const correctLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: RATE_LIMIT_PER_HOUR,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Has enviado muchos mensajes en poco tiempo. Espera un rato y vuelve a intentarlo.' },
});

app.post('/api/correct', correctLimiter, async (req, res) => {
  try {
    let { history, images } = req.body || {};
    if (!Array.isArray(history) || history.length === 0) {
      return res.status(400).json({ error: 'invalid_request', message: 'history vacio' });
    }
    history = history.slice(-MAX_HISTORY_TURNS);
    const lastUserMsg = [...history].reverse().find(h => h.role === 'user');
    const queryText = lastUserMsg ? lastUserMsg.content : '';

    let supportBlock = buildSupportBlock(queryText);

    // construir los turnos para la API: el material de apoyo se inyecta en el ULTIMO turno de usuario
    function buildMessages(hist, support) {
      return hist.map((h, i) => {
        const isLastUser = h.role === 'user' && i === hist.length - 1;
        let content = h.content;
        if (isLastUser && support) content = content + support;
        if (isLastUser && images && images.length) {
          const blocks = images.slice(0, 4).map(img => ({
            type: 'image',
            source: { type: 'base64', media_type: img.media_type || 'image/png', data: img.data },
          }));
          blocks.push({ type: 'text', text: content });
          return { role: 'user', content: blocks };
        }
        return { role: h.role, content };
      });
    }

    let messages = buildMessages(history, supportBlock);

    // salvaguarda de presupuesto total: si nos pasamos, recortamos historial y luego el material de apoyo
    let approxBytes = byteLength(JSON.stringify(messages));
    let guard = 0;
    while (approxBytes > MESSAGES_BUDGET_BYTES && guard < 6) {
      if (history.length > 2) history = history.slice(2);
      else if (supportBlock) supportBlock = buildSupportBlock(queryText, 8000);
      else break;
      messages = buildMessages(history, supportBlock);
      approxBytes = byteLength(JSON.stringify(messages));
      guard++;
    }

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      output_config: { effort: EFFORT },
      system: [{ type: 'text', text: SYSTEM_TEXT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages,
    });

    const u = response.usage || {};
    console.log('uso', JSON.stringify({ in: u.input_tokens, cache_read: u.cache_read_input_tokens, cache_write: u.cache_creation_input_tokens, out: u.output_tokens, stop: response.stop_reason }));
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (!text) {
      console.error('Respuesta sin texto', { stop_reason: response.stop_reason, stop_details: response.stop_details });
      return res.status(502).json({ error: 'empty_response', message: 'El corrector no ha podido responder a este mensaje. Reformulalo o comentalo con tu tutora en el foro.' });
    }
    res.json({ text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

app.listen(PORT, () => console.log(`Corrector backend escuchando en puerto ${PORT}`));
