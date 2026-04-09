# ALGORITHMUS — ARCHITECTURAL RULES (AGENT-PROOF v2)

## ESTADO

**OBLIGATORIO** — Estas reglas deben ser seguidas estrictamente por cualquier agente.

---

## 1. DEPENDENCY INJECTION (STRICT MODE)

### Regla

Todos los servicios deben instanciarse mediante inyección de dependencias explícita.

### Prohibido

- Constructores posicionales
- Constructores incompletos
- Instanciación sin dependencias reales
- Versiones "simplificadas" de servicios

### Correcto

```ts
const ragService = new RAGService({
  adapter: pineconeAdapter,
  logger,
});
const orchestrator = new Orchestrator({
  logger,
  supabase,
  fsmEngine,
  llmGateway,
  ragService,
});
```

### Incorrecto

```ts
new RAGService(logger);
new Orchestrator(fsm, llm, rag);
```

### Criterio de rechazo

Si un servicio core no recibe sus dependencias completas → **IMPLEMENTACIÓN INVÁLIDA**

---

## 2. ORDEN DE INICIALIZACIÓN (MANDATORY)

### Regla

El sistema debe inicializarse en este orden exacto:

1. Infra
2. AI Layer
3. Core
4. Handlers
5. Server

### Detalle

**1. Infra**

- Redis
- Supabase

**2. AI Layer**

- EmbeddingService
- PineconeRAGAdapter
- RAGService

**3. Core**

- FSMEngine
- LLMGateway
- IdentityManager
- Orchestrator

**4. Handlers**

- WhatsAppHandler
- Otros canales

**5. Server**

- Express
- `listen()`

### Incorrecto

```ts
const rag = new RAGService(...);
const redis = getRedis();
```

### Criterio de rechazo

Si el orden no se respeta → **IMPLEMENTACIÓN INVÁLIDA**

---

## 3. RAG ENFORCEMENT (NO STUBS)

### Regla

`RAGService` **SIEMPRE** debe usar un adapter real (Pinecone).

### Obligatorio

```ts
const pineconeAdapter = new PineconeRAGAdapter({
  logger,
  embeddingService,
});

const ragService = new RAGService({
  adapter: pineconeAdapter,
  logger,
});
```

### Prohibido

```ts
new RAGService(logger);
// cualquier implementación sin adapter
```

### Criterio de rechazo

Si RAG no usa adapter real → **IMPLEMENTACIÓN INVÁLIDA**

---

## 4. IDENTITY MANAGER CONTRACT

### Regla

`IdentityManager` debe recibir:

- `supabase`
- `redis`
- `logger`

### Correcto

```ts
new IdentityManager({
  supabase,
  redis,
  logger,
});
```

### Incorrecto

```ts
new IdentityManager({ logger });
```

### Criterio de rechazo

Falta de Redis o Supabase → **CRITICAL ERROR**

---

## 5. ORCHESTRATOR CONTRACT

### Regla

Debe instanciarse exactamente así:

```ts
new Orchestrator({
  logger,
  supabase,
  fsmEngine,
  llmGateway,
  ragService,
});
```

### Prohibido

```ts
new Orchestrator(fsm, llm, rag);
```

### Criterio de rechazo

Constructor incorrecto → **IMPLEMENTACIÓN INVÁLIDA**

---

## 6. SERVER.TS = COMPOSITION ROOT

### Regla

`server.ts` **SOLO** puede contener:

- Wiring de dependencias
- Inicialización de servicios
- Configuración de Express
- Registro de handlers
- Inicio del servidor

### Prohibido

- Lógica de negocio
- Llamadas a LLM
- Llamadas a RAG
- Manipulación de mensajes
- Condicionales de dominio

### Correcto

```ts
const app = express();
configureWhatsAppHandler(app, deps);
app.listen(PORT);
```

### Incorrecto

```ts
if (message.includes("precio")) {
  // lógica de negocio ❌
}
```

### Criterio de rechazo

Si hay lógica de negocio en `server.ts` → **INVALID**

---

## 7. NO SHORTCUTS RULE

### Regla

El agente **NO** puede:

- Simplificar constructores
- Omitir dependencias
- Crear versiones "mínimas"
- Usar defaults implícitos no definidos

### Ejemplo prohibido

```ts
new RAGService();
```

### Criterio

Si existe una versión más completa → usarla **SIEMPRE**

---

## 8. LOGGING RULE

### Regla

- **SOLO** usar pino
- **NUNCA** usar `console.log`

### Incorrecto

```ts
console.log("debug");
```

### Correcto

```ts
logger.info({ event: "..." });
```

---

## 9. ENV VALIDATION (FAIL-FAST)

### Regla

Las variables críticas deben validarse **antes** de inicializar el sistema.

### Variables críticas

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `REDIS_URL`
- `OPENAI_API_KEY`
- `PINECONE_API_KEY`
- `PINECONE_INDEX_HOST`

### Criterio

Si falta alguna → `process.exit(1)`

---

## 10. ANTI-PATTERNS PROHIBIDOS

Lista absoluta:

- Constructores simplificados
- RAG sin adapter
- Orchestrator mal instanciado
- IdentityManager sin Redis/Supabase
- Lógica en server
- `console.log`
- Stubs en producción
- Dependencias implícitas
- Inicialización fuera de orden

---

## 11. TEMPLATE OBLIGATORIO — SERVER.TS

### Estructura

```ts
// 1. Validación ENV

// 2. Infra
const redis = ...
const supabase = ...

// 3. AI
const embedding = ...
const adapter = ...
const rag = ...

// 4. Core
const fsm = ...
const llm = ...
const identity = ...
const orchestrator = ...

// 5. Express
const app = express()

// 6. Handlers
configureWhatsAppHandler(app, ...)

// 7. Listen
app.listen(...)
```

---

## 12. CRITERIO GLOBAL DE VALIDACIÓN

Una implementación es válida **SOLO** si:

- Respeta dependency injection
- Respeta orden de inicialización
- No usa stubs
- Usa adapters reales
- No tiene lógica en server
- Usa pino
- Tiene env validation

Si cualquiera falla → **RECHAZAR IMPLEMENTACIÓN**

---

## 13. COMPORTAMIENTO DEL AGENTE

El agente debe:

- Validar constructores antes de usar
- No asumir firmas
- No simplificar arquitectura
- Detenerse si hay ambigüedad
- Priorizar exactitud sobre velocidad
