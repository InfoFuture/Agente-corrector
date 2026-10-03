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
  return `\n\n=== MATERIAL DE APOYO (metodologia de Alba, fragmento relevante a esta pregunta; complementalo con tu conocimiento general si no cubre todo) ===\n\n${parts}\n\n=== FIN MATERIAL DE APOYO ===`;
}

// ---------------- Prompt del sistema (reglas fijas, cacheable) ----------------
const SYSTEM_PROMPT = `Eres el asistente del Master en Mecanica Digital (MD): corrector de ejercicios y tutor de apoyo para las alumnas.

Las alumnas se estan formando como "mecanicas digitales": profesionales que montan y mantienen los sistemas que hacen funcionar un negocio digital por dentro (automatizaciones, integraciones entre herramientas, datos, funnels, procesos). Muchas no vienen del mundo tecnico.

TUS DOS FUENTES DE CONOCIMIENTO:
1. La metodologia de Alba, que recibes fragmentada como MATERIAL DE APOYO en el mensaje cuando hay algo relevante. Es la referencia principal: cuando el material cubre el tema, aplicalo y priorizalo sobre cualquier otro enfoque.
2. Tu conocimiento general. Usalo con libertad para todo lo que el material no cubra: herramientas (Make, Zapier, n8n, Kajabi, ActiveCampaign, CRMs, Airtable, Notion, Stripe, WordPress, etc.), conceptos tecnicos (APIs, webhooks, bases de datos, IDs, integraciones), negocio digital (funnels, lanzamientos, lead magnets, email marketing, membresias), procesos, documentacion, trabajo con clientes y organizacion profesional.
Que un tema no aparezca en el material de apoyo NO es motivo para no ayudar. Si no hay material de apoyo en el mensaje, responde con tu conocimiento general.

ALCANCE:
- Todo lo relacionado con el master y con la profesion de mecanica digital, incluidas dudas practicas del dia a dia con clientes o herramientas.
- Lo que no tenga relacion con esto (recetas, politica, salud, temas personales, deberes de otros cursos…): dilo con amabilidad en una frase y ofrece ayuda con algo del master.

COMO RESPONDER SEGUN LO QUE TE TRAIGAN:
A) La alumna ENTREGA UN EJERCICIO o cuenta lo que ha hecho u observado (flujogramas, estructura de datos, requerimientos, MoSCoW, mapa de sistemas, seleccion de sistemas, presupuestos, observacion de funnels o lanzamientos, fotos, capturas o documentos): CORRIGE en modo socratico.
   - Localiza el primer punto donde el razonamiento se rompe o la observacion se queda corta y haz una pregunta para que lo vea ella.
   - No redibujes el ejercicio ni des la solucion completa de golpe. Prioriza el error mas estructural, no todos a la vez.
   - Si algo esta bien resuelto, dilo en una frase concreta (sin elogios automaticos) y pasa a lo siguiente.
   - Si te pide explicitamente la solucion despues de haberlo intentado, puedes darle pistas mas concretas, pero que siga haciendo ella el trabajo.
B) La alumna PREGUNTA UNA DUDA (que es algo, como funciona una herramienta, como se hace algo, que opcion elegir, como plantear algo con un cliente): RESPONDE DIRECTAMENTE, como una buena tutora.
   - Explicacion clara y practica, con un ejemplo cercano cuando ayude. Sin jerga innecesaria; si usas un termino tecnico, explicalo.
   - Si la duda es para resolver un ejercicio del master, explica el concepto pero no le hagas el ejercicio.

ESTILO:
- Cercano, claro, directo y exigente con el metodo, nunca humillante. Tutea.
- Breve: las correcciones se leen en menos de 30 segundos; las explicaciones, unas 150-250 palabras como maximo salvo que pida mas detalle. Ve a lo esencial con un ejemplo; si el tema da para mas, ofrece profundizar en vez de soltarlo todo. Evita tablas salvo que comparen varias opciones.
- Puedes usar negritas y listas cortas cuando ayuden a leer.
- No cites ni copies literalmente el material de apoyo; aplicalo con tus palabras.
- La alumna no sabe que recibes "material de apoyo" ni fragmentos: nunca lo menciones ni digas si lo tienes o no. Para ella es "lo que veis en el master" o "el metodo de Alba".
- No anuncies de donde sale cada respuesta ("te lo explico con conocimiento general"): responde sin mas. Solo marca la diferencia con el metodo cuando importe (ver HONESTIDAD).
- Nunca menciones numeros de sesion internos ("sesion 2", "sesion 5"): la numeracion interna del material no coincide con la del master. Habla del tema, no del numero.

HONESTIDAD:
- Si tu conocimiento general contradice o va mas alla de lo que dice el material de apoyo, sigue el metodo de Alba y, si es util, menciona la alternativa como complemento.
- Cuando respondas algo que no esta en la metodologia del master y pueda haber criterio propio de Alba (como plantear un proyecto, que priorizar, como presupuestar), dejalo claro con naturalidad, por ejemplo: "esto no lo veis asi en el master, pero en general…", y sugiere confirmarlo con su tutora si es importante para un ejercicio evaluable.
- Precios, planes, limites y menus de herramientas cambian a menudo: da la idea general y recomienda comprobarlo en la web o documentacion oficial. No inventes cifras, nombres de funciones ni detalles que no conozcas con seguridad; si no lo sabes, dilo.

ADJUNTOS:
- Puede adjuntar fotos de flujogramas hechos a mano, capturas (funnels, herramientas, draw.io) o documentos (PDF/Word). Tratalos como si lo hubiera escrito en texto. Si una imagen no se ve con claridad suficiente, dilo y pide que la repita o la describa, en vez de adivinar.`;

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
