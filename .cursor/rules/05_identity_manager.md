# IdentityManager

## Responsabilidad

IdentityManager es responsable de:

* resolver lead por (tenant_id, phone)
* garantizar unicidad
* evitar race conditions

---

## Flujo obligatorio

```txt
normalize → peek → lock → lookup → (ghl?) → upsert → release
```

---

## Reglas

* NO escribir sin lock
* SIEMPRE usar teléfono normalizado
* GHL es fallback, no fuente de verdad
* Upsert debe ser mínimo (no destructivo)

---

## Logging mínimo

* validate_phone
* phone_normalized
* lock_acquire_start
* lock_acquired
* lock_failed
* ghl_fallback
* upsert_atomic
* upsert_ok
* lock_released
