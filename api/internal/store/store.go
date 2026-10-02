// Package store is the Postgres data layer. Every customer-facing method takes
// the authenticated customer's email and scopes its queries to that customer;
// every mutation re-checks policy inside its own transaction.
package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Kier85/demo-agent/api/db"
	"github.com/Kier85/demo-agent/api/graph/model"
	"github.com/Kier85/demo-agent/api/internal/carrier"
	"github.com/Kier85/demo-agent/api/internal/policy"
	"github.com/Kier85/demo-agent/api/internal/seed"
)

const reorderSeqStart = 2001

type Store struct {
	pool *pgxpool.Pool
	Now  func() time.Time
}

// Open connects, applies the schema and seeds an empty database.
func Open(ctx context.Context, url string) (*Store, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, err
	}
	s := &Store{pool: pool, Now: time.Now}
	if err := s.migrate(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM customers`).Scan(&n); err != nil {
		pool.Close()
		return nil, err
	}
	if n == 0 {
		if err := s.Reset(ctx); err != nil {
			pool.Close()
			return nil, err
		}
	}
	return s, nil
}

func (s *Store) Close() { s.pool.Close() }

func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

func (s *Store) migrate(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	// Serialise concurrent cold starts on Cloud Run.
	if _, err := s.pool.Exec(ctx, `SELECT pg_advisory_lock(424242)`); err != nil {
		return err
	}
	defer s.pool.Exec(context.Background(), `SELECT pg_advisory_unlock(424242)`)
	if _, err := s.pool.Exec(ctx, db.Schema); err != nil {
		return fmt.Errorf("apply schema: %w", err)
	}
	_, err := s.pool.Exec(ctx, fmt.Sprintf(`CREATE SEQUENCE IF NOT EXISTS reorder_seq START %d`, reorderSeqStart))
	return err
}

// Reset reloads the demo seed. Used by the eval harness between tickets.
func (s *Store) Reset(ctx context.Context) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := seed.Reset(ctx, tx, s.Now()); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, fmt.Sprintf(`ALTER SEQUENCE reorder_seq RESTART WITH %d`, reorderSeqStart))
		return err
	})
}

type querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func requireCustomer(email string) error {
	if strings.TrimSpace(email) == "" {
		return &policy.Error{Code: policy.CodeUnauthenticated, Message: "X-Customer-Email header is required"}
	}
	return nil
}

// loadOrder fetches an order owned by email. Returns a NOT_FOUND policy error
// for both missing and foreign orders so ownership cannot be probed.
func loadOrder(ctx context.Context, q querier, email, id string, forUpdate bool) (*model.Order, error) {
	if err := requireCustomer(email); err != nil {
		return nil, err
	}
	if err := policy.ValidateOrderID(id); err != nil {
		return nil, err
	}
	sql := `SELECT o.id, o.status, o.created_at, o.currency, o.reorder_of,
	               o.ship_name, o.ship_line1, o.ship_line2, o.ship_city, o.ship_region, o.ship_postal_code, o.ship_country,
	               c.id, c.email, c.name
	        FROM orders o JOIN customers c ON c.id = o.customer_id
	        WHERE o.id = $1 AND lower(c.email) = lower($2)`
	if forUpdate {
		sql += ` FOR UPDATE OF o`
	}
	o := &model.Order{Customer: &model.Customer{}, ShippingAddress: &model.Address{}}
	a := o.ShippingAddress
	err := q.QueryRow(ctx, sql, id, email).Scan(
		&o.ID, &o.Status, &o.CreatedAt, &o.Currency, &o.ReorderOf,
		&a.Name, &a.Line1, &a.Line2, &a.City, &a.Region, &a.PostalCode, &a.Country,
		&o.Customer.ID, &o.Customer.Email, &o.Customer.Name)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, policy.NotFound("order", id)
	}
	if err != nil {
		return nil, err
	}
	rows, err := q.Query(ctx, `SELECT sku, product, size, quantity, unit_price_cents FROM order_items WHERE order_id = $1 ORDER BY line_no`, id)
	if err != nil {
		return nil, err
	}
	o.Items, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (*model.OrderItem, error) {
		it := &model.OrderItem{}
		return it, r.Scan(&it.Sku, &it.Product, &it.Size, &it.Quantity, &it.UnitPriceCents)
	})
	if err != nil {
		return nil, err
	}
	for _, it := range o.Items {
		o.TotalCents += it.Quantity * it.UnitPriceCents
	}
	o.CanChangeAddress = policy.CanChangeAddress(o.Status)
	return o, nil
}

// Order returns (nil, nil) when the order is not visible to this customer.
func (s *Store) Order(ctx context.Context, email, id string) (*model.Order, error) {
	o, err := loadOrder(ctx, s.pool, email, id, false)
	if policy.Code(err) == policy.CodeNotFound {
		return nil, nil
	}
	return o, err
}

// Shipment returns tracking from the mock carrier, or (nil, nil) if the order
// has not shipped yet.
func (s *Store) Shipment(ctx context.Context, email, orderID string) (*model.Shipment, error) {
	o, err := loadOrder(ctx, s.pool, email, orderID, false)
	if policy.Code(err) == policy.CodeNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	sh := &model.Shipment{OrderID: o.ID}
	var note *string
	err = s.pool.QueryRow(ctx, `SELECT carrier, tracking_number, status, shipped_at, estimated_delivery, delivered_at, exception_note
	                            FROM shipments WHERE order_id = $1`, o.ID).
		Scan(&sh.Carrier, &sh.TrackingNumber, &sh.Status, &sh.ShippedAt, &sh.EstimatedDelivery, &sh.DeliveredAt, &note)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	rec := carrier.Record{
		Status: sh.Status, ShippedAt: sh.ShippedAt, EstimatedDelivery: sh.EstimatedDelivery,
		DeliveredAt: sh.DeliveredAt, DestinationCity: o.ShippingAddress.City,
	}
	if note != nil {
		rec.ExceptionNote = *note
	}
	sh.Events = carrier.Events(rec, s.Now())
	return sh, nil
}

func (s *Store) UpdateShippingAddress(ctx context.Context, email, orderID string, in model.AddressInput) (*model.Order, error) {
	addr, err := policy.NormalizeAddress(in)
	if err != nil {
		return nil, err
	}
	var out *model.Order
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		o, err := loadOrder(ctx, tx, email, orderID, true)
		if err != nil {
			return err
		}
		if err := policy.CheckAddressChange(o.Status); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE orders SET ship_name=$2, ship_line1=$3, ship_line2=$4, ship_city=$5,
		                           ship_region=$6, ship_postal_code=$7, ship_country=$8 WHERE id=$1`,
			o.ID, addr.Name, addr.Line1, addr.Line2, addr.City, addr.Region, addr.PostalCode, addr.Country); err != nil {
			return err
		}
		out, err = loadOrder(ctx, tx, email, orderID, false)
		return err
	})
	return out, err
}

