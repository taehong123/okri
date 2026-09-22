import { env } from "cloudflare:workers";

type ClientRow = {
  id: string;
  owner_id: string;
  external_customer_id: string | null;
  name: string;
  phone: string;
  email: string;
  source_type: string;
  source_name: string | null;
  source_url: string | null;
  source_updated_at: string;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
};

type ClientProductRow = {
  id: string;
  owner_id: string;
  client_id: string;
  external_product_id: string | null;
  name: string;
  source: string;
  created_at: string;
  updated_at: string;
};

type TicketClientRow = {
  ticket_id: string;
  client_id: string;
  product_id: string | null;
};

type ReceiptRow = { request_hash: string; response_json: string };

export type ClientProductInput = {
  id?: string;
  externalProductId?: string | null;
  name: string;
};

export type ClientInput = {
  name: string;
  phone?: string;
  email?: string;
  externalCustomerId?: string | null;
  products?: ClientProductInput[];
};

export type ClientProductRecord = {
  id: string;
  clientId: string;
  externalProductId: string | null;
  name: string;
  source: "manual" | "integration";
  createdAt: string;
  updatedAt: string;
};

export type ClientRecord = {
  id: string;
  externalCustomerId: string | null;
  name: string;
  phone: string;
  email: string;
  sourceType: "manual" | "api";
  sourceName: string | null;
  sourceUrl: string | null;
  sourceUpdatedAt: string;
  products: ClientProductRecord[];
  createdAt: string;
  updatedAt: string;
};

export type TicketClientLink = {
  ticketId: string;
  clientId: string;
  productIds: string[];
  client: ClientRecord;
};

export type ExternalClientInput = {
  externalCustomerId: string;
  name: string;
  phone?: string;
  email?: string;
  products?: Array<{ externalProductId?: string | null; name: string }>;
};

export type IntegrationClientSource = {
  name: string;
  url?: string | null;
};

export class ClientDirectoryError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

function db() {
  return env.DB;
}

function clean(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function strictText(value: unknown, max: number, code: string, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new ClientDirectoryError(code, "필수 입력값을 확인해 주세요.");
    return "";
  }
  if (typeof value !== "string") throw new ClientDirectoryError(code, "입력값 형식을 확인해 주세요.");
  const normalized = value.trim().normalize("NFC");
  if ((required && !normalized) || normalized.length > max || hasControlCharacters(normalized)) {
    throw new ClientDirectoryError(code, "입력값 길이 또는 형식을 확인해 주세요.");
  }
  return normalized;
}

function hasControlCharacters(value: string) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function normalizeSourceUrl(value: unknown) {
  const sourceUrl = strictText(value, 2048, "source_url_invalid");
  if (!sourceUrl) return null;
  let parsed: URL;
  try { parsed = new URL(sourceUrl); } catch { throw new ClientDirectoryError("source_url_invalid", "출처 URL은 공개 HTTPS 주소여야 합니다."); }
  const hostname = parsed.hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "");
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
  const privateIpv4 = ipv4 && (ipv4.some((part) => part > 255)
    || ipv4[0] === 0 || ipv4[0] === 10 || ipv4[0] === 127 || ipv4[0] >= 224
    || (ipv4[0] === 169 && ipv4[1] === 254)
    || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)
    || (ipv4[0] === 192 && ipv4[1] === 168));
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !hostname.includes(".") || hostname.includes(":")
    || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || privateIpv4) {
    throw new ClientDirectoryError("source_url_invalid", "출처 URL은 공개 HTTPS 주소여야 합니다.");
  }
  parsed.hash = "";
  return parsed.toString();
}

function normalizeContact(input: ClientInput) {
  const name = clean(input.name, 200);
  const phone = clean(input.phone, 80);
  const email = clean(input.email, 254).toLocaleLowerCase();
  const externalCustomerId = clean(input.externalCustomerId, 200) || null;
  if (!name) throw new ClientDirectoryError("client_name_required", "고객명을 입력해 주세요.");
  if (email && (!email.includes("@") || email.startsWith("@") || email.endsWith("@"))) {
    throw new ClientDirectoryError("client_email_invalid", "이메일 형식을 확인해 주세요.");
  }
  return { name, phone, email, externalCustomerId };
}

