# Supabase

## 1. Crear el proyecto

1. Crea un proyecto en Supabase.
2. En `SQL Editor`, ejecuta [`supabase/schema.sql`](./supabase/schema.sql).
3. En `Authentication > Users`, crea el usuario con el que entrarás a `admin.html`.

## 2. Configurar la app

Rellena [`supabase-config.js`](./supabase-config.js) con:

```js
window.OposAppConfig = window.OposAppConfig || {};
window.OposAppConfig.supabase = {
  url: "https://TU-PROYECTO.supabase.co",
  anonKey: "TU_ANON_KEY",
  questionsTable: "questions",
  reportsTable: "question_reports",
  siteName: "Simulador OPE Euskadi",
};
```

La `anonKey` es pública y se puede usar en GitHub Pages. La `service role key` no debe ir nunca al navegador.

## 3. Importar las preguntas actuales

Desde terminal:

```powershell
$env:SUPABASE_URL="https://fdnrrzxhhhmljeezibjx.supabase.co/rest/v1/"
$env:SUPABASE_SERVICE_ROLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZkbnJyenhoaGhtbGplZXppYmp4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NjI3MDkyNiwiZXhwIjoyMDkxODQ2OTI2fQ.2yp-2Pib20_qz092SDGTn6eFqQeHZW61HfrOPQ5NiDw"
node .\scripts\import-to-supabase.mjs
```

## 4. Publicar

- `index.html`: simulador público.
- `index2.html`: home alternativa del simulador.
- `admin.html`: panel para editar y revisar incidencias.

## 5. Flujo de trabajo

- La app pública lee preguntas activas de Supabase.
- Cualquier persona puede usar `Reportar pregunta`.
- En `admin.html` podéis iniciar sesión, corregir la pregunta y marcar la incidencia como resuelta.