func (s *Store) CreateReorder(ctx context.Context, email, orderID string, items []*model.ReorderItemInput, key string) (*model.Order, error) {
	key = strings.TrimSpace(key)
	if key == "" {
		return nil, &policy.Error{Code: policy.CodeInvalidInput, Message: "idempotencyKey is required"}
	}
	var newID string
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		src, err := loadOrder(ctx, tx, email, orderID, true)
		if err != nil {
			return err
		}
		// Idempotency: the same key returns the reorder it already created.
		var existing, existingSrc string
		err = tx.QueryRow(ctx, `SELECT id, coalesce(reorder_of,'') FROM orders WHERE idempotency_key = $1`, key).Scan(&existing, &existingSrc)
		if err == nil {
			if existingSrc != src.ID {
				return &policy.Error{Code: policy.CodeInvalidInput, Message: "idempotencyKey already used for a different order"}
			}
			newID = existing
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		lines, err := policy.PlanReorder(src.Status, src.Items, items)
		if err != nil {
			return err
		}
		var seq int
		if err := tx.QueryRow(ctx, `SELECT nextval('reorder_seq')`).Scan(&seq); err != nil {
			return err
		}
		newID = fmt.Sprintf("SM-%d", seq)
		a := src.ShippingAddress
		if _, err := tx.Exec(ctx, `INSERT INTO orders (id, customer_id, status, created_at, currency, ship_name, ship_line1, ship_line2,
		                           ship_city, ship_region, ship_postal_code, ship_country, reorder_of, idempotency_key)
		                           VALUES ($1,$2,'RECEIVED',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
			newID, src.Customer.ID, s.Now(), src.Currency, a.Name, a.Line1, a.Line2, a.City, a.Region, a.PostalCode, a.Country, src.ID, key); err != nil {
			return err
		}
		for i, l := range lines {
			if _, err := tx.Exec(ctx, `INSERT INTO order_items (order_id, line_no, sku, product, size, quantity, unit_price_cents)
			                           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
				newID, i+1, l.Item.Sku, l.Item.Product, l.Item.Size, l.Quantity, l.Item.UnitPriceCents); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" { // concurrent request with the same key
			return s.reorderByKey(ctx, email, key)
		}
		return nil, err
	}
	return loadOrder(ctx, s.pool, email, newID, false)
}

