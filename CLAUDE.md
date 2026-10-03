# Corrector de Mecánicas — Máster en Mecánica Digital (MD)

Contexto para continuar el proyecto con Claude Code. Responde siempre en español.

## Qué es

Chat web para las alumnas del **Máster en Mecánica Digital** (MD, una de las LLCs de Future Starts Lab; plataforma del máster: Kajabi). Hace dos cosas:

- **Corrige ejercicios** (flujogramas, estructura de datos, requerimientos, MoSCoW, mapa de sistemas, presupuestos, observación de funnels…) en modo **socrático**: localiza el primer fallo y pregunta, no da la solución.
- **Resuelve dudas** del máster y de la profesión (Make, Zapier, Kajabi, ActiveCampaign, APIs, webhooks, funnels, clientes…) de forma **directa**, como una tutora.

Prioriza la metodología de Alba (transcripciones en `kb_docs.json`) y, cuando no cubre el tema, usa el conocimiento general de Claude. Lo ajeno al máster (recetas, política…) lo redirige con amabilidad.

Se embebe en Kajabi mediante un iframe. Llama a la API de Anthropic con la clave de MD, no con la de la alumna.

## Producción

| | |
|---|---|
| URL pública | https://corrector-mecanicas-production.up.railway.app |
| Hosting | Railway → workspace **"aerys-k's Projects"** → proyecto **corrector-mecanicas** → servicio **corrector-mecanicas** → entorno **production** |
| Project ID | `09e25394-c571-40ee-a57d-9daf23f467d3` |
| Rama de trabajo | `claude/deploy-node-railway-pth0cu` (aún no fusionada en `main`) |
| Modelo | `claude-sonnet-5-5`, esfuerzo `medium` |

No se crea un workspace propio de MD en Railway para no pagar extra; el proyecto se queda en el workspace actual.

Railway **no** está conectado a GitHub: los despliegues se hacen a mano con `railway up` desde `corrector-md-backend/`. Hacer push a GitHub **no despliega**.

## Estructura

```
corrector-md-backend/
  server.js          # Express: prompt del sistema, recuperación de conocimiento, POST /api/correct, seguridad
  kb_docs.json       # 33 fuentes de Alba: 5 "sesion" (fichas de corrección) + 28 "clase" (transcripciones)
  public/index.html  # widget de chat (HTML + CSS + JS en un único archivo, sin build)
  package.json       # express, cors, express-rate-limit, @anthropic-ai/sdk 0.27
  README.md          # instrucciones originales de despliegue, Kajabi y actualización de la base de conocimiento
corrector-md-backend.zip  # entrega original del proyecto (referencia, no se usa)
```

### Cómo funciona `server.js`

1. Recibe `{ history: [{role, content}], images?: [{data, media_type}] }`. Usa solo los últimos 8 turnos.
2. `retrieveSupport()` puntúa los documentos de `kb_docs.json` por palabras clave (las `"sesion"` pesan más) y añade **como máximo 2 documentos** (unos 38 KB) al **último** mensaje de la alumna, como bloque `MATERIAL DE APOYO`.
3. `SYSTEM_PROMPT` va en el bloque `system` con `cache_control: ephemeral`.
4. Llama a `anthropic.messages.create` con `max_tokens: 4000` y `output_config: { effort }`. Si la respuesta llega sin texto, devuelve un 502 con un mensaje para la alumna.
5. Seguridad:
   - cabecera `Content-Security-Policy: frame-ancestors` (solo los dominios de MD pueden embeber el iframe);
   - límite de mensajes por IP con `express-rate-limit` (`trust proxy` activado por el proxy de Railway);
   - CORS con `ALLOWED_ORIGIN`.

El widget llama a `/api/correct` desde su propio origen (el dominio de Railway dentro del iframe), **no** desde Kajabi. Por eso `ALLOWED_ORIGIN` es el dominio de Railway y la protección real contra webs ajenas es `frame-ancestors`.

## Variables de entorno (en Railway)

| Variable | Valor actual | Notas |
|---|---|---|
| `ANTHROPIC_API_KEY` | clave `sk-ant-api03…` del workspace de MD en console.anthropic.com | **Nunca** al repositorio. Tiene que ser una clave de workspace: las `sk-ant-usr-…` devuelven un 400 |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | |
| `ALLOWED_ORIGIN` | `https://corrector-mecanicas-production.up.railway.app` | |
| `ANTHROPIC_EFFORT` | (sin definir → `medium`) | `low` / `medium` / `high` |
| `RATE_LIMIT_PER_HOUR` | (sin definir → `15`) | mensajes por IP y hora |
| `FRAME_ANCESTORS` | (sin definir → `https://instituto.mecanicadigital.com https://mecanicadigital.com`) | separados por espacios; añade aquí el dominio de vista previa de Kajabi si hace falta |

Cambiar una variable dispara un redespliegue automático.

## Tareas habituales

### Desplegar