function normalizeProducts(products: ClientProductInput[] | undefined, limit = 100) {
  if (products === undefined) return undefined;
  if (products.length > limit) throw new ClientDirectoryError("too_many_products", `제품은 한 고객당 ${limit}개까지 저장할 수 있습니다.`);
  const names = new Set<string>();
  const externalIds = new Set<string>();
  return products.map((product) => {
    const id = clean(product.id, 100) || undefined;
    const externalProductId = clean(product.externalProductId, 200) || null;
    const name = clean(product.name, 200);
    if (!name) throw new ClientDirectoryError("product_name_required", "제품명을 입력해 주세요.");
    const nameKey = name.toLocaleLowerCase();
    if (names.has(nameKey)) throw new ClientDirectoryError("duplicate_product_name", `제품명 '${name}'이 중복되었습니다.`);
    names.add(nameKey);
    if (externalProductId) {
      if (externalIds.has(externalProductId)) throw new ClientDirectoryError("duplicate_external_product_id", `외부 제품 ID '${externalProductId}'가 중복되었습니다.`);
      externalIds.add(externalProductId);
    }
    return { id, externalProductId, name };
  });
}

function serializeProduct(row: ClientProductRow): ClientProductRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    externalProductId: row.external_product_id,
    name: row.name,
    source: row.source === "integration" ? "integration" : "manual",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeClient(row: ClientRow, products: ClientProductRow[]): ClientRecord {
  return {
    id: row.id,
    externalCustomerId: row.external_customer_id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    sourceType: row.source_type === "api" ? "api" : "manual",
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    sourceUpdatedAt: row.source_updated_at,
    products: products.filter((product) => product.client_id === row.id).map(serializeProduct),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readProducts(ownerId: string, clientIds?: string[]) {
  if (clientIds && !clientIds.length) return [];
  const filter = clientIds
    ? `AND client_id IN (${clientIds.map(() => "?").join(",")})`
    : "";
  const result = await db().prepare(`SELECT * FROM client_products WHERE owner_id = ? ${filter} ORDER BY name COLLATE NOCASE, id`)
    .bind(ownerId, ...(clientIds ?? [])).all<ClientProductRow>();
  return result.results;
}

async function readClientsByIds(ownerId: string, clientIds: string[]) {
  const ids = [...new Set(clientIds)];
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = await db().prepare(`SELECT * FROM clients WHERE owner_id = ? AND id IN (${placeholders})`)
    .bind(ownerId, ...ids).all<ClientRow>();
  const products = await readProducts(ownerId, ids);
  return rows.results.map((row) => serializeClient(row, products));
}

export async function listClients(ownerId: string, query?: string, limit = 500): Promise<ClientRecord[]> {
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const search = clean(query, 200);
  const pattern = `%${search.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const rows = search
    ? await db().prepare(`SELECT * FROM clients WHERE owner_id = ? AND
        (name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR external_customer_id LIKE ? ESCAPE '\\')
        ORDER BY name COLLATE NOCASE, id LIMIT ?`).bind(ownerId, pattern, pattern, pattern, pattern, boundedLimit).all<ClientRow>()
    : await db().prepare("SELECT * FROM clients WHERE owner_id = ? ORDER BY name COLLATE NOCASE, id LIMIT ?")
      .bind(ownerId, boundedLimit).all<ClientRow>();
  const products = await readProducts(ownerId, rows.results.map((row) => row.id));
  return rows.results.map((row) => serializeClient(row, products));
}

export async function getClient(ownerId: string, clientId: string): Promise<ClientRecord | null> {
  const row = await db().prepare("SELECT * FROM clients WHERE owner_id = ? AND id = ?")
    .bind(ownerId, clientId).first<ClientRow>();
  if (!row) return null;
  return serializeClient(row, await readProducts(ownerId, [row.id]));
}

export async function createClient(ownerId: string, userId: string, input: ClientInput) {
  const contact = normalizeContact(input);
  const products = normalizeProducts(input.products) ?? [];
  const clientId = crypto.randomUUID();
  const now = new Date().toISOString();
  const statements = [
    db().prepare(`INSERT INTO clients
      (id, owner_id, external_customer_id, name, phone, email, source_type, source_updated_at, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`)
      .bind(clientId, ownerId, contact.externalCustomerId, contact.name, contact.phone, contact.email, now, userId, now, now),
    ...products.map((product) => db().prepare(`INSERT INTO client_products
      (id, owner_id, client_id, external_product_id, name, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)`)
      .bind(crypto.randomUUID(), ownerId, clientId, product.externalProductId, product.name, now, now)),
  ];
  try {
    await db().batch(statements);
  } catch (error) {
    throw mapConstraint(error);
  }
  return await getClient(ownerId, clientId) as ClientRecord;
}

export async function updateClient(ownerId: string, clientId: string, input: Partial<ClientInput>) {
  const current = await getClient(ownerId, clientId);
  if (!current) throw new ClientDirectoryError("client_not_found", "클라이언트를 찾을 수 없습니다.", 404);
  const contact = normalizeContact({
    name: input.name ?? current.name,
    phone: input.phone ?? current.phone,
    email: input.email ?? current.email,
    externalCustomerId: current.externalCustomerId,
  });
  const products = normalizeProducts(input.products);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    db().prepare(`UPDATE clients SET name = ?, phone = ?, email = ?, source_type = 'manual', source_name = NULL,
      source_url = NULL, source_updated_at = ?, updated_at = ? WHERE owner_id = ? AND id = ?`)
      .bind(contact.name, contact.phone, contact.email, now, now, ownerId, clientId),
  ];
  if (products) {
    const currentById = new Map(current.products.map((product) => [product.id, product]));
    for (const product of products) {
      if (product.id && !currentById.has(product.id)) throw new ClientDirectoryError("product_not_found", "이 클라이언트의 제품이 아닙니다.");
    }
    const retainedIds = new Set(products.flatMap((product) => product.id ? [product.id] : []));
    for (const product of current.products) {
      if (!retainedIds.has(product.id)) statements.push(db().prepare("DELETE FROM client_products WHERE owner_id = ? AND client_id = ? AND id = ?").bind(ownerId, clientId, product.id));
    }
    for (const product of products) {
      if (product.id) statements.push(db().prepare("UPDATE client_products SET name = ?, updated_at = ? WHERE owner_id = ? AND client_id = ? AND id = ?")
        .bind(`__okri_tmp_${crypto.randomUUID()}`, now, ownerId, clientId, product.id));
    }
    for (const product of products) {
      if (product.id) {
        statements.push(db().prepare("UPDATE client_products SET name = ?, updated_at = ? WHERE owner_id = ? AND client_id = ? AND id = ?")
          .bind(product.name, now, ownerId, clientId, product.id));
      } else {
        statements.push(db().prepare(`INSERT INTO client_products
          (id, owner_id, client_id, external_product_id, name, source, created_at, updated_at)
          VALUES (?, ?, ?, NULL, ?, 'manual', ?, ?)`)
          .bind(crypto.randomUUID(), ownerId, clientId, product.name, now, now));
      }
    }
  }
  try {
    await db().batch(statements);
  } catch (error) {
    throw mapConstraint(error);
  }
  return await getClient(ownerId, clientId) as ClientRecord;
}

export async function deleteClient(ownerId: string, clientId: string) {
  const result = await db().prepare("DELETE FROM clients WHERE owner_id = ? AND id = ?").bind(ownerId, clientId).run();
  if (!result.meta.changes) throw new ClientDirectoryError("client_not_found", "클라이언트를 찾을 수 없습니다.", 404);
  return { deleted: true, id: clientId };
}

export async function listTicketClientLinks(ownerId: string, ticketId?: string): Promise<TicketClientLink[]> {
  const rows = ticketId
    ? await db().prepare(`SELECT tc.ticket_id, tc.client_id, tcp.product_id FROM ticket_clients tc
        LEFT JOIN ticket_client_products tcp ON tcp.owner_id = tc.owner_id AND tcp.ticket_id = tc.ticket_id
        WHERE tc.owner_id = ? AND tc.ticket_id = ? ORDER BY tcp.created_at, tcp.id`).bind(ownerId, ticketId).all<TicketClientRow>()
    : await db().prepare(`SELECT tc.ticket_id, tc.client_id, tcp.product_id FROM ticket_clients tc
        LEFT JOIN ticket_client_products tcp ON tcp.owner_id = tc.owner_id AND tcp.ticket_id = tc.ticket_id
        WHERE tc.owner_id = ? ORDER BY tc.ticket_id, tcp.created_at, tcp.id`).bind(ownerId).all<TicketClientRow>();
  const clients = await readClientsByIds(ownerId, rows.results.map((row) => row.client_id));
  const clientMap = new Map(clients.map((client) => [client.id, client]));
  const grouped = new Map<string, TicketClientLink>();
  for (const row of rows.results) {
    const client = clientMap.get(row.client_id);
    if (!client) continue;
    const link = grouped.get(row.ticket_id) ?? { ticketId: row.ticket_id, clientId: row.client_id, productIds: [], client };
    if (row.product_id) link.productIds.push(row.product_id);
    grouped.set(row.ticket_id, link);
  }
  return [...grouped.values()];
}

export async function setTicketClientLink(ownerId: string, ticketId: string, clientId: string | null, productIds: string[]) {
  const ticket = await db().prepare("SELECT id FROM items WHERE owner_id = ? AND id = ? AND kind = 'ticket' AND archived_at IS NULL")
    .bind(ownerId, ticketId).first<{ id: string }>();
  if (!ticket) throw new ClientDirectoryError("ticket_not_found", "활성 Ticket을 찾을 수 없습니다.", 404);
  const uniqueProductIds = [...new Set(productIds.map((id) => clean(id, 100)).filter(Boolean))];
  const statements: D1PreparedStatement[] = [
    db().prepare("DELETE FROM ticket_client_products WHERE owner_id = ? AND ticket_id = ?").bind(ownerId, ticketId),
  ];
  if (!clientId) {
    if (uniqueProductIds.length) throw new ClientDirectoryError("client_required", "제품을 연결하려면 클라이언트를 먼저 선택해 주세요.");
    statements.push(db().prepare("DELETE FROM ticket_clients WHERE owner_id = ? AND ticket_id = ?").bind(ownerId, ticketId));
    await db().batch(statements);
    return null;
  }
  const client = await getClient(ownerId, clientId);
  if (!client) throw new ClientDirectoryError("client_not_found", "클라이언트를 찾을 수 없습니다.", 404);
  const allowedProductIds = new Set(client.products.map((product) => product.id));
  if (uniqueProductIds.some((id) => !allowedProductIds.has(id))) {
    throw new ClientDirectoryError("product_client_mismatch", "선택한 제품이 이 클라이언트에 속하지 않습니다.");
  }
  const now = new Date().toISOString();
  statements.push(db().prepare(`INSERT INTO ticket_clients (id, owner_id, ticket_id, client_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, ticket_id) DO UPDATE SET client_id = excluded.client_id, updated_at = excluded.updated_at`)
    .bind(crypto.randomUUID(), ownerId, ticketId, clientId, now, now));
  statements.push(...uniqueProductIds.map((productId) => db().prepare(`INSERT INTO ticket_client_products
    (id, owner_id, ticket_id, product_id, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), ownerId, ticketId, productId, now)));
  await db().batch(statements);
  return (await listTicketClientLinks(ownerId, ticketId))[0] ?? null;
}

