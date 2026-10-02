package policy

import (
	"testing"

	"github.com/Kier85/demo-agent/api/graph/model"
)

func ptr[T any](v T) *T { return &v }

func TestCheckAddressChange(t *testing.T) {
	cases := map[model.OrderStatus]bool{
		model.OrderStatusReceived:     true,
		model.OrderStatusProofPending: true,
		model.OrderStatusInProduction: false,
		model.OrderStatusShipped:      false,
		model.OrderStatusDelivered:    false,
		model.OrderStatusCancelled:    false,
	}
	for status, allowed := range cases {
		err := CheckAddressChange(status)
		if allowed && err != nil {
			t.Errorf("%s: expected allowed, got %v", status, err)
		}
		if !allowed && Code(err) != CodePolicyViolation {
			t.Errorf("%s: expected POLICY_VIOLATION, got %v", status, err)
		}
	}
}

func TestValidateOrderID(t *testing.T) {
	for _, id := range []string{"SM-1001", "SM-0000"} {
		if err := ValidateOrderID(id); err != nil {
			t.Errorf("%s should be valid: %v", id, err)
		}
	}
	for _, id := range []string{"", "1001", "SM-10011", "sm-1001", "SM-1001'; DROP TABLE orders;--"} {
		if Code(ValidateOrderID(id)) != CodeInvalidInput {
			t.Errorf("%q should be rejected", id)
		}
	}
}

func TestNormalizeAddress(t *testing.T) {
	got, err := NormalizeAddress(model.AddressInput{
		Name: " Alice Moreno ", Line1: "500 Folsom St", Line2: ptr("  "),
		City: "San Francisco", Region: ptr("CA"), PostalCode: " 94105 ", Country: "us",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "Alice Moreno" || got.PostalCode != "94105" || got.Country != "US" || got.Line2 != nil {
		t.Errorf("unexpected normalisation: %+v", got)
	}

	_, err = NormalizeAddress(model.AddressInput{Name: "A", Line1: "x", City: "y", Country: "US"})
	if Code(err) != CodeInvalidInput || err.Error() != "INVALID_INPUT: address is missing: postalCode" {
		t.Errorf("missing postal code: got %v", err)
	}

	_, err = NormalizeAddress(model.AddressInput{Name: "A", Line1: "x", City: "y", PostalCode: "1", Country: "Germany"})
	if Code(err) != CodeInvalidInput {
		t.Errorf("bad country: got %v", err)
	}
}

func items() []*model.OrderItem {
	return []*model.OrderItem{
		{Sku: "DC-3X3", Product: "Die-cut stickers", Size: "3x3 in", Quantity: 100, UnitPriceCents: 60},
		{Sku: "MAG-2X2", Product: "Magnets", Size: "2x2 in", Quantity: 50, UnitPriceCents: 90},
	}
}

func TestPlanReorderWholeOrder(t *testing.T) {
	lines, err := PlanReorder(model.OrderStatusDelivered, items(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 2 || lines[0].Quantity != 100 || lines[1].Quantity != 50 {
		t.Errorf("unexpected lines: %+v", lines)
	}
}

func TestPlanReorderSubset(t *testing.T) {
	lines, err := PlanReorder(model.OrderStatusDelivered, items(), []*model.ReorderItemInput{{Sku: "MAG-2X2", Quantity: 500}})
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 1 || lines[0].Item.Sku != "MAG-2X2" || lines[0].Quantity != 500 {
		t.Errorf("unexpected lines: %+v", lines)
	}
}

func TestPlanReorderRefusals(t *testing.T) {
	cases := []struct {
		name   string
		status model.OrderStatus
		req    []*model.ReorderItemInput
		code   string
	}{
		{"cancelled order", model.OrderStatusCancelled, nil, CodePolicyViolation},
		{"unknown sku", model.OrderStatusDelivered, []*model.ReorderItemInput{{Sku: "NOPE", Quantity: 1}}, CodeInvalidInput},
		{"zero quantity", model.OrderStatusDelivered, []*model.ReorderItemInput{{Sku: "DC-3X3", Quantity: 0}}, CodeInvalidInput},
		{"duplicate sku", model.OrderStatusDelivered, []*model.ReorderItemInput{{Sku: "DC-3X3", Quantity: 1}, {Sku: "DC-3X3", Quantity: 2}}, CodeInvalidInput},
		{"bulk quantity", model.OrderStatusDelivered, []*model.ReorderItemInput{{Sku: "DC-3X3", Quantity: MaxReorderQuantity + 1}}, CodePolicyViolation},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := PlanReorder(c.status, items(), c.req)
			if Code(err) != c.code {
				t.Errorf("expected %s, got %v", c.code, err)
			}
		})
	}
}

func TestValidateEscalation(t *testing.T) {
	ok := model.EscalationInput{TicketID: "T1", Category: model.EscalationCategoryRefund, Reason: "customer requests a refund", Summary: "refund for SM-1019", OrderID: ptr("SM-1019")}
	if err := ValidateEscalation(ok); err != nil {
		t.Fatal(err)
	}
	short := ok
	short.Reason = "refund"
	if Code(ValidateEscalation(short)) != CodeInvalidInput {
		t.Error("short reason should be rejected")
	}
	badOrder := ok
	badOrder.OrderID = ptr("1019")
	if Code(ValidateEscalation(badOrder)) != CodeInvalidInput {
		t.Error("malformed order id should be rejected")
	}
}
