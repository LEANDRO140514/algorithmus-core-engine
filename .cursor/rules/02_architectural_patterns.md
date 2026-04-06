# Patrones arquitectónicos

## Arquitectura Base

* Modular Monolith
* Event-driven interno
* Separación estricta por capas:

```
core/       → lógica de negocio (FSM, Identity, LLM)
modules/    → canales externos (WhatsApp, Voice, Email)
infra/      → DB, Redis, clients
shared/     → tipos, utils, schemas
```

---

## Reglas Obligatorias

### 1. NO acoplamiento directo

❌ Prohibido:

* llamar módulos directamente
* importar lógica cruzada sin interface

✔ Usar:

* funciones puras
* interfaces
* event bus (cuando aplique)

---

### 2. FSM es la única fuente de estado

* Ningún módulo puede modificar `fsm_state` directamente
* IdentityManager NO modifica FSM

---

### 3. LLM NO decide lógica

* LLM genera texto
* FSM decide transición

---

### 4. Multitenancy obligatorio

Toda función debe recibir:

```ts
tenantId: string
```

---

### 5. Idempotencia

* Operaciones críticas deben ser seguras ante reintentos
* Upserts deben usar constraints

---

### 6. Logging estructurado

* usar Pino
* incluir siempre:

  * trace_id
  * module
  * step