function normalizeExternalClients(input: ExternalClientInput[]) {
  if (!input.length || input.length > 50) throw new ClientDirectoryError("invalid_client_count", "클라이언트는 한 요청에 1개부터 50개까지 보낼 수 있습니다.");
  const seen = new Set<string>();
  let totalProducts = 0;
  return input.map((client) => {
    const externalCustomerId = strictText(client.externalCustomerId, 200, "external_customer_id_invalid", true);
    const name = strictText(client.name, 200, "client_name_invalid", true);
    const phone = strictText(client.phone, 80, "client_phone_invalid");
    const email = strictText(client.email, 254, "client_email_invalid").toLocaleLowerCase();
    if (email && (!email.includes("@") || email.startsWith("@") || email.endsWith("@"))) {
      throw new ClientDirectoryError("client_email_invalid", "이메일 형식을 확인해 주세요.");
    }
    if (seen.has(externalCustomerId)) throw new ClientDirectoryError("duplicate_external_customer_id", "요청에 중복된 외부 고객 ID가 있습니다.");
    seen.add(externalCustomerId);
    const rawProducts = client.products ?? [];
    if (rawProducts.length > 100) throw new ClientDirectoryError("too_many_products", "제품은 한 고객당 100개까지 보낼 수 있습니다.");
    totalProducts += rawProducts.length;
    if (totalProducts > 500) throw new ClientDirectoryError("too_many_products", "제품은 한 요청에 500개까지 보낼 수 있습니다.");
    const names = new Set<string>();
    const externalIds = new Set<string>();
    const products = rawProducts.map((product) => {
      const externalProductId = strictText(product.externalProductId, 200, "external_product_id_invalid") || null;
      const productName = strictText(product.name, 200, "product_name_invalid", true);
      const nameKey = productName.toLocaleLowerCase();
      if (names.has(nameKey)) throw new ClientDirectoryError("duplicate_product_name", "요청에 중복된 제품명이 있습니다.");
      if (externalProductId && externalIds.has(externalProductId)) throw new ClientDirectoryError("duplicate_external_product_id", "요청에 중복된 외부 제품 ID가 있습니다.");
      names.add(nameKey);
      if (externalProductId) externalIds.add(externalProductId);
      return { externalProductId, name: productName };
    });
    return { externalCustomerId, name, phone, email, products };
  });
}

