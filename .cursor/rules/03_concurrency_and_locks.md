# Concurrencia y locks (Redis)

## Redis Locking (CRÍTICO)

### Regla principal

NUNCA escribir en DB sin lock si hay riesgo de concurrencia.

---

## Implementación obligatoria

### Acquire

```ts
SET key value NX EX ttl
```

---

### Release (OBLIGATORIO)

Usar Lua script atómico:

```lua
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
```

---

## Prohibiciones

❌ NO usar:

```ts
GET + DEL
```

---

## Estrategia de locks

* Con lead existente:

  ```
  lock:lead:{lead_id}
  ```

* Sin lead:

  ```
  lock:lead:resolve:{tenant_id}:{phone}
  ```

---

## Reintentos

* máximo: 3
* backoff:

  ```
  [50ms, 150ms, 350ms] + jitter
  ```

---

## TTL

* default: 5s
* operaciones deben ser < TTL

---

## Fallo de lock

* lanzar error controlado:

  ```
  LeadLockContentionError
  ```
