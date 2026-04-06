# LLM Gateway

## Responsabilidad

Abstraer múltiples proveedores LLM.

---

## Reglas

* todos los providers deben devolver:

```ts
type LLMResponse = {
  text: string
  confidence: number
  tokens: number
  provider: string
  latency_ms: number
}
```

---

## Fallback

Orden:

1. Ollama
2. OpenRouter
3. Gemini

---

## Condición de fallback

* timeout > 5000ms
* error de red

---

## Prohibiciones

❌ lógica de negocio en LLM
❌ decisiones de FSM en LLM
