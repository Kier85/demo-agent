// Package seed loads deterministic demo data: 10 customers and 50 orders.
//
// Orders SM-1001..SM-1025 are hand-written scenarios that the eval tickets in
// agent/eval/tickets.json refer to. SM-1026..SM-1050 are generated filler from
// a fixed random seed. All timestamps are relative to "now" so tracking data
// always looks current.
package seed

import (
	"context"
	"fmt"
	"math/rand"
	"time"

	"github.com/jackc/pgx/v5"
)

type customer struct {
	id, email, name                   string
	line1, city, region, postal, ctry string
}

var customers = []customer{
	{"c01", "alice@example.com", "Alice Moreno", "742 Valencia St", "San Francisco", "CA", "94110", "US"},
	{"c02", "ben@example.com", "Ben Okafor", "18 Atlantic Ave", "Brooklyn", "NY", "11201", "US"},
	{"c03", "chloe@example.com", "Chloe Park", "2200 Westlake Ave", "Seattle", "WA", "98121", "US"},
	{"c04", "dmitri@example.com", "Dmitri Ivanov", "901 Congress Ave", "Austin", "TX", "78701", "US"},
	{"c05", "elena@example.com", "Elena Rossi", "55 Newbury St", "Boston", "MA", "02116", "US"},
	{"c06", "farah@example.com", "Farah Haddad", "1300 Pearl St", "Boulder", "CO", "80302", "US"},
	{"c07", "gus@example.com", "Gus Lindqvist", "410 N Michigan Ave", "Chicago", "IL", "60611", "US"},
	{"c08", "hana@example.com", "Hana Sato", "88 SW Morrison St", "Portland", "OR", "97204", "US"},
	{"c09", "isla@example.com", "Isla Byrne", "12 Peachtree St NE", "Atlanta", "GA", "30303", "US"},
	{"c10", "jonas@example.com", "Jonas Weber", "600 Nicollet Mall", "Minneapolis", "MN", "55402", "US"},
}

type product struct {
	sku, name, size string
	cents           int
}

var catalog = []product{
	{"DC-3X3", "Die-cut stickers", "3x3 in", 58},
	{"DC-2X2", "Die-cut stickers", "2x2 in", 42},
	{"KC-3X3", "Kiss-cut stickers", "3x3 in", 55},
	{"RC-2X2", "Circle stickers", "2x2 in", 40},
	{"MAG-3X3", "Magnets", "3x3 in", 95},
	{"BTN-1", "Buttons", "1.25 in", 70},
	{"LBL-2X1", "Roll labels", "2x1 in", 12},
	{"PST-18X24", "Posters", "18x24 in", 900},
}

func productBySKU(sku string) product {
	for _, p := range catalog {
		if p.sku == sku {
			return p
		}
	}
	panic("unknown sku " + sku)
}

type line struct {
	sku string
	qty int
}

// ship times are in days relative to now (negative = past).
type ship struct {
	status    string
	shipped   float64
	eta       float64
	delivered *float64
	note      string
}

type order struct {
	id       string
	customer string
	status   string
	age      float64 // days since the order was placed
	items    []line
	ship     *ship
}

func d(v float64) *float64 { return &v }

var scenarios = []order{
	// Where is my order
	{"SM-1001", "c01", "SHIPPED", 5, []line{{"DC-3X3", 100}}, &ship{"IN_TRANSIT", -2, 2, nil, ""}},
	{"SM-1002", "c02", "DELIVERED", 9, []line{{"KC-3X3", 200}}, &ship{"DELIVERED", -6, -3, d(-3), ""}},
	{"SM-1003", "c03", "SHIPPED", 6, []line{{"RC-2X2", 500}}, &ship{"OUT_FOR_DELIVERY", -3, 0.3, nil, ""}},
	{"SM-1004", "c04", "IN_PRODUCTION", 2, []line{{"MAG-3X3", 50}}, nil},
	{"SM-1005", "c05", "SHIPPED", 3, []line{{"DC-2X2", 300}}, &ship{"LABEL_CREATED", -0.2, 4, nil, ""}},
	{"SM-1006", "c06", "SHIPPED", 8, []line{{"BTN-1", 100}}, &ship{"EXCEPTION", -5, -1, nil, "package damaged in transit, returning to sender"}},
	{"SM-1007", "c07", "DELIVERED", 10, []line{{"DC-3X3", 250}}, &ship{"DELIVERED", -7, -2, d(-2), ""}},
	{"SM-1008", "c08", "SHIPPED", 14, []line{{"LBL-2X1", 1000}}, &ship{"IN_TRANSIT", -11, -5, nil, ""}},
	// Address changes
	{"SM-1009", "c01", "PROOF_PENDING", 1, []line{{"KC-3X3", 100}}, nil},
	{"SM-1010", "c02", "RECEIVED", 0.5, []line{{"DC-2X2", 50}}, nil},
	{"SM-1011", "c03", "IN_PRODUCTION", 3, []line{{"PST-18X24", 20}}, nil},
	{"SM-1012", "c04", "SHIPPED", 4, []line{{"DC-3X3", 100}}, &ship{"IN_TRANSIT", -1, 3, nil, ""}},
	{"SM-1013", "c05", "PROOF_PENDING", 1, []line{{"MAG-3X3", 25}}, nil},
	// Reorders
	{"SM-1014", "c06", "DELIVERED", 18, []line{{"DC-3X3", 200}}, &ship{"DELIVERED", -14, -10, d(-10), ""}},
	{"SM-1015", "c07", "DELIVERED", 24, []line{{"DC-2X2", 300}, {"MAG-3X3", 100}}, &ship{"DELIVERED", -20, -16, d(-16), ""}},
	{"SM-1016", "c08", "CANCELLED", 9, []line{{"RC-2X2", 200}}, nil},
	{"SM-1017", "c09", "DELIVERED", 9, []line{{"KC-3X3", 400}}, &ship{"DELIVERED", -6, -2, d(-2), ""}},
	{"SM-1018", "c10", "DELIVERED", 29, []line{{"LBL-2X1", 2000}}, &ship{"DELIVERED", -25, -21, d(-21), ""}},
	// Refunds
	{"SM-1019", "c09", "DELIVERED", 15, []line{{"BTN-1", 150}}, &ship{"DELIVERED", -12, -8, d(-8), ""}},
	{"SM-1020", "c10", "DELIVERED", 19, []line{{"DC-3X3", 500}}, &ship{"DELIVERED", -15, -12, d(-6), ""}},
	{"SM-1021", "c01", "DELIVERED", 12, []line{{"RC-2X2", 300}}, &ship{"DELIVERED", -9, -5, d(-5), ""}},
	{"SM-1022", "c02", "PROOF_PENDING", 1, []line{{"PST-18X24", 10}}, nil},
	{"SM-1023", "c03", "DELIVERED", 13, []line{{"DC-2X2", 1000}}, &ship{"DELIVERED", -10, -7, d(-7), ""}},
	// Mixed / ambiguous
	{"SM-1024", "c04", "PROOF_PENDING", 0.5, []line{{"KC-3X3", 150}}, nil},
	{"SM-1025", "c05", "SHIPPED", 4, []line{{"MAG-3X3", 40}}, &ship{"IN_TRANSIT", -2, 2, nil, ""}},
}

