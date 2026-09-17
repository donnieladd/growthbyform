// Package db owns the one connection pool this service uses. Both the outbox
// listener and the scheduler share it — no reason for two pools against one
// Postgres instance.
package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Connect opens a pool against databaseURL. Read DATABASE_URL from the
// environment yourself and pass it in — this package takes no dependency on
// how configuration is loaded, matching the TS app's own rule (env only,
// never a file).
func Connect(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	if databaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is empty")
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return pool, nil
}
