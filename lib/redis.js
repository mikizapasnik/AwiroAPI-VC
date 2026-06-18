/**
 * Minimalny klient Upstash Redis (REST API), bez SDK — żeby nie dociągać
 * zbędnych zależności do bundla serverless function.
 *
 * Wymaga zmiennych środowiskowych w Vercel:
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 */

const BASE_URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisCmd(...args) {
  if (!BASE_URL || !TOKEN) {
    throw new Error('Brak konfiguracji Upstash (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)');
  }
  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Upstash error ${res.status}: ${text}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(`Upstash error: ${data.error}`);
  return data.result;
}

/** Zapisuje wartość (JSON-serializowaną) z TTL w sekundach. */
async function setJSON(key, value, ttlSeconds) {
  const json = JSON.stringify(value);
  if (ttlSeconds) {
    return redisCmd('SET', key, json, 'EX', String(ttlSeconds));
  }
  return redisCmd('SET', key, json);
}

/** Odczytuje i parsuje JSON. Zwraca null, jeśli klucz nie istnieje. */
async function getJSON(key) {
  const raw = await redisCmd('GET', key);
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function del(key) {
  return redisCmd('DEL', key);
}

/** Dodaje element do listy (na początek) i utrzymuje limit długości. */
async function pushCapped(key, value, maxLen, ttlSeconds) {
  await redisCmd('LPUSH', key, JSON.stringify(value));
  await redisCmd('LTRIM', key, '0', String(maxLen - 1));
  if (ttlSeconds) await redisCmd('EXPIRE', key, String(ttlSeconds));
}

async function getList(key) {
  const items = await redisCmd('LRANGE', key, '0', '-1');
  if (!items) return [];
  return items.map((i) => {
    try {
      return JSON.parse(i);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

module.exports = { setJSON, getJSON, del, pushCapped, getList, redisCmd };