function normalizeIntegrationSource(source: IntegrationClientSource) {
  return {
    name: strictText(source.name, 100, "source_name_invalid", true),
    url: normalizeSourceUrl(source.url),
  };
}

async function prepareExternalClient(
  ownerId: string,
  userId: string,
  input: ReturnType<typeof normalizeExternalClients>[number],
  source: ReturnType<typeof normalizeIntegrationSource>,
  replaceProducts: boolean,
  now: string,
) {
  const row = await db().prepare("SELECT * FROM clients WHERE owner_id = ? AND external_customer_id = ?")
    .bind(ownerId, input.externalCustomerId).first<ClientRow>();
  const clientId = row?.id ?? crypto.randomUUID();
  const existing = row ? await readProducts(ownerId, [clientId]) : [];
  const statements: D1PreparedStatement[] = [row
    ? db().prepare(`UPDATE clients SET name = ?, phone = ?, email = ?, source_type = 'api', source_name = ?,
        source_url = ?, source_updated_at = ?, updated_at = ? WHERE owner_id = ? AND id = ?`)
      .bind(input.name, input.phone, input.email, source.name, source.url, now, now, ownerId, clientId)
    : db().prepare(`INSERT INTO clients
      (id, owner_id, external_customer_id, name, phone, email, source_type, source_name, source_url, source_updated_at,
       created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'api', ?, ?, ?, ?, ?, ?)`)
      .bind(clientId, ownerId, input.externalCustomerId, input.name, input.phone, input.email, source.name, source.url, now, userId, now, now),
  ];
  const byExternal = new Map(existing.filter((product) => product.external_product_id).map((product) => [product.external_product_id as string, product]));
  const byName = new Map(existing.filter((product) => product.source === "integration").map((product) => [product.name.toLocaleLowerCase(), product]));
  const matched = new Set<string>();
  const prepared = input.products.map((product) => {
    const current = product.externalProductId ? byExternal.get(product.externalProductId) : byName.get(product.name.toLocaleLowerCase());
    if (current && matched.has(current.id)) throw new ClientDirectoryError("duplicate_product_match", "제품 연결이 중복됩니다.");
    if (current) matched.add(current.id);
    return { ...product, current, id: current?.id ?? crypto.randomUUID() };
  });
  const retained = existing.filter((product) => !matched.has(product.id) && !(replaceProducts && product.source === "integration"));
  if (replaceProducts) {
    for (const product of existing) {
      if (product.source === "integration" && !matched.has(product.id)) {
        statements.push(db().prepare("DELETE FROM client_products WHERE owner_id = ? AND client_id = ? AND id = ?").bind(ownerId, clientId, product.id));
      }
    }
  }
  for (const product of prepared) {
    if (product.current) statements.push(db().prepare("UPDATE client_products SET name = ?, updated_at = ? WHERE owner_id = ? AND client_id = ? AND id = ?")
      .bind(`__okri_tmp_${crypto.randomUUID()}`, now, ownerId, clientId, product.current.id));
  }
  for (const product of prepared) {
    if (product.current) {
      statements.push(db().prepare("UPDATE client_products SET external_product_id = ?, name = ?, source = 'integration', updated_at = ? WHERE owner_id = ? AND client_id = ? AND id = ?")
        .bind(product.externalProductId, product.name, now, ownerId, clientId, product.current.id));
    } else {
      statements.push(db().prepare(`INSERT INTO client_products
        (id, owner_id, client_id, external_product_id, name, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'integration', ?, ?)`)
        .bind(product.id, ownerId, clientId, product.externalProductId, product.name, now, now));
    }
  }
  const products = [
    ...retained.map(serializeProduct),
    ...prepared.map((product): ClientProductRecord => ({
      id: product.id,
      clientId,
      externalProductId: product.externalProductId,
      name: product.name,
      source: "integration",
      createdAt: product.current?.created_at ?? now,
      updatedAt: now,
    })),
  ].sort((left, right) => left.name.localeCompare(right.name));
  const record: ClientRecord = {
    id: clientId,
    externalCustomerId: input.externalCustomerId,
    name: input.name,
    phone: input.phone,
    email: input.email,
    sourceType: "api",
    sourceName: source.name,
    sourceUrl: source.url,
    sourceUpdatedAt: now,
    products,
    createdAt: row?.created_at ?? now,
    updatedAt: now,
  };
  return { statements, record };
}

