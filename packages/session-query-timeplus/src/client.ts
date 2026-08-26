/**
 * Minimal Timeplus client seam: ingest + historical query over HTTP.
 * Kept as an interface so tests can fake it and so a driver-based
 * implementation (e.g. proton-driver) can replace HTTP later.
 */

export interface TimeplusClientOptions {
  readonly url: string
  readonly database: string
  readonly username?: string | undefined
  readonly password?: string | undefined
  /** Timeplus Enterprise/Cloud API key, sent as `X-Api-Key`. */
  readonly apiKey?: string | undefined
}

/** Named query parameters bound server-side (`{name:type}` placeholders in SQL). */
export type QueryParams = Readonly<Record<string, string | number>>

export interface TimeplusClient {
  /** Execute DDL or a statement with no result set. */
  execute(sql: string, signal?: AbortSignal): Promise<void>
  /** Historical query (table() scans); returns rows as JSON objects. */
  query<T>(sql: string, params?: QueryParams, signal?: AbortSignal): Promise<T[]>
  /**
   * Ingest rows into a stream as ONE batch (one HTTP request, one insert
   * block). Resolves once the server acknowledged the write, which on
   * Timeplus means the batch is committed to the stream's log. Visibility to
   * a subsequent `table()` query lags the ack (DESIGN.md §4.2); callers that
   * need read-your-writes poll their own watermark after this resolves.
   */
  ingest(stream: string, columns: readonly string[], rows: readonly unknown[][], signal?: AbortSignal): Promise<void>
  close(): Promise<void>
}

/** A non-2xx response from the Timeplus HTTP endpoint. */
export class TimeplusHttpError extends Error {
  constructor(readonly status: number, readonly body: string, statement: string) {
    super(`Timeplus HTTP ${status}: ${body.trim() || '(empty body)'} — while executing: ${summarize(statement)}`)
    this.name = 'TimeplusHttpError'
  }
}

function summarize(statement: string): string {
  const flat = statement.replace(/\s+/g, ' ').trim()
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat
}

/**
 * HTTP implementation against the ClickHouse-compatible endpoint (port 8123
 * on Proton). Every statement is POSTed (GET implies read-only); result sets
 * use `JSONEachRow` with 64-bit integers unquoted, so `seq`/`event_time`
 * (safe integers by contract) parse as numbers.
 */
export class HttpTimeplusClient implements TimeplusClient {
  private readonly base: URL
  private readonly headers: Record<string, string>

  constructor(private readonly options: TimeplusClientOptions) {
    this.base = new URL(options.url.endsWith('/') ? options.url : `${options.url}/`)
    this.headers = { 'content-type': 'text/plain; charset=utf-8' }
    if (options.username !== undefined) {
      const credentials = Buffer.from(`${options.username}:${options.password ?? ''}`, 'utf8').toString('base64')
      this.headers['authorization'] = `Basic ${credentials}`
    }
    if (options.apiKey !== undefined) this.headers['x-api-key'] = options.apiKey
  }

  async execute(sql: string, signal?: AbortSignal): Promise<void> {
    await this.post(this.endpoint(), sql, sql, signal)
  }

  async query<T>(sql: string, params: QueryParams = {}, signal?: AbortSignal): Promise<T[]> {
    const url = this.endpoint({
      default_format: 'JSONEachRow',
      output_format_json_quote_64bit_integers: '0',
    })
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(`param_${name}`, String(value))
    }
    const text = await this.post(url, sql, sql, signal)
    const rows: T[] = []
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      rows.push(JSON.parse(line) as T)
    }
    return rows
  }

  async ingest(
    stream: string,
    columns: readonly string[],
    rows: readonly unknown[][],
    signal?: AbortSignal,
  ): Promise<void> {
    if (rows.length === 0) return
    const statement = `INSERT INTO ${stream} (${columns.join(', ')}) FORMAT JSONCompactEachRow`
    const url = this.endpoint({ query: statement })
    let body = ''
    for (const row of rows) body += `${JSON.stringify(row)}\n`
    await this.post(url, body, statement, signal)
  }

  async close(): Promise<void> {}

  private endpoint(search: Record<string, string> = {}): URL {
    const url = new URL(this.base)
    url.searchParams.set('database', this.options.database)
    for (const [key, value] of Object.entries(search)) url.searchParams.set(key, value)
    return url
  }

  private async post(url: URL, body: string, statement: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body,
      ...signal === undefined ? {} : { signal },
    })
    const text = await response.text()
    if (!response.ok) throw new TimeplusHttpError(response.status, text, statement)
    return text
  }
}
