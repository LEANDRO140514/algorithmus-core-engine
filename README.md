# Algorithmus Core Engine

Orquestador **Node + TypeScript**: FSM, LLM/RAG, validación IA (Safety / Grounding / HardGate), WhatsApp vía YCloud, Redis (BullMQ + locks).

## Persistencia

- **Runtime principal (Express, worker):** [PostgreSQL](https://www.postgresql.org/) vía **`DATABASE_URL`** y [`LeadsRepository`](src/infra/postgres/LeadsRepository.ts) (`pg` pool en [`src/infra/postgres/client.ts`](src/infra/postgres/client.ts)).
- **Legado:** el webhook GHL bajo `src/app/api/webhooks/ghl/` puede seguir usando el cliente Supabase (`src/core/supabase_client.ts`); no forma parte del path principal. Detalle arquitectónico: [**ADR-006 — Postgres migration**](docs/brain/ADR-006-postgres-migration.md).

## Configuración

Copiá [`.env.example`](.env.example) a `.env` y completá al menos `DATABASE_URL`, `OPENAI_*`, `PINECONE_*`, `YCLOUD_*`, `REDIS_URL` según tu entorno.

## Clean local bootstrap

1. `npm install`
2. Configurá `.env` desde [`.env.example`](.env.example)
3. Verificá que `DATABASE_URL` esté definido
4. Ejecutá:
   - `npm run db:migrate`
   - `npm run smoke:postgres`
   - `npm run prepush:core`

Notas:
- Supabase es **legacy-only** para `src/app/api/webhooks/ghl/route.ts`.
- El Core Engine **no depende** de Supabase en runtime.

## Comandos

```bash
npm install
npm run build
npm test
npm run start
npm run worker:whatsapp
```

## Próximos pasos (producto / arquitectura)

Identidad **agnóstica de canal**: unificar ingestión y persistencia de leads para todos los orígenes tras el mismo boundary (`IdentityManager` + `LeadsRepository`). Ver ADR-006.
