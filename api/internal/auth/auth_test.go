package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMiddleware(t *testing.T) {
	var got Caller
	h := Middleware("svc", "adm", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { got = FromContext(r.Context()) }))

	do := func(headers map[string]string) int {
		got = Caller{}
		req := httptest.NewRequest("POST", "/graphql", nil)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}

	if code := do(nil); code != http.StatusUnauthorized {
		t.Fatalf("missing token: got %d", code)
	}
	if code := do(map[string]string{"Authorization": "Bearer wrong"}); code != http.StatusUnauthorized {
		t.Fatalf("wrong token: got %d", code)
	}
	do(map[string]string{"Authorization": "Bearer svc", "X-Customer-Email": " alice@example.com "})
	if got.CustomerEmail != "alice@example.com" || got.Admin {
		t.Fatalf("customer caller: %+v", got)
	}
	do(map[string]string{"Authorization": "Bearer svc", "X-Admin-Token": "adm"})
	if !got.Admin {
		t.Fatal("admin token not recognised")
	}

	// An empty admin token disables admin access instead of matching an empty header.
	h = Middleware("", "", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { got = FromContext(r.Context()) }))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/graphql", nil))
	if got.Admin {
		t.Fatal("empty admin token must not grant admin")
	}
}