```bash
npm install -g @railway/cli        # si no está instalada
railway login --browserless        # da un enlace y un código para confirmar en el navegador
cd corrector-md-backend
railway link -p 09e25394-c571-40ee-a57d-9daf23f467d3 -e production
railway service link corrector-mecanicas
railway up --service corrector-mecanicas --ci
railway logs --service corrector-mecanicas            # logs del servidor
railway logs --service corrector-mecanicas --build    # logs de la compilación
railway variable set --service corrector-mecanicas CLAVE=valor
```

### Cambiar el comportamiento del corrector

Edita `SYSTEM_PROMPT` en `server.js`. Reglas que conviene mantener:
- No mencionar "material de apoyo" ni números de sesión internos a la alumna (la numeración interna no coincide con la del máster).
- Corrección socrática para los ejercicios y respuesta directa para las dudas.
- No inventar precios ni límites de herramientas; mandar a la web oficial.
- Longitud: correcciones de menos de 30 segundos de lectura; explicaciones de unas 150-250 palabras.

### Añadir material de Alba

Añade entradas a `kb_docs.json` con la forma `{ "title": "...", "content": "...", "kind": "sesion" | "clase" }`. Los `.docx` se convierten con `pandoc archivo.docx -t plain`. Después, vuelve a desplegar. No hace falta tocar el código.

### Cambiar el diseño

`public/index.html`. Identidad sacada de mecanicadigital.com:
- naranja `#E3632C`, crema `#FBF4EC`, melocotón `#FBE3D4`, texto `#211C18`;
- Inter (600) para los textos y JetBrains Mono para el logo y las etiquetas en mayúsculas;
- esquinas de 10, 15, 22 y 32 px (píldora).

La tarjeta de bienvenida con atajos (`#hero` / `#suggest`) desaparece al enviar el primer mensaje. Las respuestas usan un mini-markdown propio y seguro (`renderMd`, que escapa el HTML antes de interpretar el formato).

## Probar en local

```bash
cd corrector-md-backend && npm install
# Con la API real, usando las variables de Railway (sin escribir la clave en ningún archivo):
railway run --service corrector-mecanicas -- env PORT=3999 node server.js
curl -s -X POST localhost:3999/api/correct -H 'Content-Type: application/json' \
  -d '{"history":[{"role":"user","content":"¿Qué diferencia hay entre un webhook y una API?"}]}'
```

Para probar sin gastar créditos, levanta un servidor HTTP que imite `/v1/messages` y arranca con `ANTHROPIC_BASE_URL=http://127.0.0.1:<puerto>`.

Casos de prueba útiles después de cambiar el prompt:
- una duda que no esté en las transcripciones (webhook vs. API);
- un ejercicio con fallo (un Zap que mira cada hora las ventas de ThriveCart para dar acceso en Kajabi);
- una pregunta ajena al máster (una receta);
- un precio de herramienta (el plan Pro de Make).

## Detalles técnicos que conviene saber

- **SDK antiguo (`@anthropic-ai/sdk` 0.27).** Funciona porque el SDK envía los campos tal cual (`output_config` incluido). Si se actualiza, revisar la API de `messages.create`.
- **Sonnet 5.5** razona antes de responder, y ese razonamiento cuenta dentro de `max_tokens`. No bajes de unos 4000 o las respuestas saldrán cortadas o vacías. No acepta `thinking: {type: "disabled"}`.
- **Caché del prompt:** el prompt del sistema se cachea, pero el material de apoyo va en el mensaje de usuario y cambia en cada pregunta, así que eso no se cachea.
- **Coste aproximado:** 0,03-0,04 $ por mensaje (10-15 mil tokens de entrada).
- **Sesiones de Claude Code en la nube:** la red del entorno tiene que permitir `backboard.railway.com`, `backboard.railway.app`, `railway.com` y `railway.app` (CLI de Railway); `*.up.railway.app` (para probar la URL pública); `mecanicadigital.com` (para consultar la web); y `fonts.googleapis.com` / `fonts.gstatic.com`.
- **mecanicadigital.com** tiene un antibots (SiteGround) que a veces devuelve un captcha a `curl`. Funciona con un User-Agent de navegador y la cabecera `Referer`.

## Pendiente

- [ ] Embeber en Kajabi (bloque de código HTML personalizado):
  `<iframe src="https://corrector-mecanicas-production.up.railway.app" style="width:100%;height:700px;border:none;border-radius:22px" title="Corrector de Mecánicas"></iframe>`
  Si no se ve en la vista previa del editor de Kajabi, añade ese dominio a `FRAME_ANCESTORS`.
- [ ] Probar con preguntas reales de alumnas y ajustar el prompt.
- [ ] Registro de conversaciones y avisos ("sin cubrir", "fuera de alcance"), por ejemplo en Airtable, con una política de retención y anonimización (datos de alumnas).
- [ ] Fusionar la rama de trabajo en `main`.
- [ ] Revocar en console.anthropic.com la clave `sk-ant-usr-…` que se probó al principio y no se usa.
