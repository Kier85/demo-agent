// Package carrier is a deterministic stand-in for a shipping carrier's
// tracking API. Given the shipment state stored in Postgres it produces the
// event history a real carrier would return, so the agent has realistic data
// to reason about without any network calls.
package carrier

import (
	"time"

	"github.com/Kier85/demo-agent/api/graph/model"
)

// Origin is where every order ships from.
const Origin = "Amsterdam, NY"

// Record is the subset of a shipment row the carrier needs.
type Record struct {
	Status            model.ShipmentStatus
	ShippedAt         time.Time
	EstimatedDelivery time.Time
	DeliveredAt       *time.Time
	DestinationCity   string
	// ExceptionNote describes what went wrong when Status is EXCEPTION.
	ExceptionNote string
}

// Events returns tracking events, oldest first. now caps future events.
func Events(r Record, now time.Time) []*model.TrackingEvent {
	ev := []*model.TrackingEvent{
		{At: r.ShippedAt, Location: Origin, Description: "Shipping label created"},
	}
	add := func(at time.Time, loc, desc string) {
		if at.After(now) {
			return
		}
		ev = append(ev, &model.TrackingEvent{At: at, Location: loc, Description: desc})
	}
	if r.Status == model.ShipmentStatusLabelCreated {
		return ev
	}

	pickup := r.ShippedAt.Add(6 * time.Hour)
	add(pickup, Origin, "Picked up by carrier")
	add(pickup.Add(14*time.Hour), "Regional hub, Albany, NY", "Departed facility")

	switch r.Status {
	case model.ShipmentStatusInTransit:
		add(pickup.Add(38*time.Hour), "Sort center near "+r.DestinationCity, "In transit to destination")
	case model.ShipmentStatusOutForDelivery:
		add(pickup.Add(38*time.Hour), "Sort center near "+r.DestinationCity, "Arrived at local facility")
		add(now.Add(-2*time.Hour), r.DestinationCity, "Out for delivery")
	case model.ShipmentStatusDelivered:
		at := r.EstimatedDelivery
		if r.DeliveredAt != nil {
			at = *r.DeliveredAt
		}
		add(at.Add(-5*time.Hour), r.DestinationCity, "Out for delivery")
		add(at, r.DestinationCity, "Delivered, left at front door")
	case model.ShipmentStatusException:
		note := r.ExceptionNote
		if note == "" {
			note = "Delivery exception"
		}
		add(pickup.Add(38*time.Hour), "Sort center near "+r.DestinationCity, "Exception: "+note)
	}
	return ev
}
