// Package dispatch turns an outbox event into an actual action: an SMS, an
// email, a task assignment, an escalation. Nothing in this package sends a
// real message yet — see LogDispatcher below. Wiring a real provider
// (Twilio/equivalent for SMS, Resend/SendGrid for email) needs that
// provider's credentials, which this environment does not have and this
// package does not fabricate. That's a real, owner-level blocker: someone
// has to pick a provider and create the account before this stub can become
// the real thing. Until then, LogDispatcher lets the whole pipeline —
// trigger, outbox, claim, dispatch, mark-processed — run and be verified
// end-to-end with nothing pretending to be a sent message.
package dispatch

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/donnieladd/growthbyform/automation/internal/outbox"
)

// LogDispatcher records what it would have done and marks the event
// processed. Swap this for a real implementation per event_type once a
// provider is chosen — the outbox and listener don't change either way.
type LogDispatcher struct {
	Logger *slog.Logger
}

func (d *LogDispatcher) Dispatch(_ context.Context, e outbox.Event) error {
	logger := d.Logger
	if logger == nil {
		logger = slog.Default()
	}
	var payload map[string]any
	_ = json.Unmarshal(e.Payload, &payload) // best-effort for logging only

	logger.Info("automation event (no real action taken — no SMS/email provider configured)",
		"event_id", e.ID,
		"church_id", e.ChurchID,
		"person_id", e.PersonID,
		"event_type", e.EventType,
		"payload", payload,
	)
	return nil
}
