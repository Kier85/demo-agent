package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/99designs/gqlgen/graphql/handler"
	"github.com/99designs/gqlgen/graphql/handler/extension"
	"github.com/99designs/gqlgen/graphql/handler/transport"
	"github.com/99designs/gqlgen/graphql/playground"

	"github.com/Kier85/demo-agent/api/graph"
	"github.com/Kier85/demo-agent/api/internal/auth"
	"github.com/Kier85/demo-agent/api/internal/store"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(log)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	dbURL := env("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/shop?sslmode=disable")
	var st *store.Store
	var err error
	for attempt := 1; attempt <= 15; attempt++ { // Postgres may still be starting
		if st, err = store.Open(ctx, dbURL); err == nil {
			break
		}
		log.Warn("database not ready", "attempt", attempt, "err", err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		log.Error("could not open database", "err", err)
		os.Exit(1)
	}
	defer st.Close()

	srv := handler.New(graph.NewExecutableSchema(graph.Config{Resolvers: &graph.Resolver{Store: st}}))
	srv.AddTransport(transport.POST{})
	srv.AddTransport(transport.GET{})
	srv.Use(extension.Introspection{})

	apiToken := os.Getenv("API_TOKEN")
	adminToken := os.Getenv("ADMIN_TOKEN")
	allowReset := os.Getenv("ALLOW_RESET") == "true"

	mux := http.NewServeMux()
	mux.Handle("POST /graphql", auth.Middleware(apiToken, adminToken, srv))
	mux.Handle("GET /graphql", auth.Middleware(apiToken, adminToken, srv))
	mux.Handle("GET /", playground.Handler("Shop API", "/graphql"))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := st.Ping(r.Context()); err != nil {
			http.Error(w, "db down", http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte("ok"))
	})
	// Reloads the seed. Only for local runs and the eval harness.
	mux.Handle("POST /admin/reset", auth.Middleware(apiToken, adminToken, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowReset || !auth.FromContext(r.Context()).Admin {
			http.Error(w, `{"error":"reset disabled"}`, http.StatusForbidden)
			return
		}
		if err := st.Reset(r.Context()); err != nil {
			log.Error("reset failed", "err", err)
			http.Error(w, `{"error":"reset failed"}`, http.StatusInternalServerError)
			return
		}
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	})))

	addr := ":" + env("PORT", "8080")
	httpSrv := &http.Server{Addr: addr, Handler: logRequests(log, mux), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		httpSrv.Shutdown(shutdown)
	}()
	log.Info("api listening", "addr", addr, "auth", apiToken != "", "reset", allowReset)
	if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Error("server error", "err", err)
		os.Exit(1)
	}
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) { s.status = code; s.ResponseWriter.WriteHeader(code) }

func logRequests(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		if r.URL.Path != "/healthz" {
			log.Info("request", "method", r.Method, "path", r.URL.Path, "status", rec.status, "ms", time.Since(start).Milliseconds())
		}
	})
}
