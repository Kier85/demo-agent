// Package policy holds the business rules the agent cannot talk its way
// around. Every mutation in the store runs these checks inside the same
// transaction that writes, so a refusal here is final regardless of what the
// LLM was told in its prompt.
package policy

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/Kier85/demo-agent/api/graph/model"
)

// Error codes surfaced to clients as GraphQL extensions.code.
const (
	CodeUnauthenticated = "UNAUTHENTICATED"
	CodeNotFound        = "NOT_FOUND"
	CodeInvalidInput    = "INVALID_INPUT"
	CodePolicyViolation = "POLICY_VIOLATION"
	CodeForbidden       = "FORBIDDEN"
)

// MaxReorderQuantity is the largest per-line quantity the agent may reorder.
// Anything bigger is a bulk deal for the sales team.
const MaxReorderQuantity = 5000

// Error is a refusal with a machine-readable code.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func newErr(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Code extracts the policy code from err, or "" if err is not a policy error.
func Code(err error) string {
	var pe *Error
	if errors.As(err, &pe) {
		return pe.Code
	}
	return ""
}

func NotFound(what, id string) *Error {
	return newErr(CodeNotFound, "%s %s not found for this customer", what, id)
}

var orderIDPattern = regexp.MustCompile(`^SM-\d{4}$`)

// ValidateOrderID rejects malformed order ids before they reach SQL.
func ValidateOrderID(id string) error {
	if !orderIDPattern.MatchString(id) {
		return newErr(CodeInvalidInput, "order id %q must look like SM-1234", id)
	}
	return nil
}

// CanChangeAddress reports whether the shipping address may still be edited.
// Once artwork is in production the label is printed and the box is packed.
func CanChangeAddress(s model.OrderStatus) bool {
	return s == model.OrderStatusReceived || s == model.OrderStatusProofPending
}

// CheckAddressChange returns a POLICY_VIOLATION when the order is too far along.
func CheckAddressChange(s model.OrderStatus) error {
	if CanChangeAddress(s) {
		return nil
	}
	return newErr(CodePolicyViolation,
		"shipping address can only be changed before production; order is %s", s)
}

var countryPattern = regexp.MustCompile(`^[A-Z]{2}$`)

// NormalizeAddress trims fields and validates the minimum needed to ship.
func NormalizeAddress(in model.AddressInput) (model.AddressInput, error) {
	trim := func(s string) string { return strings.TrimSpace(s) }
	out := model.AddressInput{
		Name:       trim(in.Name),
		Line1:      trim(in.Line1),
		City:       trim(in.City),
		PostalCode: strings.ToUpper(trim(in.PostalCode)),
		Country:    strings.ToUpper(trim(in.Country)),
	}
	if in.Line2 != nil && trim(*in.Line2) != "" {
		v := trim(*in.Line2)
		out.Line2 = &v
	}
	if in.Region != nil && trim(*in.Region) != "" {
		v := trim(*in.Region)
		out.Region = &v
	}
	var missing []string
	for field, v := range map[string]string{
		"name": out.Name, "line1": out.Line1, "city": out.City,
		"postalCode": out.PostalCode, "country": out.Country,
	} {
		if v == "" {
			missing = append(missing, field)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return out, newErr(CodeInvalidInput, "address is missing: %s", strings.Join(missing, ", "))
	}
	if !countryPattern.MatchString(out.Country) {
		return out, newErr(CodeInvalidInput, "country must be an ISO 3166 alpha-2 code like US or DE, got %q", out.Country)
	}
	return out, nil
}

// ReorderLine is one validated line of a reorder.
type ReorderLine struct {
	Item     *model.OrderItem
	Quantity int
}

// PlanReorder validates a reorder request against the source order. With no
// requested items the whole order is copied at the original quantities.
func PlanReorder(status model.OrderStatus, items []*model.OrderItem, requested []*model.ReorderItemInput) ([]ReorderLine, error) {
	if status == model.OrderStatusCancelled {
		return nil, newErr(CodePolicyViolation, "cancelled orders cannot be reordered; the customer should place a new order")
	}
	if len(requested) == 0 {
		lines := make([]ReorderLine, 0, len(items))
		for _, it := range items {
			lines = append(lines, ReorderLine{Item: it, Quantity: it.Quantity})
		}
		return lines, checkQuantities(lines)
	}
	bySKU := make(map[string]*model.OrderItem, len(items))
	for _, it := range items {
		bySKU[it.Sku] = it
	}
	seen := map[string]bool{}
	lines := make([]ReorderLine, 0, len(requested))
	for _, r := range requested {
		it, ok := bySKU[r.Sku]
		if !ok {
			return nil, newErr(CodeInvalidInput, "sku %q is not on the original order", r.Sku)
		}
		if seen[r.Sku] {
			return nil, newErr(CodeInvalidInput, "sku %q listed twice", r.Sku)
		}
		seen[r.Sku] = true
		lines = append(lines, ReorderLine{Item: it, Quantity: r.Quantity})
	}
	return lines, checkQuantities(lines)
}

func checkQuantities(lines []ReorderLine) error {
	for _, l := range lines {
		if l.Quantity < 1 {
			return newErr(CodeInvalidInput, "quantity for %s must be at least 1", l.Item.Sku)
		}
		if l.Quantity > MaxReorderQuantity {
			return newErr(CodePolicyViolation,
				"quantity %d for %s exceeds the self-serve limit of %d; bulk orders go to sales",
				l.Quantity, l.Item.Sku, MaxReorderQuantity)
		}
	}
	return nil
}

// ValidateEscalation makes sure a handoff carries enough context for a human.
func ValidateEscalation(in model.EscalationInput) error {
	if !in.Category.IsValid() {
		return newErr(CodeInvalidInput, "unknown escalation category %q", in.Category)
	}
	if len(strings.TrimSpace(in.Reason)) < 10 {
		return newErr(CodeInvalidInput, "escalation reason must explain why (at least 10 characters)")
	}
	if strings.TrimSpace(in.Summary) == "" {
		return newErr(CodeInvalidInput, "escalation summary is required")
	}
	if strings.TrimSpace(in.TicketID) == "" {
		return newErr(CodeInvalidInput, "ticketId is required")
	}
	if in.OrderID != nil {
		return ValidateOrderID(*in.OrderID)
	}
	return nil
}
