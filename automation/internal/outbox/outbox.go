// Package outbox is the consumer side of the automation_events table
// (db/migrations/0004_automation_events.sql). The TS app never reads its own
// writes there — this package is the only reader. Two ways in, on purpose:
//
//   - LISTEN on the "automation_events" channel gives near-instant wake-up
//     for new rows (the DB triggers in 0004 call pg_notify on insert).
//   - A periodic poll of unclaimed rows is the durable fallback — Postgres
//     NOTIFY is fire-and-forget, so an event inserted while this process is
//     down (or mid-restart) produces no notification once it comes back.
//     The poll is what actually guarantees delivery; LISTEN is just latency.
//
// A row is claimed (claimed_at/claimed_by set) before being handed to the
// Dispatcher, so a restart mid-processing can't hand the same event to two
// workers — a stale claim (older than staleClaimAfter) is treated as
// abandoned and re-claimed rather than left stuck forever.
package outbox

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Event is one row of automation_events, exactly as a Dispatcher sees it.
type Event struct {
	ID        string
	ChurchID  string
	PersonID  *string
	EventType string
	Payload   []byte // raw jsonb; the dispatcher decodes what it cares about
	Attempts  int
}

// Dispatcher acts on one event. Returning an error leaves the event
// unprocessed (processed_at stays NULL) with attempts incremented and
// last_error recorded, so it is retried on the next poll rather than
// silently dropped.
type Dispatcher interface {
	Dispatch(ctx context.Context, event Event) error
}

type Listener struct {
	Pool            *pgxpool.Pool
	Dispatcher      Dispatcher
	ClaimedBy       string        // an identifier for this process instance, for observability
	PollInterval    time.Duration // durable fallback cadence
	StaleClaimAfter time.Duration // a claim older than this is treated as abandoned
	BatchSize       int
	Logger          *slog.Logger
}

func (l *Listener) defaults() {
	if l.PollInterval <= 0 {
		l.PollInterval = 5 * time.Second
	}
	if l.StaleClaimAfter <= 0 {
		l.StaleClaimAfter = 2 * time.Minute
	}
	if l.BatchSize <= 0 {
		l.BatchSize = 25
	}
	if l.Logger == nil {
		l.Logger = slog.Default()
	}
}

// Run blocks until ctx is cancelled. It drains whatever is pending on
// startup, then alternates between "woken by NOTIFY" and "woken by the poll
// ticker" — either one just means "go check the table," never "trust this
// payload," so a missed or coalesced notification is never a correctness gap.
func (l *Listener) Run(ctx context.Context) error {
	l.defaults()

	conn, err := l.Pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, "listen automation_events"); err != nil {
		return err
	}

	l.drain(ctx)

	ticker := time.NewTicker(l.PollInterval)
	defer ticker.Stop()

	notifications := make(chan *pgconn.Notification)
	go func() {
		defer close(notifications)
		for {
			n, err := conn.Conn().WaitForNotification(ctx)
			if err != nil {
				return // context cancelled, or connection lost — Run's select below exits too
			}
			select {
			case notifications <- n:
			case <-ctx.Done():
				return
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			l.drain(ctx)
		case _, ok := <-notifications:
			if !ok {
				return nil
			}
			l.drain(ctx)
		}
	}
}

// drain claims and dispatches events until a batch comes back empty. Errors
// are logged, not returned — one bad event (or one transient DB blip) must
// never take the whole listener down.
func (l *Listener) drain(ctx context.Context) {
	for {
		n, err := l.claimAndDispatchBatch(ctx)
		if err != nil {
			l.Logger.Error("outbox drain failed", "error", err)
			return
		}
		if n == 0 {
			return
		}
	}
}

func (l *Listener) claimAndDispatchBatch(ctx context.Context) (int, error) {
	tx, err := l.Pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op if already committed

	staleBefore := time.Now().Add(-l.StaleClaimAfter)

	rows, err := tx.Query(ctx, `
		select id, church_id, person_id, event_type, payload, attempts
		  from automation_events
		 where processed_at is null
		   and (claimed_at is null or claimed_at < $1)
		 order by created_at
		 limit $2
		   for update skip locked
	`, staleBefore, l.BatchSize)
	if err != nil {
		return 0, err
	}

	var events []Event
	for rows.Next() {
		var e Event
		var personID *string
		if err := rows.Scan(&e.ID, &e.ChurchID, &personID, &e.EventType, &e.Payload, &e.Attempts); err != nil {
			rows.Close()
			return 0, err
		}
		e.PersonID = personID
		events = append(events, e)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if len(events) == 0 {
		return 0, nil
	}

	ids := make([]string, len(events))
	for i, e := range events {
		ids[i] = e.ID
	}
	if _, err := tx.Exec(ctx,
		`update automation_events set claimed_at = now(), claimed_by = $1 where id = any($2)`,
		l.ClaimedBy, ids,
	); err != nil {
		return 0, err
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}

	// Dispatch happens outside the claiming transaction: a slow or failed
	// dispatch must never hold a row lock on automation_events.
	for _, e := range events {
		l.dispatchOne(ctx, e)
	}
	return len(events), nil
}

func (l *Listener) dispatchOne(ctx context.Context, e Event) {
	err := l.Dispatcher.Dispatch(ctx, e)
	if err == nil {
		if _, execErr := l.Pool.Exec(ctx,
			`update automation_events set processed_at = now() where id = $1`, e.ID,
		); execErr != nil {
			l.Logger.Error("failed to mark event processed", "event_id", e.ID, "error", execErr)
		}
		return
	}
	l.Logger.Error("dispatch failed, will retry", "event_id", e.ID, "event_type", e.EventType, "error", err)
	if _, execErr := l.Pool.Exec(ctx,
		`update automation_events set attempts = attempts + 1, last_error = $2, claimed_at = null, claimed_by = null where id = $1`,
		e.ID, err.Error(),
	); execErr != nil {
		l.Logger.Error("failed to record dispatch failure", "event_id", e.ID, "error", execErr)
	}
}
