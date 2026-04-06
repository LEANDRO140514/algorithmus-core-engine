# Control de alcance (scope)

## Control de cambios (CRÍTICO)

Cursor TIENDE a modificar más archivos de los solicitados.

---

## Reglas obligatorias

* SOLO modificar archivos especificados en el prompt
* NO crear archivos adicionales sin autorización
* NO refactorizar fuera del scope

---

## Anti-patrones

❌ modificar routes sin pedirlo
❌ cambiar clients infra
❌ tocar cursorrules automáticamente

---

## Validación

Antes de aplicar cambios:

* verificar lista de archivos modificados
* rechazar cambios fuera de scope
