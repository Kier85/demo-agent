package graph

import (
	"context"
	"errors"

	"github.com/vektah/gqlparser/v2/gqlerror"

	"github.com/Kier85/demo-agent/api/internal/auth"
	"github.com/Kier85/demo-agent/api/internal/policy"
	"github.com/Kier85/demo-agent/api/internal/store"
)

// Resolver wires GraphQL to the store. Resolvers stay thin: identity comes
// from headers, rules live in internal/policy, writes live in internal/store.
type Resolver struct {
	Store *store.Store
}

func requireAdmin(ctx context.Context) error {
	if !auth.FromContext(ctx).Admin {
		return &policy.Error{Code: policy.CodeForbidden, Message: "admin token required"}
	}
	return nil
}

// gqlErr maps policy errors to GraphQL errors with extensions.code so clients
// (the agent's tool layer) can tell a refusal from an outage.
func gqlErr(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	var pe *policy.Error
	if errors.As(err, &pe) {
		return &gqlerror.Error{Message: pe.Message, Extensions: map[string]any{"code": pe.Code}}
	}
	return &gqlerror.Error{Message: "internal error", Extensions: map[string]any{"code": "INTERNAL"}}
}
