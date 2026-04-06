# Tech Stack Obligatorio

* Runtime: Node.js 20+
* Lenguaje: TypeScript (strict mode)
* Base de datos: PostgreSQL (Supabase)
* Cache / coordinación: Redis 7
* Contenedores: Docker

## Reglas

* NO usar ORM (Prisma, TypeORM, etc.)
* Acceso a DB vía queries explícitas o Supabase client
* Redis se usa para:

  * locks distribuidos
  * coordinación de eventos
* Variables de entorno obligatorias:

  * DATABASE_URL
  * REDIS_URL

## Estándares

* async/await obligatorio
* sin callbacks legacy
* manejo de errores explícito (no silencioso)