async function hashPayload(value: unknown) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function upsertClientsFromIntegration(
  ownerId: string,
  userId: string,
  clients: ExternalClientInput[],
  idempotencyKey: string,
  replaceProducts = true,
  sourceInput: IntegrationClientSource = { name: "외부 시스템" },
) {
  const key = strictText(idempotencyKey, 128, "idempotency_key_invalid", true);
  const normalized = normalizeExternalClients(clients);
  const source = normalizeIntegrationSource(sourceInput);
  const requestHash = await hashPayload({ clients: normalized, replaceProducts, source });
  const receipt = await db().prepare("SELECT request_hash, response_json FROM integration_client_upserts WHERE owner_id = ? AND idempotency_key = ?")
    .bind(ownerId, key).first<ReceiptRow>();
  if (receipt) {
    if (receipt.request_hash !== requestHash) throw new ClientDirectoryError("idempotency_key_conflict", "같은 Idempotency-Key를 다른 요청에 사용할 수 없습니다.", 409);
    return { ...JSON.parse(receipt.response_json) as { clients: ClientRecord[]; count: number }, replayed: true };
  }
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  const saved: ClientRecord[] = [];
  for (const client of normalized) {
    const prepared = await prepareExternalClient(ownerId, userId, client, source, replaceProducts, now);
    statements.push(...prepared.statements);
    saved.push(prepared.record);
  }
  const response = { clients: saved, count: saved.length };
  statements.push(db().prepare(`INSERT INTO integration_client_upserts
    (id, owner_id, idempotency_key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), ownerId, key, requestHash, JSON.stringify(response), now));
  try {
    await db().batch(statements);
  } catch (error) {
    const raced = await db().prepare("SELECT request_hash, response_json FROM integration_client_upserts WHERE owner_id = ? AND idempotency_key = ?")
      .bind(ownerId, key).first<ReceiptRow>();
    if (!raced || raced.request_hash !== requestHash) throw mapConstraint(error);
    return { ...JSON.parse(raced.response_json) as { clients: ClientRecord[]; count: number }, replayed: true };
  }
  return { ...response, replayed: false };
}

export async function reserveClientIntegrationRequest(ownerId: string, fingerprint: string, now = new Date()) {
  const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
  const updatedAt = now.toISOString();
  const buckets = [
    { key: "workspace", limit: 60 },
    { key: `ip:${strictText(fingerprint, 80, "request_fingerprint_invalid", true)}`, limit: 30 },
  ];
  for (const bucket of buckets) {
    const row = await db().prepare(`INSERT INTO integration_client_rate_limits
      (id, owner_id, bucket_key, window_start, request_count, updated_at) VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(owner_id, bucket_key, window_start) DO UPDATE SET
        request_count = request_count + 1, updated_at = excluded.updated_at
      RETURNING request_count`)
      .bind(crypto.randomUUID(), ownerId, bucket.key, windowStart, updatedAt).first<{ request_count: number }>();
    if (Number(row?.request_count ?? 1) > bucket.limit) {
      throw new ClientDirectoryError("rate_limited", "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", 429);
    }
  }
}

function mapConstraint(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/idx_clients_owner_external|clients\.owner_id, clients\.external_customer_id/i.test(message)) {
    return new ClientDirectoryError("external_customer_id_conflict", "이 외부 고객 ID는 이미 사용 중입니다.", 409);
  }
  if (/idx_client_products_client_name|client_products\.client_id, client_products\.name/i.test(message)) {
    return new ClientDirectoryError("product_name_conflict", "같은 클라이언트에 동일한 제품명을 두 번 저장할 수 없습니다.", 409);
  }
  if (/idx_client_products_client_external|client_products\.client_id, client_products\.external_product_id/i.test(message)) {
    return new ClientDirectoryError("external_product_id_conflict", "이 외부 제품 ID는 이미 사용 중입니다.", 409);
  }
  return error instanceof ClientDirectoryError ? error : new ClientDirectoryError("client_save_failed", "클라이언트 정보를 저장하지 못했습니다.", 500);
}
