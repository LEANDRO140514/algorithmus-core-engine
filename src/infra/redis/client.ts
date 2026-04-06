import { createClient } from "redis";

let client: ReturnType<typeof createClient> | null = null;
let connecting: Promise<ReturnType<typeof createClient>> | undefined;

function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (typeof url !== "string" || !url.trim()) {
    throw new Error(
      "[redis] REDIS_URL no está definida o está vacía en el entorno.",
    );
  }
  return url.trim();
}

/**
 * Cliente Redis singleton (lazy connect). Namespacing por tenant en capas superiores.
 */
export async function getRedis(): Promise<ReturnType<typeof createClient>> {
  if (client?.isOpen) return client;
  if (connecting) return connecting;

  connecting = (async () => {
    const c = createClient({ url: requireRedisUrl() });
    c.on("error", (err) => {
      console.error("[redis] error de cliente", err);
    });
    await c.connect();
    client = c;
    return c;
  })();

  try {
    return await connecting;
  } finally {
    connecting = undefined;
  }
}
