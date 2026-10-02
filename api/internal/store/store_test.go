package store

// Integration tests against a real Postgres. They run when TEST_DATABASE_URL
// is set (the database is wiped and reseeded), e.g.:
//
//	docker compose up -d db
//	docker compose exec db createdb -U postgres shop_test
//	TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/shop_test?sslmode=disable go test ./...

import (
	"context"
	"os"
	"sync"
	"testing"

	"github.com/Kier85/demo-agent/api/graph/model"
	"github.com/Kier85/demo-agent/api/internal/policy"
)

const alice = "alice@example.com"

func open(t *testing.T) *Store {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	s, err := Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Reset(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}

func newAddress() model.AddressInput {
	return model.AddressInput{Name: "Alice Moreno", Line1: "500 Folsom St", City: "San Francisco", PostalCode: "94105", Country: "US"}
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	if policy.Code(err) != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}

func TestSeedLoaded(t *testing.T) {
	s := open(t)
	var orders, customers int
	s.pool.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM orders), (SELECT count(*) FROM customers)`).Scan(&orders, &customers)
	if orders != 50 || customers != 10 {
		t.Fatalf("want 50 orders / 10 customers, got %d / %d", orders, customers)
	}
}

func TestOrdersAreScopedToTheCustomer(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	o, err := s.Order(ctx, alice, "SM-1001")
	if err != nil || o == nil || o.TotalCents != 100*58 {
		t.Fatalf("own order: %+v %v", o, err)
	}
	if o, err := s.Order(ctx, "gus@example.com", "SM-1001"); o != nil || err != nil {
		t.Fatalf("foreign order must look missing, got %+v %v", o, err)
	}
	if sh, err := s.Shipment(ctx, "gus@example.com", "SM-1001"); sh != nil || err != nil {
		t.Fatalf("foreign shipment must look missing, got %+v %v", sh, err)
	}
	_, err = s.Order(ctx, "", "SM-1001")
	wantCode(t, err, policy.CodeUnauthenticated)
}

func TestShipmentComesFromMockCarrier(t *testing.T) {
	s := open(t)
	sh, err := s.Shipment(context.Background(), "farah@example.com", "SM-1006")
	if err != nil || sh == nil {
		t.Fatal(err)
	}
	last := sh.Events[len(sh.Events)-1].Description
	if sh.Status != model.ShipmentStatusException || last != "Exception: package damaged in transit, returning to sender" {
		t.Fatalf("unexpected shipment %s / %q", sh.Status, last)
	}
	if sh, _ := s.Shipment(context.Background(), "dmitri@example.com", "SM-1004"); sh != nil {
		t.Fatal("unshipped order should have no shipment")
	}
}

func TestAddressChangeOnlyBeforeProduction(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	o, err := s.UpdateShippingAddress(ctx, alice, "SM-1009", newAddress()) // PROOF_PENDING
	if err != nil || o.ShippingAddress.PostalCode != "94105" {
		t.Fatalf("allowed change failed: %v", err)
	}
	_, err = s.UpdateShippingAddress(ctx, alice, "SM-1001", newAddress()) // SHIPPED
	wantCode(t, err, policy.CodePolicyViolation)
	_, err = s.UpdateShippingAddress(ctx, "chloe@example.com", "SM-1011", newAddress()) // IN_PRODUCTION
	wantCode(t, err, policy.CodePolicyViolation)
	_, err = s.UpdateShippingAddress(ctx, "hana@example.com", "SM-1009", newAddress()) // someone else's
	wantCode(t, err, policy.CodeNotFound)
	bad := newAddress()
	bad.PostalCode = ""
	_, err = s.UpdateShippingAddress(ctx, alice, "SM-1009", bad)
	wantCode(t, err, policy.CodeInvalidInput)

	// The refused change really did not write anything.
	o, _ = s.Order(ctx, alice, "SM-1001")
	if o.ShippingAddress.PostalCode != "94110" {
		t.Fatalf("refused change leaked: %s", o.ShippingAddress.PostalCode)
	}
}

func TestReorderRules(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	o, err := s.CreateReorder(ctx, "gus@example.com", "SM-1015", []*model.ReorderItemInput{{Sku: "MAG-3X3", Quantity: 500}}, "T17:SM-1015")
	if err != nil {
		t.Fatal(err)
	}
	if o.ID != "SM-2001" || o.Status != model.OrderStatusReceived || *o.ReorderOf != "SM-1015" || len(o.Items) != 1 || o.Items[0].Quantity != 500 {
		t.Fatalf("unexpected reorder %+v", o)
	}
	_, err = s.CreateReorder(ctx, "hana@example.com", "SM-1016", nil, "k1") // cancelled
	wantCode(t, err, policy.CodePolicyViolation)
	_, err = s.CreateReorder(ctx, "jonas@example.com", "SM-1018", []*model.ReorderItemInput{{Sku: "LBL-2X1", Quantity: 50000}}, "k2")
	wantCode(t, err, policy.CodePolicyViolation)
	_, err = s.CreateReorder(ctx, "gus@example.com", "SM-1014", nil, "k3") // farah's order
	wantCode(t, err, policy.CodeNotFound)
}

func TestReorderIsIdempotent(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	ids := make([]string, 5)
	for i := range ids {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			o, err := s.CreateReorder(ctx, "farah@example.com", "SM-1014", nil, "T16:SM-1014")
			if err != nil {
				t.Error(err)
				return
			}
			ids[i] = o.ID
		}(i)
	}
	wg.Wait()
	for _, id := range ids {
		if id != ids[0] {
			t.Fatalf("idempotency broken: %v", ids)
		}
	}
	var n int
	s.pool.QueryRow(ctx, `SELECT count(*) FROM orders WHERE reorder_of = 'SM-1014'`).Scan(&n)
	if n != 1 {
		t.Fatalf("want 1 reorder, got %d", n)
	}
	_, err := s.CreateReorder(ctx, "farah@example.com", "SM-1002", nil, "T16:SM-1014")
	if policy.Code(err) == "" { // key reuse for another order (and a foreign order) must fail
		t.Fatal("expected an error")
	}
}

func TestEscalationChecksOwnership(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	in := model.EscalationInput{TicketID: "T22", Category: model.EscalationCategoryRefund, Reason: "customer requests a refund", Summary: "refund SM-1019"}
	id := "SM-1019"
	in.OrderID = &id
	e, err := s.Escalate(ctx, "isla@example.com", in)
	if err != nil || e.ID != "ESC-1" {
		t.Fatalf("escalate: %+v %v", e, err)
	}
	_, err = s.Escalate(ctx, alice, in)
	wantCode(t, err, policy.CodeNotFound)
}

func TestKillSwitch(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	s.pool.Exec(ctx, `DELETE FROM agent_status`)
	st, _ := s.AgentStatus(ctx, "openai")
	if !st.Enabled {
		t.Fatal("default should be enabled")
	}
	s.SetAgentStatus(ctx, "openai", false, "eval: wrong-action rate 10%")
	if st, _ := s.AgentStatus(ctx, "openai"); st.Enabled {
		t.Fatal("provider row should disable")
	}
	if st, _ := s.AgentStatus(ctx, "anthropic"); !st.Enabled {
		t.Fatal("other providers unaffected")
	}
	s.SetAgentStatus(ctx, "*", false, "manual stop")
	if st, _ := s.AgentStatus(ctx, "anthropic"); st.Enabled || st.Provider != "*" {
		t.Fatal("global row should disable everyone")
	}
	// Reset must not clear the kill switch.
	s.Reset(ctx)
	if st, _ := s.AgentStatus(ctx, "anthropic"); st.Enabled {
		t.Fatal("reset cleared the kill switch")
	}
	s.pool.Exec(ctx, `DELETE FROM agent_status`)
}
