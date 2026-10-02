# Registro de Clientes (PWA para iPhone)

App web instalable en iPhone para registrar clientes diarios: nombre, WhatsApp,
resultado (separación / en conversación / se cayó), motivo de caída y seguimiento.
La data aterriza en Google Sheets (descargable como Excel) y también se puede
exportar a .xlsx/.csv directo desde la app.

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
