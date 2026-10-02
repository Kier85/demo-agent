// Package auth turns request headers into a caller identity.
//
//	Authorization: Bearer <API_TOKEN>  service-to-service token (required when API_TOKEN is set)
//	X-Customer-Email: <email>          the customer the agent is acting for
//	X-Admin-Token: <ADMIN_TOKEN>       admin operations (kill switch, reset, escalation list)
package auth

import (
	"context"
	"crypto/subtle"
	"net/http"
	"strings"
)

type ctxKey struct{}

type Caller struct {
	CustomerEmail string
	Admin         bool
}

func FromContext(ctx context.Context) Caller {
	c, _ := ctx.Value(ctxKey{}).(Caller)
	return c
}

func WithCaller(ctx context.Context, c Caller) context.Context {
	return context.WithValue(ctx, ctxKey{}, c)
}

func equal(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

// Middleware enforces apiToken (if non-empty) and attaches the Caller.
// An empty adminToken disables admin access entirely.
func Middleware(apiToken, adminToken string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if apiToken != "" {
			got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if !equal(got, apiToken) {
				http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
				return
			}
		}
		c := Caller{CustomerEmail: strings.TrimSpace(r.Header.Get("X-Customer-Email"))}
		if adminToken != "" && equal(r.Header.Get("X-Admin-Token"), adminToken) {
			c.Admin = true
		}
		next.ServeHTTP(w, r.WithContext(WithCaller(r.Context(), c)))
	})
}
