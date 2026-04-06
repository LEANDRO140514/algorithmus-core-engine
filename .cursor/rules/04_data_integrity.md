# Integridad de datos

## Base de datos

### SSOT

* PostgreSQL es la única fuente de verdad
* Supabase NO es lógica, solo acceso

---

## Constraints obligatorios

* UNIQUE (tenant_id, phone_number)
* índices por tenant_id

---

## Upsert rules

* usar:

  ```ts
  onConflict: "tenant_id,phone_number"
  ```

* NO sobrescribir campos no controlados:

  * fsm_state
  * tags
  * ai_confidence_score

---

## JSONB

* usar JSONB para metadata flexible
* evitar estructuras dinámicas sin schema

---

## Normalización

* phone_number SIEMPRE en formato E.164
* normalizar antes de:

  * lookup
  * lock
  * insert

---

## Idempotencia

* upsert debe ser determinístico
* múltiples ejecuciones → mismo resultado
