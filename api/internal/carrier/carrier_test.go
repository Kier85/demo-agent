package carrier

import (
	"testing"
	"time"

	"github.com/Kier85/demo-agent/api/graph/model"
)

var now = time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)

func last(ev []*model.TrackingEvent) string { return ev[len(ev)-1].Description }

func TestEventsByStatus(t *testing.T) {
	shipped := now.Add(-72 * time.Hour)
	delivered := now.Add(-24 * time.Hour)
	cases := []struct {
		rec  Record
		want string
	}{
		{Record{Status: model.ShipmentStatusLabelCreated, ShippedAt: now.Add(-2 * time.Hour)}, "Shipping label created"},
		{Record{Status: model.ShipmentStatusInTransit, ShippedAt: shipped, DestinationCity: "Austin, TX"}, "In transit to destination"},
		{Record{Status: model.ShipmentStatusOutForDelivery, ShippedAt: shipped, DestinationCity: "Austin, TX"}, "Out for delivery"},
		{Record{Status: model.ShipmentStatusDelivered, ShippedAt: shipped, DeliveredAt: &delivered, DestinationCity: "Austin, TX"}, "Delivered, left at front door"},
		{Record{Status: model.ShipmentStatusException, ShippedAt: shipped, ExceptionNote: "package damaged", DestinationCity: "Austin, TX"}, "Exception: package damaged"},
	}
	for _, c := range cases {
		ev := Events(c.rec, now)
		if got := last(ev); got != c.want {
			t.Errorf("%s: last event %q, want %q", c.rec.Status, got, c.want)
		}
		for i := 1; i < len(ev); i++ {
			if ev[i].At.Before(ev[i-1].At) {
				t.Errorf("%s: events out of order", c.rec.Status)
			}
		}
	}
}

func TestEventsNeverInFuture(t *testing.T) {
	ev := Events(Record{Status: model.ShipmentStatusInTransit, ShippedAt: now.Add(-1 * time.Hour), DestinationCity: "Austin, TX"}, now)
	for _, e := range ev {
		if e.At.After(now) {
			t.Errorf("event %q is in the future", e.Description)
		}
	}
}
