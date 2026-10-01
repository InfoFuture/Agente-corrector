# Corrector de Mecánicas — backend de producción

Esto es lo que hace falta para que el corrector funcione de verdad con alumnas
dentro de Kajabi: un servidor pequeño que llama a la API de Anthropic con
**las credenciales propias de MD** (no las de quien lo usa), y una página de
chat que se embebe en Kajabi mediante un iframe.

No es el artifact de prueba de Claude.ai (ese sirve solo para que el equipo
pruebe internamente). Esto es la pieza que falta para producción.

## Qué incluye

- `server.js` — servidor Express con un único endpoint `POST /api/correct`.
  Aplica el mismo prompt del corrector y la misma lógica de recuperación de
  conocimiento (solo carga 1-2 documentos relevantes por pregunta, no los 33
  enteros, para no disparar el gasto de tokens).
- `kb_docs.json` — las 33 fuentes (5 sesiones de corrección de Alba + 28
  transcripciones de clase). Cuando Alba mande más sesiones o módulos,
  este es el archivo a actualizar (ver más abajo).
- `public/index.html` — el widget de chat que ve la alumna. Permite adjuntar
  fotos, PDF y Word igual que el prototipo de prueba.

## 1. Desplegar el servidor

Necesitas un sitio donde correr Node.js. Cualquiera de estos sirve (elige el
que ya uséis o el más barato/sencillo):

- **Render.com** o **Railway.app**: conectas el repo, defines las variables
  de entorno de abajo, y listo. Es la opción más simple si no tenéis ya un
  servidor.
- Un VPS propio con PM2: `npm install && pm2 start server.js --name corrector`.

Variables de entorno necesarias:

```
ANTHROPIC_API_KEY=sk-ant-...          # la clave de MD en la Anthropic Console
ANTHROPIC_MODEL=claude-sonnet-5-5     # o el modelo que decidáis usar
ANTHROPIC_EFFORT=low                  # opcional: low | medium | high (más esfuerzo = más coste)
ALLOWED_ORIGIN=https://<dominio-del-servidor>   # el widget llama a la API desde su propio dominio
FRAME_ANCESTORS="https://instituto.mecanicadigital.com https://mecanicadigital.com"  # opcional: webs que pueden embeber el iframe
RATE_LIMIT_PER_HOUR=30                # opcional: mensajes por IP y hora
PORT=3000                              # opcional, lo suele fijar el propio host
```

Instalación local para probar antes de desplegar:

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
# abre http://localhost:3000 en el navegador
```

## 2. Insertarlo en Kajabi

Una vez el servidor esté desplegado (tendréis una URL tipo
`https://corrector-md.onrender.com`), en Kajabi:

1. Ve a la lección donde quieras que aparezca el corrector.
2. Añade un bloque de **código HTML personalizado** (Kajabi lo permite en
   la mayoría de layouts de contenido).
3. Pega algo así (ajustando alto y URL):

```html
<iframe
  src="https://corrector-md.onrender.com"
  style="width:100%; height:650px; border:none; border-radius:8px;"
  title="Corrector de Mecánicas">
</iframe>
```

No hace falta nada más: la alumna ve el chat embebido en la propia lección,
sin salir de Kajabi, y cada mensaje que escribe va a vuestro servidor, que
llama a Claude con vuestra clave.

## 3. Actualizar la base de conocimiento cuando Alba mande más material

1. Convierte los `.docx` nuevos a texto (igual que hicimos hasta ahora:
   `pandoc archivo.docx -t plain -o archivo.txt`).
2. Añade una entrada al array de `kb_docs.json` con esta forma:
   ```json
   { "title": "Nombre descriptivo del tema", "content": "...", "kind": "sesion" }
   ```
   Usa `"kind": "sesion"` para las fichas de corrección escritas por Alba
   (como las Sesiones 1-5) y `"kind": "clase"` para transcripciones de clase
   sueltas — las `"sesion"` pesan más en la búsqueda porque son más fiables.
3. Vuelve a desplegar (o solo subir el `kb_docs.json` nuevo, según el host).

No hace falta tocar `server.js` ni el prompt para añadir contenido nuevo.

## 4. Seguimiento de uso (lo que antes veíais en "Ver registro de pruebas")

Esta versión no incluye logging todavía — lo dejé fuera para no bloquear el
despliegue. Si lo queréis (recomendado antes de soltarlo con alumnas reales,
para poder ver qué falla), decídmelo y añado:
- una tabla sencilla (puede ser un archivo, SQLite, o una tabla en vuestro
  Airtable/Notion ya que los usáis) con cada intercambio y sus flags
  ("sin cubrir en la base", "fuera de alcance"), y
- una política de retención/anonimización, porque aquí ya seríamos datos
  reales de alumnas pagando, no solo pruebas internas del equipo.

## Coste y modelo

`ANTHROPIC_MODEL` está en `claude-sonnet-5-5` por defecto como equilibrio entre
calidad de corrección y coste. El prompt del sistema se envía con
`cache_control: ephemeral`, así que las llamadas repetidas en una ventana
corta de tiempo no vuelven a cobrar ese bloque completo — esto es justo la
optimización de caché de la que hablamos antes y que en el artifact de
prueba no era posible.
