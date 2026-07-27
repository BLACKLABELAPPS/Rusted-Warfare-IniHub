# Pruebas recomendadas

Después de desplegar, comprueba:

1. `GET /v1/health` responde `ok: true`.
2. Vinculación con secreto correcto e incorrecto.
3. Creación de proyecto y códigos owner/editor/reader.
4. Dos clientes intentando bloquear el mismo archivo.
5. Guardado con ETag antiguo devuelve conflicto 412.
6. Pausa/cierre: borrador remoto y liberación del bloqueo.
7. Carga multipart de un archivo grande.
8. Recuperación de identidad en otro dispositivo.
