package seed

import "testing"

func TestSeedShape(t *testing.T) {
	orders := Orders()
	if len(orders) != 50 {
		t.Fatalf("want 50 orders, got %d", len(orders))
	}
	seen := map[string]bool{}
	for _, o := range orders {
		if seen[o.id] {
			t.Errorf("duplicate id %s", o.id)
		}
		seen[o.id] = true
		if len(o.items) == 0 {
			t.Errorf("%s has no items", o.id)
		}
		shippedStatus := o.status == "SHIPPED" || o.status == "DELIVERED"
		if shippedStatus != (o.ship != nil) {
			t.Errorf("%s: status %s but shipment=%v", o.id, o.status, o.ship != nil)
		}
		if o.ship != nil && o.ship.delivered != nil && *o.ship.delivered > 0 {
			t.Errorf("%s delivered in the future", o.id)
		}
	}
}

func TestFillerIsDeterministic(t *testing.T) {
	a, b := filler(), filler()
	for i := range a {
		if a[i].id != b[i].id || a[i].customer != b[i].customer || a[i].status != b[i].status {
			t.Fatalf("filler differs at %d", i)
		}
	}
}
