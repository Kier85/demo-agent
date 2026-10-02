-- Idempotent schema; applied on every API start.

CREATE TABLE IF NOT EXISTS customers (
    id         TEXT PRIMARY KEY,
    email      TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
    id               TEXT PRIMARY KEY,
    customer_id      TEXT NOT NULL REFERENCES customers(id),
    status           TEXT NOT NULL CHECK (status IN
                       ('RECEIVED','PROOF_PENDING','IN_PRODUCTION','SHIPPED','DELIVERED','CANCELLED')),
    created_at       TIMESTAMPTZ NOT NULL,
    currency         TEXT NOT NULL DEFAULT 'USD',
    ship_name        TEXT NOT NULL,
    ship_line1       TEXT NOT NULL,
    ship_line2       TEXT,
    ship_city        TEXT NOT NULL,
    ship_region      TEXT,
    ship_postal_code TEXT NOT NULL,
    ship_country     TEXT NOT NULL,
    reorder_of       TEXT REFERENCES orders(id),
    idempotency_key  TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders(customer_id);

CREATE TABLE IF NOT EXISTS order_items (
    order_id         TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    line_no          INT  NOT NULL,
    sku              TEXT NOT NULL,
    product          TEXT NOT NULL,
    size             TEXT NOT NULL,
    quantity         INT  NOT NULL CHECK (quantity > 0),
    unit_price_cents INT  NOT NULL CHECK (unit_price_cents >= 0),
    PRIMARY KEY (order_id, line_no)
);

CREATE TABLE IF NOT EXISTS shipments (
    order_id           TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
    carrier            TEXT NOT NULL,
    tracking_number    TEXT NOT NULL UNIQUE,
    status             TEXT NOT NULL CHECK (status IN
                         ('LABEL_CREATED','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED','EXCEPTION')),
    shipped_at         TIMESTAMPTZ NOT NULL,
    estimated_delivery TIMESTAMPTZ NOT NULL,
    delivered_at       TIMESTAMPTZ,
    exception_note     TEXT
);

CREATE TABLE IF NOT EXISTS escalations (
    id          BIGSERIAL PRIMARY KEY,
    ticket_id   TEXT NOT NULL,
    order_id    TEXT,
    category    TEXT NOT NULL,
    reason      TEXT NOT NULL,
    summary     TEXT NOT NULL,
    customer    TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Kill switch. provider '*' applies to every provider.
CREATE TABLE IF NOT EXISTS agent_status (
    provider    TEXT PRIMARY KEY,
    enabled     BOOLEAN NOT NULL,
    reason      TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
