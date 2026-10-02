# Discord Consent Join Bot — Railway Easy

Bot de directorio/promoción de servidores con consentimiento por servidor.

## Lo que hace

- `/setup` crea `#verificarme` y `#servidores`.
- `Verificarme con Discord` usa OAuth2 con `identify` + `guilds.join`.
- `/unirse invite:<url> limite:<n>` publica un servidor.
- Cada usuario pulsa **Unirme** para aceptar entrar en ese servidor concreto.
- `/estado id:<campaña>` muestra al admin, de forma privada: unidos / pendientes / fallidos.
- Los tokens OAuth se guardan cifrados.
- Si añades un Railway Volume, `data.json` se guarda automáticamente en ese volumen.

> Este proyecto no mete silenciosamente a todos los usuarios verificados en servidores nuevos. La autorización de la cuenta y la aceptación del servidor se mantienen separadas.

## Configuración simplificada

En Railway solo necesitas crear manualmente estas dos variables secretas:

```env
DISCORD_BOT_TOKEN=...
DISCORD_CLIENT_SECRET=...
```

No necesitas escribir `CLIENT_ID`, `REDIRECT_URI`, `ENCRYPTION_KEY` ni la URL pública de Railway:

- El Client/Application ID se obtiene automáticamente del bot.
- La URL pública usa `RAILWAY_PUBLIC_DOMAIN` automáticamente.
- La callback queda como `https://TU-DOMINIO.up.railway.app/oauth/callback`.
- La clave de cifrado se deriva localmente del Client Secret.

## Paso a paso: Discord Developer Portal

1. Entra en Discord Developer Portal y crea una aplicación.
2. Abre **Bot** y crea/activa el bot.
3. Copia el **Bot Token**. No lo publiques ni lo subas a GitHub.
4. Abre **OAuth2** y copia/genera el **Client Secret**. Tampoco lo publiques.
5. Para instalar el bot en tu servidor, usa el instalador/OAuth2 de Discord con `bot` + `applications.commands` y dale los permisos necesarios para ver/enviar mensajes, insertar enlaces y administrar canales si quieres usar `/setup`.

## Paso a paso: GitHub

1. Descomprime el ZIP.
2. Crea un repositorio privado en GitHub.
3. Usa **Add file → Upload files**.
4. Sube los archivos de dentro de la carpeta del proyecto.
5. No subas un archivo `.env`. `.env.example` sí es seguro.
6. Pulsa **Commit changes**.

## Paso a paso: Railway

1. Crea un proyecto con **GitHub Repository** y selecciona tu repositorio.
2. Abre el servicio → **Variables**.
3. Añade `DISCORD_BOT_TOKEN` y `DISCORD_CLIENT_SECRET`.
4. Abre **Settings → Networking → Generate Domain**.
5. Copia el dominio generado, por ejemplo `mi-bot.up.railway.app`.
6. Vuelve al Discord Developer Portal → tu aplicación → **OAuth2** → **Redirects**.
7. Añade EXACTAMENTE:

   `https://mi-bot.up.railway.app/oauth/callback`

8. Guarda los cambios en Discord.
9. En Railway, redepliega el servicio si no se redepliega automáticamente.
10. Opcional pero recomendado: añade un **Volume** con mount path `/data`. El bot lo detecta automáticamente y conserva verificaciones/campañas entre despliegues.

## Probar el bot

1. En tu servidor ejecuta `/setup`.
2. Entra en `#verificarme` y pulsa **Verificarme con Discord**.
3. Discord mostrará los permisos OAuth solicitados.
4. Asegúrate de que el bot también está instalado en el servidor de destino.
5. Ejecuta `/unirse invite:https://discord.gg/... limite:10`.
6. Los usuarios interesados pulsan **Unirme**.
7. Ejecuta `/estado id:<id>` para ver el progreso de forma privada.

## Notas

- La callback web solo muestra una confirmación sencilla; el usuario no tiene que rellenar formularios externos.
- Si cambias/resetas el Client Secret, los usuarios ya verificados tendrán que autorizar de nuevo.
- No compartas nunca `DISCORD_BOT_TOKEN` ni `DISCORD_CLIENT_SECRET`.
- Para pruebas rápidas puedes añadir `DEV_GUILD_ID` como variable opcional. Sin ella, los comandos se registran globalmente.
