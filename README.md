# RW Cloud Personal Worker

Backend personal y colaborativo de **RW Studio** sobre Cloudflare Workers, R2 y Durable Objects.
Cada usuario lo despliega dentro de su propia cuenta; RW Studio no recibe las credenciales de Cloudflare.

## Despliegue en pocos pasos

1. Publica esta carpeta como repositorio público de GitHub o GitLab.
2. Abre la página `docs/index.html` mediante GitHub Pages, o usa directamente:

   `https://deploy.workers.cloudflare.com/?url=https://github.com/USUARIO/REPOSITORIO`

3. Durante el despliegue, pega en `RW_BOOTSTRAP_SECRET` el secreto generado por RW Studio.
4. Al terminar, abre la dirección `https://...workers.dev` y cópiala en RW Studio.
5. Pulsa **Vincular Worker desplegado**.

Cloudflare detectará `wrangler.jsonc` y creará el bucket R2 y los dos coordinadores Durable Objects.

## Lo que almacena

- R2: proyectos, archivos, borradores y copias previas a renombrados.
- Durable Objects: participantes, invitaciones, presencia, bloqueos, sesiones e historial.
- Secreto del Worker: cifra y autentica códigos, sesiones e invitaciones.

## Seguridad

- Nunca publiques el valor real de `RW_BOOTSTRAP_SECRET`.
- `.dev.vars` y `.env` están ignorados por Git.
- Los códigos de acceso incluyen la dirección del Worker y una invitación cifrada con AES-GCM.
- Las rutas se normalizan y no aceptan `..`, rutas absolutas ni el directorio reservado `.rwstudio`.
- Los guardados usan bloqueo temporal y ETag para evitar sobrescrituras silenciosas.
- El modo gratuito limita por defecto el almacenamiento administrado por RW Studio a 8 GiB.

## Desarrollo opcional

```bash
npm install
cp .dev.vars.example .dev.vars
# Sustituye el valor de RW_BOOTSTRAP_SECRET
npm run check
npm run dev
```

## Despliegue alternativo por terminal

```bash
npm install
npx wrangler login
npx wrangler secret put RW_BOOTSTRAP_SECRET
npm run deploy
```

No se necesita GitHub Pages como servidor. La página en `docs/` es únicamente un asistente estático para abrir el despliegue oficial.
