# Supabase

## 1. Crear el proyecto

1. Crea un proyecto en Supabase.
2. En `SQL Editor`, ejecuta [`../supabase/schema.sql`](../supabase/schema.sql).
3. En `Authentication > Users`, crea el usuario con el que entrarás a `admin.html`.

## 2. Configurar la app

Rellena [`../supabase-config.js`](../supabase-config.js) con:

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
$env:SUPABASE_URL="https://TU-PROYECTO.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="TU_SERVICE_ROLE_KEY"
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
- La app guarda estadísticas por usuario autenticado en la tabla `user_stats`.

## 6. Al cambiar el esquema

Si ya habías ejecutado una versión anterior de `schema.sql`, vuelve a lanzar el archivo actualizado en `SQL Editor` para recrear `user_stats` y sus políticas.

## 7. Estadísticas por usuario

- El usuario público tiene que iniciar sesión desde la home para sincronizar sus estadísticas con Supabase.
- Cada fila de `user_stats` queda ligada a `auth.users.id`.
- Si no inicia sesión, el progreso sigue quedándose en `localStorage` del navegador.

## 8. Rol admin

- El simulador y el panel admin usan la misma sesión.
- Para que una cuenta sea admin, añade `role: "admin"` en `app_metadata` o `user_metadata` del usuario en Supabase Auth.
- Si el usuario es admin, el escudo del simulador aparece en verde y puede abrir `admin.html`.
- Si no lo es, el escudo aparece en rojo y el panel admin queda bloqueado.
