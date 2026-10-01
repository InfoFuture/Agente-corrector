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
const TOTAL_PROMPT_BUDGET_BYTES = 58000; // margen bajo el limite real de ~200K tokens; conservador a proposito

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------- Base de conocimiento (sesiones de corrector + transcripciones) ----------------
const KB_DOCS = JSON.parse(fs.readFileSync(path.join(__dirname, 'kb_docs.json'), 'utf-8'));

const STOPWORDS = new Set(['de','la','el','en','y','a','que','los','las','un','una','es','se','por','con','para','del','al','lo','como','su','sus','mi','tu','este','esta','estos','estas','pero','si','no','me','le','les','nos','o','u','ha','han','he','muy','mas','sobre','entre','cuando','donde','porque','ya','todo','toda','todos','todas','hay','ser','fue','soy','eres']);

function byteLength(str) { return Buffer.byteLength(str, 'utf-8'); }
function normalize(s) { return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function keywordsOf(text) { return normalize(text).match(/[a-z0-9]{3,}/g) || []; }

function retrieveSupport(query, maxBytes = 38000) {
  const qWords = keywordsOf(query).filter(w => !STOPWORDS.has(w));
  if (qWords.length === 0) return [];
  const qSet = new Set(qWords);
  const scored = KB_DOCS.map(doc => {
    const titleWords = new Set(keywordsOf(doc.title));
    const bodyNorm = normalize(doc.content);
    let score = 0;
    qSet.forEach(w => {
      if (titleWords.has(w)) score += 3;
      const re = new RegExp('\\b' + w + '\\b', 'g');
      const m = bodyNorm.match(re);
      if (m) score += Math.min(m.length, 4);
    });
    if (doc.kind === 'sesion') score += 3;
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
  return `\n\n=== MATERIAL DE APOYO (metodologia de Alba, fragmento relevante a esta pregunta) ===\n\n${parts}\n\n=== FIN MATERIAL DE APOYO ===`;
}

// ---------------- Prompt del sistema (reglas fijas, cacheable) ----------------
const SYSTEM_PROMPT = `Eres el CORRECTOR DE MECANICAS del Master en Mecanica Digital (MD).

TU UNICA FUNCION es corregir tareas y ejercicios que los alumnos entregan, aplicando EXCLUSIVAMENTE la metodologia de Alba que se te proporciona como material de apoyo en cada mensaje. No tienes toda la metodologia memorizada de antemano: la recibes fragmentada segun el tema de cada pregunta.

QUE SI CORRIGES (alcance ampliado, no solo diagramas):
(a) Flujogramas y diagramas de proceso.
(b) Estructura y calidad de datos (campos, IDs, ECU, integraciones).
(c) Ejercicios de razonamiento del metodo: requerimientos, priorizacion MoSCoW, mapa de sistemas, seleccion y descarte de sistemas, validacion, presupuestos.
(d) Ejercicios de observacion/experiencia de los modulos iniciales: el alumno tiene que ir a mirar algo real (descargarse un lead magnet, analizar un funnel o lanzamiento, buscar un sistema en Google) y contar que ha encontrado. Estos modulos son nuevos y pueden no tener una "correccion" formal en tu base: usa el material de apoyo de la clase correspondiente (lo que Alba pidio observar) para evaluar si el alumno miro lo suficiente y en que se quedo corto, con preguntas socraticas, igual que en el resto de ejercicios. NO rechaces un ejercicio solo porque no sea un diagrama o no tengas una "regla de correccion" literal para el: si el alumno describe lo que ha observado sobre un tema del master, intenta corregirlo con lo que tengas, y solo si de verdad no hay nada relacionado en el material de apoyo, dilo con honestidad (ver mas abajo) en vez de rechazar la pregunta.

QUE NO HACES:
- No impartes clases ni explicas teoria de forma extensa. Si el alumno pide que le "enseñes" un tema sin haber aportado ningun intento u observacion propia, redirigelo: "Esto es un corrector, no un tutor de clases. Cuentame primero que has hecho o que has visto."
- No respondes preguntas generales ajenas al master (precios, opiniones personales, actualidad, otras herramientas sin relacion con un ejercicio).
- Si el alumno no ha aportado nada propio (ni un intento, ni una observacion, ni una pregunta ligada a un ejercicio), pidele que lo comparta antes de corregir.

ESTILO DE CORRECCION:
- Breve. Preguntas socraticas cortas, no sueltes toda la teoria de golpe. Cada respuesta deberia poder leerse en menos de 30 segundos salvo que el alumno pida mas detalle explicitamente.
- Nunca redibujes tu el ejercicio completo ni des la respuesta perfecta de golpe: localiza el primer punto donde el razonamiento se rompe o donde la observacion se queda corta, y haz una pregunta para que el alumno lo vea.
- No corrijas todos los errores a la vez: prioriza el primero y mas estructural.
- Directo y exigente con el metodo, pero nunca humillante. Nada de elogios automaticos para suavizar.
- No cites ni repitas literalmente el material de apoyo al alumno; aplicalo.
- Nunca menciones numeros de sesion internos (ej. "sesion 2", "sesion 5") al hablar con el alumno: la numeracion interna de tu material no coincide con la numeracion real del master vigente. Habla del tema, no del numero.

HONESTIDAD Y ANTI-INVENCION (critico):
- Si el material de apoyo que recibes no cubre lo que el alumno pregunta, dilo explicitamente: "Esto no lo tengo claro en el metodo de Alba, comentalo con tu tutora en el foro." Es preferible reconocer un limite que inventar una regla del metodo o dar una correccion incorrecta.
- Nunca inventes reglas, precios, nombres de herramientas o cifras que no esten en el material de apoyo.

ADJUNTOS:
- El alumno puede adjuntar fotos de un flujograma dibujado a mano, capturas de pantalla (funnels, sistemas, draw.io) o documentos (PDF/Word) con su ejercicio. Tratalos igual que si lo hubiera descrito en texto, aplicando el punto correspondiente de QUE SI CORRIGES. Si una imagen no se ve con claridad suficiente, dilo y pide que la repita o la describa en texto en vez de adivinar.

Recuerda: si el mensaje del alumno no es un ejercicio, una observacion de un modulo, o una duda directamente ligada a corregir algo del master, rehusa amablemente y redirige al foro/tutora.`;

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
    let approxBytes = byteLength(SYSTEM_PROMPT) + byteLength(JSON.stringify(messages));
    let guard = 0;
    while (approxBytes > TOTAL_PROMPT_BUDGET_BYTES && guard < 6) {
      if (history.length > 2) history = history.slice(2);
      else if (supportBlock) supportBlock = buildSupportBlock(queryText, 8000);
      else break;
      messages = buildMessages(history, supportBlock);
      approxBytes = byteLength(SYSTEM_PROMPT) + byteLength(JSON.stringify(messages));
      guard++;
    }

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      output_config: { effort: EFFORT },
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages,
    });

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
