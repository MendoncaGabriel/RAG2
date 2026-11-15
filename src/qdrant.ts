// Cliente mínimo da API REST oficial do Qdrant (testado com a v1.19). Sem SDK: fetch nativo (undici) já reaproveita conexões.
import { config } from "./config.js";

export class QdrantError extends Error { constructor(message: string, readonly unavailable = false) { super(message); } }
// Causa legível de uma falha de rede do fetch (undici): ECONNREFUSED, ENOTFOUND, timeout…
export const networkCause = (e: any): string => e?.cause?.code || e?.cause?.errors?.[0]?.code || (e?.name === "TimeoutError" ? "tempo esgotado" : "") || e?.cause?.message || e?.message || String(e);
export const DENSE = "dense", SPARSE = "bm25";

async function call<T = any>(method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, opts: { timeout?: number; allow404?: boolean } = {}): Promise<T> {
  const { url, apiKey, timeoutMs } = config.qdrant;
  let res: Response;
  try {
    res = await fetch(`${url}${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(opts.timeout ?? timeoutMs),
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(apiKey ? { "api-key": apiKey } : {}) },
    });
  } catch (e: any) {
    throw new QdrantError(`Banco vetorial (Qdrant) indisponível em ${url} (${networkCause(e)}). Verifique o serviço com "docker compose ps qdrant".`, true);
  }
  if (res.status === 404 && opts.allow404) return null as T;
  const text = await res.text();
  if (!res.ok) throw new QdrantError(`Qdrant ${res.status} em ${method} ${path}: ${text.slice(0, 300)}`, res.status >= 502);
  return (text ? JSON.parse(text).result : null) as T;
}
const col = (name = config.qdrant.collection) => `/collections/${encodeURIComponent(name)}`;

export async function ready(): Promise<boolean> {
  try { const r = await fetch(`${config.qdrant.url}/readyz`, { signal: AbortSignal.timeout(3_000) }); return r.ok; } catch { return false; }
}
export async function version(): Promise<string | null> {
  try { return (await (await fetch(`${config.qdrant.url}/`, { headers: config.qdrant.apiKey ? { "api-key": config.qdrant.apiKey } : {}, signal: AbortSignal.timeout(3_000) })).json() as any).version ?? null; } catch { return null; }
}

// ---------- Collection ----------
export type CollectionInfo = { status: string; points_count: number; indexed_vectors_count?: number; segments_count?: number; config: any; payload_schema: Record<string, any> };
export const getCollection = (name?: string) => call<CollectionInfo | null>("GET", col(name), undefined, { allow404: true });
export const denseSize = (info: CollectionInfo | null): number | null => info?.config?.params?.vectors?.[DENSE]?.size ?? null;
export const deleteCollection = (name?: string) => call("DELETE", col(name), undefined, { timeout: 120_000 });

// Campos de payload com índice: notebook_id é o "tenant" (toda busca filtra por ele).
export const PAYLOAD_INDEXES: [string, unknown][] = [
  ["notebook_id", { type: "keyword", is_tenant: true }],
  ["document_id", "keyword"],
  ["source_type", "keyword"],
  ["codes", "keyword"],
  ["chunk_index", "integer"],
  ["toc", "bool"],
];

// Quantização configurada (QDRANT_QUANTIZATION): INT8 escalar ou binária de 1/2 bits, na RAM ou em disco.
export function quantizationConfig() {
  const q = config.qdrant, always_ram = q.quantizedInRam;
  if (q.quantization === "int8") return { scalar: { type: "int8", quantile: q.quantile, always_ram } };
  return { binary: { always_ram, encoding: q.quantization === "binary2" ? "two_bits" : "one_bit" } };
}
const sparseConfig = () => ({ modifier: "idf", index: { on_disk: config.qdrant.sparseOnDisk } });

export async function createCollection(dims: number, name?: string) {
  const q = config.qdrant;
  await call("PUT", col(name), {
    vectors: { [DENSE]: { size: dims, distance: "Cosine", on_disk: q.onDiskVectors } },
    // Vetor esparso BM25: o Qdrant calcula o IDF sobre a collection (modifier "idf"); índice invertido em disco por padrão.
    sparse_vectors: { [SPARSE]: sparseConfig() },
    // Multitenancy: toda busca é dentro de um notebook; sem grafo global (m: 0), um grafo HNSW por notebook (payload_m).
    hnsw_config: { m: 0, payload_m: 16 },
    // Quantizados na RAM (INT8: 4x menor que float32; binária: 16–32x); originais no disco para o rescore preservar a precisão.
    quantization_config: quantizationConfig(),
    on_disk_payload: true,
  }, { timeout: 60_000 });
  for (const [field_name, field_schema] of PAYLOAD_INDEXES) await call("PUT", `${col(name)}/index?wait=true`, { field_name, field_schema }, { timeout: 60_000 });
}

// Collection já existente criada com outra configuração (versão anterior ou variável trocada): aplica a quantização e o
// índice esparso configurados sem recriar (o Qdrant reconstrói em segundo plano; a busca continua funcionando).
export async function syncCollectionConfig(info: CollectionInfo, name?: string): Promise<string[]> {
  const changes: string[] = [], patch: Record<string, unknown> = {};
  const want = quantizationConfig(), have = info.config?.quantization_config ?? null;
  const same = (a: any, b: any): boolean => !!a && !!b && Object.keys(b).every(k => typeof b[k] === "object" ? same(a[k], b[k]) : a[k] === b[k]);
  if (!same(have, want)) { patch.quantization_config = want; changes.push(`quantização ${config.qdrant.quantization}${config.qdrant.quantizedInRam ? "" : " (em disco)"}`); }
  const sparseOnDisk = !!info.config?.params?.sparse_vectors?.[SPARSE]?.index?.on_disk;
  if (sparseOnDisk !== config.qdrant.sparseOnDisk) { patch.sparse_vectors = { [SPARSE]: { index: { on_disk: config.qdrant.sparseOnDisk } } }; changes.push(`índice BM25 ${config.qdrant.sparseOnDisk ? "em disco" : "na RAM"}`); }
  if (changes.length) await call("PATCH", col(name), patch, { timeout: 120_000 });
  return changes;
}

// ---------- Pontos ----------
export type Point = { id: string; vector: Record<string, number[] | { indices: number[]; values: number[] }>; payload: Record<string, unknown> };
export const upsert = (points: Point[], name?: string) => call("PUT", `${col(name)}/points?wait=true`, { points }, { timeout: 120_000 });
// Atualiza só os vetores informados (ex.: o denso), mantendo os demais e o payload do ponto.
export const updateVectors = (points: { id: string; vector: Record<string, number[]> }[], name?: string) => call("PUT", `${col(name)}/points/vectors?wait=true`, { points }, { timeout: 120_000 });
export const deleteByFilter = (filter: unknown, name?: string) => call("POST", `${col(name)}/points/delete?wait=true`, { filter }, { timeout: 120_000 });
export const deleteIds = (ids: string[], name?: string) => ids.length ? call("POST", `${col(name)}/points/delete?wait=true`, { points: ids }) : Promise.resolve(null);
export const retrieve = (ids: string[], name?: string) => call<{ id: string; payload?: any }[]>("POST", `${col(name)}/points`, { ids, with_payload: false, with_vector: false });
export const count = (filter: unknown, name?: string) => call<{ count: number }>("POST", `${col(name)}/points/count`, { filter, exact: true }).then(r => r.count);
export const facet = (key: string, filter: unknown, limit: number, name?: string) =>
  call<{ hits: { value: string; count: number }[] }>("POST", `${col(name)}/facet`, { key, filter, limit, exact: true }, { timeout: 120_000 }).then(r => r.hits);
export const scroll = (filter: unknown, limit: number, offset?: string | null, name?: string) =>
  call<{ points: { id: string; payload?: any }[]; next_page_offset: string | null }>("POST", `${col(name)}/points/scroll`, { filter, limit, offset: offset ?? undefined, with_payload: true, with_vector: false });

// ---------- Busca ----------
export type ScoredPoint = { id: string; score: number; payload?: any };
export const queryBatch = (searches: unknown[], name?: string) =>
  call<{ points: ScoredPoint[] }[]>("POST", `${col(name)}/points/query/batch`, { searches }).then(r => r.map(x => x.points));
// Parâmetros da busca densa: HNSW ef e rescore com os vetores originais após a pré-seleção quantizada.
export const searchParams = () => ({ hnsw_ef: config.qdrant.hnswEf, quantization: { rescore: true, oversampling: config.qdrant.oversampling } });
