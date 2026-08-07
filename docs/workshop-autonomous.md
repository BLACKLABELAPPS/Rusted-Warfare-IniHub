# Publicación autónoma de Steam Workshop

La publicación se ejecuta completamente mediante GitHub e IniHub. Android, iOS y Windows usan el mismo flujo y ninguna plataforma necesita encontrar otro dispositivo.

## Flujo

1. La aplicación empaqueta el contenido y la vista previa.
2. Los archivos se guardan en `runtime/workshop_uploads/<token>/`.
3. La aplicación registra el trabajo en `database/rw_shared_accounts.json`.
4. La aplicación dispara `.github/workflows/workshop-publish.yml` mediante `workflow_dispatch`.
5. GitHub Actions ejecuta SteamCMD en un runner Windows.
6. El resultado se escribe en `runtime/workshop_jobs/<job_id>/status.json`.
7. La aplicación consulta ese estado y conserva las rutas compatibles `/api/publish-upload`, `/api/publish` y `/api/publish/run-status` en su servidor interno de loopback.

El servidor interno se enlaza únicamente a `127.0.0.1`; actúa como fachada local de compatibilidad y no busca equipos externos.

## Capacidades conservadas

- publicación pública forzada;
- creación y actualización de artículos mediante `published_file_id`;
- categorías Maps, Units y Total Conversion;
- `workshop_item.vdf` y `mod-info.txt`;
- `config.vdf`, `localconfig.vdf`, `userdata` y archivos SSFN;
- contraseña y código Steam Guard cuando sean necesarios;
- selección de una cuenta de un grupo cacheado;
- registro de salida de SteamCMD y estado final en IniHub.

## Secretos del repositorio

Se puede usar un grupo mediante `STEAM_ACCOUNT_POOL_JSON`, o una sola cuenta con:

- `STEAM_USERNAME`
- `STEAM_PASSWORD` (opcional si la sesión cacheada basta)
- `STEAM_GUARD_CODE` (opcional)
- `STEAM_CONFIG_VDF`
- `STEAM_LOCALCONFIG_VDF`
- `STEAM_USERDATA_ID`
- `STEAM_SSFN_FILE_NAME`
- `STEAM_SSFN_FILE_CONTENTS`

También se admiten `STORAGE_CONFIGS_JSON` y `WORKFLOW_REPO_CONFIGS_JSON` para resolver contenido privado alojado en GitHub.

`STEAM_ACCOUNT_POOL_JSON` acepta una lista o un objeto con la propiedad `accounts`. Cada cuenta puede usar los nombres anteriores o sus equivalentes en minúsculas, como `username`, `password`, `config_vdf_base64`, `localconfig_vdf_base64`, `userdata_id`, `ssfn_file_name` y `ssfn_file_contents_base64`.

Los secretos pertenecen exclusivamente a GitHub Actions y nunca se guardan dentro de los trabajos ni de los archivos de estado.
