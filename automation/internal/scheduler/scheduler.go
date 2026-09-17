// Package scheduler runs the time-based half of Engine 5 — the checks that
// fire on a schedule rather than in reaction to a single row changing.
// person_stage_clock (db/migrations/0003) already derives "who is overdue"
// at read time with nothing stored; this package's only job is to notice a
// newly-overdue person and drop exactly one automation_events row for them
// per stage-entry, so the outbox/dispatch pipeline can act on it. It is not
// itself where "overdue" is computed — that stays the single view's job.
package scheduler

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// stallSweepSQL is deliberately idempotent per stage-entry: the not-exists
// check keys off stage_entered_at, so moving somebody to a new stage (which
// resets stage_changed_at) lets a fresh stall event fire later without a
// duplicate for the stage they already left.
const stallSweepSQL = `
insert into automation_events (church_id, person_id, event_type, payload)
select c.church_id, c.person_id, 'stall_detected',
       jsonb_build_object(
         'stage_id', c.stage_id,
         'stage_name', c.stage_name,
         'days_in_stage', c.days_in_stage,
         'days_overdue', c.days_overdue
       )
  from person_stage_clock c
 where c.days_overdue > 0
   and not exists (
     select 1 from automation_events e
      where e.person_id = c.person_id
        and e.event_type = 'stall_detected'
        and e.created_at >= c.stage_entered_at
   )
`

type Scheduler struct {
	Pool     *pgxpool.Pool
	Interval time.Duration
	Logger   *slog.Logger
}

func (s *Scheduler) defaults() {
	if s.Interval <= 0 {
		s.Interval = time.Hour
	}
	if s.Logger == nil {
		s.Logger = slog.Default()
	}
}

// Run blocks until ctx is cancelled, sweeping once immediately and then on
// every tick. Each sweep just inserts rows — the outbox's own NOTIFY/poll
// loop is what actually processes them, so this package never dispatches
// anything itself.
func (s *Scheduler) Run(ctx context.Context) {
	s.defaults()

	s.sweep(ctx)

	ticker := time.NewTicker(s.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.sweep(ctx)
		}
	}
}

func (s *Scheduler) sweep(ctx context.Context) {
	tag, err := s.Pool.Exec(ctx, stallSweepSQL)
	if err != nil {
		s.Logger.Error("stall sweep failed", "error", err)
		return
	}
	if n := tag.RowsAffected(); n > 0 {
		s.Logger.Info("stall sweep raised events", "count", n)
	}
}
