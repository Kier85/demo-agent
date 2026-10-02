// Thin client for the Go GraphQL API.

export interface GraphQLError {
  message: string;
  extensions?: { code?: string };
}

export interface GraphQLResult<T> {
  data?: T;
  errors?: GraphQLError[];
}

export interface ShopConfig {
  url: string;
  apiToken?: string;
  adminToken?: string;
}

/** Transport is injectable so tests can run without a server. */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export class ShopClient {
  private cfg: ShopConfig;
  private transport: Transport;

  constructor(cfg: ShopConfig, transport: Transport = fetch) {
    this.cfg = cfg;
    this.transport = transport;
  }

  static fromEnv(transport?: Transport): ShopClient {
    return new ShopClient(
      {
        url: process.env.SHOP_API_URL ?? "http://localhost:8080",
        apiToken: process.env.SHOP_API_TOKEN || undefined,
        adminToken: process.env.SHOP_ADMIN_TOKEN || undefined,
      },
      transport,
    );
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.cfg.apiToken && { authorization: `Bearer ${this.cfg.apiToken}` }),
      ...extra,
    };
  }

  /** Runs a query as the given customer. */
  async query<T>(query: string, variables: Record<string, unknown>, opts: { customerEmail?: string; admin?: boolean } = {}): Promise<GraphQLResult<T>> {
    const extra: Record<string, string> = {};
    if (opts.customerEmail) extra["x-customer-email"] = opts.customerEmail;
    if (opts.admin && this.cfg.adminToken) extra["x-admin-token"] = this.cfg.adminToken;
    const res = await this.transport(`${this.cfg.url}/graphql`, {
      method: "POST",
      headers: this.headers(extra),
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok && res.status !== 422) {
      throw new Error(`shop api ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return (await res.json()) as GraphQLResult<T>;
  }

  async agentStatus(provider: string): Promise<{ enabled: boolean; reason: string; provider: string }> {
    const r = await this.query<{ agentStatus: { enabled: boolean; reason: string; provider: string } }>(
      `query($p: String!) { agentStatus(provider: $p) { provider enabled reason } }`,
      { p: provider },
    );
    if (!r.data) throw new Error(`agentStatus failed: ${r.errors?.[0]?.message}`);
    return r.data.agentStatus;
  }

  async setAgentStatus(provider: string, enabled: boolean, reason: string): Promise<void> {
    const r = await this.query(
      `mutation($p: String!, $e: Boolean!, $r: String!) { setAgentStatus(provider: $p, enabled: $e, reason: $r) { enabled } }`,
      { p: provider, e: enabled, r: reason },
      { admin: true },
    );
    if (r.errors?.length) throw new Error(`setAgentStatus failed: ${r.errors[0]!.message}`);
  }

  /** Reloads the seed data. Needs ALLOW_RESET=true and the admin token on the API. */
  async reset(): Promise<void> {
    const res = await this.transport(`${this.cfg.url}/admin/reset`, {
      method: "POST",
      headers: this.headers(this.cfg.adminToken ? { "x-admin-token": this.cfg.adminToken } : {}),
    });
    if (!res.ok) throw new Error(`reset failed: ${res.status} ${await res.text()}`);
  }
}