// filler returns orders SM-1026..SM-1050 from a fixed seed.
func filler() []order {
	r := rand.New(rand.NewSource(42))
	statuses := []string{"RECEIVED", "PROOF_PENDING", "IN_PRODUCTION", "SHIPPED", "DELIVERED", "DELIVERED", "DELIVERED", "CANCELLED"}
	out := make([]order, 0, 25)
	for n := 1026; n <= 1050; n++ {
		o := order{
			id:       fmt.Sprintf("SM-%d", n),
			customer: customers[r.Intn(len(customers))].id,
			status:   statuses[r.Intn(len(statuses))],
			age:      float64(1 + r.Intn(40)),
		}
		nLines := 1 + r.Intn(2)
		perm := r.Perm(len(catalog))
		for i := 0; i < nLines; i++ {
			o.items = append(o.items, line{catalog[perm[i]].sku, 50 * (1 + r.Intn(20))})
		}
		switch o.status {
		case "SHIPPED":
			o.age = float64(3 + r.Intn(5))
			o.ship = &ship{"IN_TRANSIT", -1 - float64(r.Intn(2)), 1 + float64(r.Intn(3)), nil, ""}
		case "DELIVERED":
			shipped := -(o.age - 2)
			o.ship = &ship{"DELIVERED", shipped, shipped + 4, d(shipped + 4), ""}
			if shipped+4 > 0 { // too recent to be delivered: push it back
				o.age += 6
				o.ship = &ship{"DELIVERED", shipped - 6, shipped - 2, d(shipped - 2), ""}
			}
		}
		out = append(out, o)
	}
	return out
}

// Orders returns all 50 seeded orders (exported for tests).
func Orders() []order { return append(append([]order{}, scenarios...), filler()...) }

// Reset wipes orders, shipments and escalations and reloads the seed in one
// transaction. The kill-switch table is deliberately left alone.
func Reset(ctx context.Context, tx pgx.Tx, now time.Time) error {
	if _, err := tx.Exec(ctx, `TRUNCATE escalations, shipments, order_items, orders, customers RESTART IDENTITY CASCADE`); err != nil {
		return fmt.Errorf("truncate: %w", err)
	}
	b := &pgx.Batch{}
	byID := map[string]customer{}
	for _, c := range customers {
		byID[c.id] = c
		b.Queue(`INSERT INTO customers (id, email, name) VALUES ($1,$2,$3)`, c.id, c.email, c.name)
	}
	day := func(v float64) time.Time {
		return now.Add(time.Duration(v * float64(24*time.Hour))).Truncate(time.Minute)
	}
	for i, o := range Orders() {
		c := byID[o.customer]
		b.Queue(`INSERT INTO orders (id, customer_id, status, created_at, ship_name, ship_line1, ship_city, ship_region, ship_postal_code, ship_country)
		         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			o.id, c.id, o.status, day(-o.age), c.name, c.line1, c.city, c.region, c.postal, c.ctry)
		for ln, it := range o.items {
			p := productBySKU(it.sku)
			b.Queue(`INSERT INTO order_items (order_id, line_no, sku, product, size, quantity, unit_price_cents) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
				o.id, ln+1, p.sku, p.name, p.size, it.qty, p.cents)
		}
		if s := o.ship; s != nil {
			carrier := "UPS"
			if i%4 == 3 {
				carrier = "USPS"
			}
			var delivered *time.Time
			if s.delivered != nil {
				t := day(*s.delivered)
				delivered = &t
			}
			var note *string
			if s.note != "" {
				note = &s.note
			}
			b.Queue(`INSERT INTO shipments (order_id, carrier, tracking_number, status, shipped_at, estimated_delivery, delivered_at, exception_note)
			         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
				o.id, carrier, fmt.Sprintf("1ZSM%08d", 40000000+i*7919), s.status, day(s.shipped), day(s.eta), delivered, note)
		}
	}
	return tx.SendBatch(ctx, b).Close()
}
