# Bot de WhatsApp de Territorio

Creado 09-09-2026. Sigue el árbol de conversación del documento **"Embudo
Territorio"** (el plan que armamos junto con la estructura de campaña).
No reemplaza el formulario de la web: cuando alguien escribe "quiero probar
gratis", le pide los mismos datos por chat y al final llama a **la misma
función de Supabase** que usa `inteligencia/index.html` — así que un cliente
inscrito por WhatsApp o por la web queda exactamente igual en la base.

Esto es una BASE lista para conectar, no un servicio ya funcionando: sin los
3 datos de Meta (ver más abajo) el servidor prende pero no puede mandar ni
recibir mensajes reales.

## 1. Lo que falta de tu parte (Meta)

Está el detalle completo en la sección "Checklist" del documento del embudo.
En resumen: verificar el negocio en Meta Business Suite, crear una app con el
producto WhatsApp, y sacar de ahí 3 datos:

- `META_WHATSAPP_TOKEN` — el token de acceso permanente
- `META_PHONE_NUMBER_ID` — el ID del número de teléfono del bot
- `META_VERIFY_TOKEN` — una palabra que inventas tú y usas en dos lugares (ver paso 4)

## 2. Instalar y probar en tu computador

```bash
cd deploy-project/whatsapp-bot
npm install
cp .env.example .env
```

Completa el `.env` con los 3 datos de arriba, y después:

```bash
npm start
```

Si ves `Bot de Territorio escuchando en el puerto 3000`, el servidor corre
bien. Pero Meta necesita una dirección pública (`https://...`) para poder
mandarle mensajes — tu computador con `localhost` no le sirve. Por eso el
paso 3.

## 3. Dónde alojarlo

No hace falta un servidor propio. La opción más simple para este tamaño de
bot es un plan gratuito de **Render** o **Railway**: se conecta el repositorio,
se pegan las mismas variables del `.env` en su panel, y ellos entregan una
dirección `https://tu-bot.onrender.com` ya pública. Avísame cuando tengas la
cuenta creada en cualquiera de los dos y te ayudo a dejarlo andando ahí.

## 4. Conectar el webhook en Meta

En el panel de tu app (developers.facebook.com → tu app → WhatsApp →
Configuración):

1. En "Callback URL" pegas `https://tu-bot.onrender.com/webhook`.
2. En "Verify token" pegas la MISMA palabra que pusiste en `META_VERIFY_TOKEN`.
3. Guardas. Meta llama esa dirección una vez para comprobarla — si el
   servidor está corriendo con las variables bien puestas, queda verificado solo.
4. Te suscribes al campo `messages`.

Desde ahí, escribirle al número del bot ya debería activar el menú.

## Qué falta más adelante (a propósito no está en esta primera versión)

- **Guardar la conversación en Supabase en vez de en memoria**: hoy si el
  servidor se reinicia, alguien a mitad de una conversación tiene que volver
  a escribir "hola". No se armó de entrada para no meter una tabla más antes
  de saber si el bot se usa de verdad.
- **Los recordatorios automáticos del día 5 y día 7 de la prueba** (los nodos
  de "recordatorio" del diagrama): esos no los dispara una visita a este
  webhook, sino un reloj — el mismo patrón que ya usa `app-stock` con
  `pg_cron` de Supabase. Se arma como un paso aparte cuando el bot esté en vivo.
