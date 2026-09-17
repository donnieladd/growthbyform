// The automation service: Engine 5 (automation/trigger runtime) and the
// foundation Engine 9 (integrations) will sit on top of. It shares the one
// Postgres database the TS app already owns — no RPC between the two
// services, no shared code, just the automation_events table
// (db/migrations/0004_automation_events.sql) as the coupling surface.
//
// This process never touches persons/stage_history/etc directly to change
// them; it only reads automation_events (written by DB triggers the TS app's
// migrations own) and, eventually, acts on what it reads (SMS, email,
// escalation). Today that action is logged, not sent — see
// internal/dispatch's doc comment for why.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/donnieladd/growthbyform/automation/internal/db"
	"github.com/donnieladd/growthbyform/automation/internal/dispatch"
	"github.com/donnieladd/growthbyform/automation/internal/outbox"
	"github.com/donnieladd/growthbyform/automation/internal/scheduler"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	databaseURL := os.Getenv("DATABASE_URL")
	pool, err := db.Connect(ctx, databaseURL)
	if err != nil {
		logger.Error("could not start: database unavailable", "error", err)
		os.Exit(1)
	}
	defer pool.Close()
	logger.Info("connected to database")

	claimedBy := hostnameOr("automation")

	listener := &outbox.Listener{
		Pool:         pool,
		Dispatcher:   &dispatch.LogDispatcher{Logger: logger},
		ClaimedBy:    claimedBy,
		PollInterval: envDuration("OUTBOX_POLL_INTERVAL", 5*time.Second),
		Logger:       logger,
	}

	sched := &scheduler.Scheduler{
		Pool:     pool,
		Interval: envDuration("STALL_SWEEP_INTERVAL", time.Hour),
		Logger:   logger,
	}

	go sched.Run(ctx)

	logger.Info("automation service running", "claimed_by", claimedBy)
	if err := listener.Run(ctx); err != nil {
		logger.Error("listener stopped with error", "error", err)
		os.Exit(1)
	}
	logger.Info("shutting down")
}

func hostnameOr(fallback string) string {
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	return fallback
}

func envDuration(key string, fallback time.Duration) time.Duration {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback
	}
	if secs, err := strconv.Atoi(raw); err == nil {
		return time.Duration(secs) * time.Second
	}
	if d, err := time.ParseDuration(raw); err == nil {
		return d
	}
	return fallback
}