func (s *Store) reorderByKey(ctx context.Context, email, key string) (*model.Order, error) {
	var id string
	if err := s.pool.QueryRow(ctx, `SELECT id FROM orders WHERE idempotency_key = $1`, key).Scan(&id); err != nil {
		return nil, err
	}
	return loadOrder(ctx, s.pool, email, id, false)
}

func (s *Store) Escalate(ctx context.Context, email string, in model.EscalationInput) (*model.Escalation, error) {
	if err := requireCustomer(email); err != nil {
		return nil, err
	}
	if err := policy.ValidateEscalation(in); err != nil {
		return nil, err
	}
	if in.OrderID != nil {
		if _, err := loadOrder(ctx, s.pool, email, *in.OrderID, false); err != nil {
			if policy.Code(err) == policy.CodeNotFound {
				return nil, &policy.Error{Code: policy.CodeNotFound,
					Message: fmt.Sprintf("order %s not found for this customer; escalate without an orderId", *in.OrderID)}
			}
			return nil, err
		}
	}
	e := &model.Escalation{TicketID: in.TicketID, OrderID: in.OrderID, Category: in.Category, Reason: in.Reason, Summary: in.Summary}
	var id int64
	err := s.pool.QueryRow(ctx, `INSERT INTO escalations (ticket_id, order_id, category, reason, summary, customer)
	                             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
		in.TicketID, in.OrderID, in.Category, in.Reason, in.Summary, email).Scan(&id, &e.CreatedAt)
	e.ID = fmt.Sprintf("ESC-%d", id)
	return e, err
}

func (s *Store) Escalations(ctx context.Context, limit int) ([]*model.Escalation, error) {
	if limit <= 0 || limit > 200 {
		limit = 20
	}
	rows, err := s.pool.Query(ctx, `SELECT id, ticket_id, order_id, category, reason, summary, created_at
	                                FROM escalations ORDER BY id DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (*model.Escalation, error) {
		e := &model.Escalation{}
		var id int64
		err := r.Scan(&id, &e.TicketID, &e.OrderID, &e.Category, &e.Reason, &e.Summary, &e.CreatedAt)
		e.ID = fmt.Sprintf("ESC-%d", id)
		return e, err
	})
}

// AgentStatus resolves the kill switch: a disabled global '*' row wins, then
// the provider's own row; no rows means enabled.
func (s *Store) AgentStatus(ctx context.Context, provider string) (*model.AgentStatus, error) {
	rows, err := s.pool.Query(ctx, `SELECT provider, enabled, reason, updated_at FROM agent_status
	                                WHERE provider = '*' OR provider = $1`, provider)
	if err != nil {
		return nil, err
	}
	all, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (*model.AgentStatus, error) {
		st := &model.AgentStatus{}
		return st, r.Scan(&st.Provider, &st.Enabled, &st.Reason, &st.UpdatedAt)
	})
	if err != nil {
		return nil, err
	}
	var own *model.AgentStatus
	for _, st := range all {
		if st.Provider == "*" && !st.Enabled {
			return st, nil
		}
		if st.Provider == provider {
			own = st
		}
	}
	if own != nil {
		return own, nil
	}
	return &model.AgentStatus{Provider: provider, Enabled: true, Reason: "default", UpdatedAt: s.Now()}, nil
}

func (s *Store) SetAgentStatus(ctx context.Context, provider string, enabled bool, reason string) (*model.AgentStatus, error) {
	provider = strings.TrimSpace(provider)
	if provider == "" {
		return nil, &policy.Error{Code: policy.CodeInvalidInput, Message: "provider is required"}
	}
	st := &model.AgentStatus{Provider: provider, Enabled: enabled, Reason: reason}
	err := s.pool.QueryRow(ctx, `INSERT INTO agent_status (provider, enabled, reason, updated_at) VALUES ($1,$2,$3,now())
	                             ON CONFLICT (provider) DO UPDATE SET enabled=EXCLUDED.enabled, reason=EXCLUDED.reason, updated_at=now()
	                             RETURNING updated_at`, provider, enabled, reason).Scan(&st.UpdatedAt)
	return st, err
}
