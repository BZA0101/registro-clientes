# Registro de Clientes (PWA para iPhone)

App web instalable para el embudo de ventas de un asesor: leads → conversación →
separación → venta (con monto). La data vive en Supabase (con login) y también
puede replicarse a Google Sheets o exportarse a .xlsx/.csv desde la app.

## Login + base de datos (Supabase, 10 min)

1. supabase.com → New project (gratis).
2. SQL Editor → pega todo `supabase/schema.sql` → Run.
3. Settings → API → copia **Project URL** y **anon public key**.
4. Pégalas en `supabase-config.js` (queda para todos) o en la app:
   Ajustes → Supabase (solo ese dispositivo).
5. Authentication → Sign In / Providers: deja Email activado.
   Para pruebas rápidas, desactiva "Confirm email" en
   Authentication → Sign In / Up → Email (si no, hay que confirmar el correo).

Sin claves la app funciona igual que antes (localStorage, sin login).

## Embudo de estados

`nuevo` → `conversando` → `separado` → `venta` (con monto y fecha)
y `cayo` (con motivo) desde cualquier etapa.
En **Clientes**: filtros Nuevos / Conversando / Separaciones / Ventas / Caídos.
En **Panel**: $ vendido del mes, ticket promedio y embudo de conversión.

## Conectar el Excel (15 min)

### 1. Crear el Sheet + script
1. drive.google.com → Nuevo → **Hoja de cálculo de Google**. Ponle "Clientes".
2. **Extensiones → Apps Script**. Borra el código que aparece y pega todo
   el contenido de `apps-script.gs`.
3. (Opcional pero recomendado) En la línea `const CLAVE = ''` escribe una clave,
   ej. `const CLAVE = 'vendedora2026'`.
4. Guarda (icono disquete).

### 2. Publicar el script
1. Arriba a la derecha: **Implementar → Nueva implementación**.
2. Tipo: **Aplicación web**.
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier persona**
3. Implementar → autoriza con tu cuenta de Google (aviso normal, es tu script).
4. Copia la **URL de la aplicación web** (empieza con `https://script.google.com/macros/s/`).

### 3. Publicar la app
Arrastra esta carpeta a **netlify.com/drop** → te da una URL pública.
(O sirve `localhost` para probar — el envío al Sheet funciona igual.)

### 4. Conectar en el iPhone
1. Abre la URL en **Safari** → Compartir → "Agregar a pantalla de inicio".
2. Abre la app → **Ajustes** → pega la URL y la clave → "Guardar conexión".

Listo. El Sheet se llena solo con dos pestañas:
- **Historial**: una fila por cada evento (registro o cambio de estado).
- **Estado actual**: una fila por cliente, siempre con su último estado.

Para tenerlo en Excel: en el Sheet → Archivo → Descargar → Microsoft Excel (.xlsx).

## WhatsApp automático (leads que llegan solos)

Cuando alguien escribe al número de WhatsApp Business del asesor, el lead se
crea solo en "Nuevos" con su primer mensaje, y se puede auto-responder.

### En Meta for Developers (una vez)
1. developers.facebook.com → My Apps → Create app → tipo **Business**.
2. Dentro de la app → **WhatsApp → API Setup** → ahí salen:
   - **Phone number ID** y el **token** (para producción genera uno permanente
     en Business Settings → System Users).
3. **Configuration → Webhook**: URL = `https://TU-SERVIDOR/api/wa/webhook`,
   Verify token = el valor de `WA_VERIFY_TOKEN` del servidor. Suscríbete al
   campo **messages**.

### En el servidor (Render → Environment)
```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=<service_role key>   # NUNCA en el frontend
WA_VERIFY_TOKEN=<cualquier clave que elijas>
GROQ_API_KEY=<key de console.groq.com>    # transcripcion + resumen IA de lives
```

## Escucha del live (voz del streamer)

Con `GROQ_API_KEY` el servidor intenta **capturar el audio del live
directamente** (ffmpeg baja el stream de TikTok → segmentos de 30s →
Groq Whisper) y genera el **resumen IA automáticamente al cerrar el análisis**,
sin que el usuario haga nada.

- No requiere micrófono ni que la app esté abierta — funciona también para
  lives de la competencia analizados en segundo plano.
- Si TikTok bloquea la extracción de la URL del stream, el análisis de chat
  sigue igual y el botón de micrófono (captura local) sigue disponible
  como respaldo.
- La transcripción y el resumen se guardan en la tabla `lives` de Supabase.

## Cobrar con Stripe (plan Pro)

Sin `STRIPE_KEY` el servidor corre en modo abierto (todo gratis, para dev).
Con Stripe configurado, Live/WhatsApp/IA requieren `plan=pro`.

### En Stripe (stripe.com)
1. **Products → Add product**: "Plan Pro" → precio recurrente (ej. $199 MXN/mes)
   → copia el **Price ID** (`price_...`).
2. **Developers → API keys** → copia la **Secret key** (`sk_...`).
3. **Developers → Webhooks → Add endpoint**:
   `https://TU-SERVIDOR/api/stripe/webhook` → eventos:
   `checkout.session.completed` y `customer.subscription.deleted`
   → copia el **Signing secret** (`whsec_...`).

### Env vars extra en el servidor
```
STRIPE_KEY=sk_live_...           # o sk_test_ para pruebas
STRIPE_PRICE_PRO=price_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Para darte Pro a ti mismo sin pagar: Supabase → Table editor → `perfiles`
→ cambia `plan` a `pro` en tu usuario.

### En la app
Ajustes → WhatsApp automático → pega Phone ID, token, número y la
auto-respuesta que se manda al primer mensaje de cada lead.

## Funciones
- **Hoy**: resumen del día, seguimientos por retomar, registrar cliente.
- **Clientes**: pipeline con filtros (activos / separados / caídos), botones
  de WhatsApp y llamada por cliente.
- **Panel**: dona de % cierre, resumen del mes vs. mes anterior, clientes por
  día (7 días) y ranking de motivos de caída.
- **Ajustes**: descargar Excel/CSV, conexión al Sheet, borrado local.
- Funciona sin internet; los registros se encolan y se envían al volver.

## Servidor (Live de TikTok + notificaciones)

```
cd server && npm start    # app + API en http://localhost:3000
```

- **Pestaña Live**: escribe cualquier usuario de TikTok. Si está en vivo, mide
  viewers, pico, comentarios, likes, regalos y detecta posibles clientes
  (comentarios con "precio", "info", "quiero", "cuánto", etc.) hasta que lo detengas.
  Al terminar guarda el resumen en el historial del servidor y en el Sheet.
- **Push diario 20:00**: en Ajustes → "Aviso a las 8:00 pm". En iPhone requiere
  la app instalada desde HTTPS (cuando esté publicada); en localhost funciona
  desde Chrome de escritorio.
- Para producción: sube `server/` a Railway/Render y sirve la app desde ahí
  (mismo origen = cero configuración extra).

Columnas del Sheet/Excel: NOMBRES · TELEFONO · ESTADO · MOTIVO · FECHA Y HORA
(+ SEGUIMIENTO y NOTAS extra en el Sheet).
