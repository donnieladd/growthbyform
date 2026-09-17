// Self-serve track configuration — HANDOFF item 4. Owner-only: the server
// function re-checks this independently of the nav link being hidden, so
// this page being reachable by URL is never enough on its own.
//
// Renaming a stage here is always safe (the row's id never changes).
// Removing a stage that anyone has ever passed through is refused by the
// database and surfaced here as a readable message, not a raw constraint
// error. Saving always runs the same DB validator the rest of the app
// already trusts (validate_growth_track_config()) — this page never
// duplicates that rule, it only shows what it says.

import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Badge, Card, Field, Notice, buttonClass, inputClass, secondaryButtonClass } from "~/components/ui";
import { CHECKPOINT_LABELS } from "~/lib/format";
import {
  CADENCE_VALUES,
  CHECKPOINT_KINDS,
  DELIVERY_MODES,
  getTrackConfig,
  saveTrackConfig,
  type Cadence,
  type CheckpointKind,
  type DeliveryMode,
  type SaveStageInput,
  type TrackConfigResult,
} from "~/server/track-config";

export const Route = createFileRoute("/staff/track")({
  loader: async () => await getTrackConfig(),
  component: TrackConfigPage,
});

const CADENCE_LABELS: Record<Cadence, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  fast_track: "Fast-track (single session)",
};

const DELIVERY_MODE_LABELS: Record<DeliveryMode, string> = {
  sequential: "Sequential — steps must be taken in order",
  flexible: "Flexible — non-sequential entry allowed",
};

function TrackConfigPage() {
  const data = Route.useLoaderData();

  if (data.state === "setup-required") {
    return (
      <Notice tone="warn" title="Nothing to configure yet">
        {data.message} <Link to="/setup">Open the setup page</Link>.
      </Notice>
    );
  }
  if (data.state === "unauthenticated") {
    return (
      <Notice tone="bad" title="Not signed in">
        <Link to="/login">Sign in</Link> to configure the track.
      </Notice>
    );
  }
  if (data.state === "forbidden") {
    return (
      <Notice tone="bad" title="Owner access only">
        Track configuration is restricted to the owner role. Ask an owner on this church's account to
        make this change.
      </Notice>
    );
  }

  return <TrackConfigEditor initial={data} />;
}

type EditableStage = SaveStageInput & {
  reactKey: string; // stable across reorders even for unsaved new rows, which have no id yet
  peopleCount: number;
};

let nextKey = 0;
function freshKey(): string {
  nextKey += 1;
  return `new-${String(nextKey)}`;
}

function TrackConfigEditor({ initial }: { initial: Extract<TrackConfigResult, { state: "ok" }> }) {
  const router = useRouter();
  const [cadence, setCadence] = useState<Cadence>(initial.config.cadence);
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>(initial.config.deliveryMode);
  const [stages, setStages] = useState<EditableStage[]>(
    initial.stages.map((s) => ({
      reactKey: s.id,
      id: s.id,
      name: s.name,
      description: s.description ?? "",
      expectedDwellDays: s.expectedDwellDays,
      isTerminal: s.isTerminal,
      checkpointKind: s.checkpointKind,
      peopleCount: s.peopleCount,
    })),
  );
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<{ tone: "ok" | "bad"; text: string; errors?: string[] } | null>(null);

  function updateStage(reactKey: string, patch: Partial<EditableStage>) {
    setStages((prev) => prev.map((s) => (s.reactKey === reactKey ? { ...s, ...patch } : s)));
  }

  function move(reactKey: string, direction: -1 | 1) {
    setStages((prev) => {
      const index = prev.findIndex((s) => s.reactKey === reactKey);
      const target = index + direction;
      if (index === -1 || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function addStage() {
    setStages((prev) => [
      ...prev,
      {
        reactKey: freshKey(),
        id: null,
        name: "",
        description: "",
        expectedDwellDays: 14,
        isTerminal: false,
        checkpointKind: null,
        peopleCount: 0,
      },
    ]);
  }

  function removeStage(reactKey: string) {
    const stage = stages.find((s) => s.reactKey === reactKey);
    if (stage && stage.peopleCount > 0) {
      const ok = window.confirm(
        `${String(stage.peopleCount)} ${stage.peopleCount === 1 ? "person has" : "people have"} passed through "${stage.name}". ` +
          "The save will be refused if that history still points here when you remove it. Continue?",
      );
      if (!ok) return;
    }
    setStages((prev) => prev.filter((s) => s.reactKey !== reactKey));
  }

  async function onSave() {
    setPending(true);
    setOutcome(null);
    try {
      const result = await saveTrackConfig({
        data: {
          cadence,
          deliveryMode,
          stages: stages.map(
            (s): SaveStageInput => ({
              id: s.id,
              name: s.name,
              description: s.description,
              expectedDwellDays: s.expectedDwellDays,
              isTerminal: s.isTerminal,
              checkpointKind: s.checkpointKind,
            }),
          ),
        },
      });
      if (result.state === "ok") {
        setOutcome({ tone: "ok", text: result.message });
        await router.invalidate();
      } else if (result.state === "invalid") {
        setOutcome({ tone: "bad", text: "That track can't be saved yet:", errors: result.errors });
      } else if (result.state === "error") {
        setOutcome({ tone: "bad", text: result.message });
      } else if (result.state === "forbidden") {
        setOutcome({ tone: "bad", text: "Owner access only — this change was refused." });
      } else {
        setOutcome({ tone: "bad", text: "You are signed out — sign in again to save." });
      }
    } catch {
      setOutcome({ tone: "bad", text: "Could not reach the server — check your connection and try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <Link to="/staff" className="text-xs text-slate-500 hover:underline">
          ← Overview
        </Link>
        <h2 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">Growth Track configuration</h2>
        <p className="mt-1 text-sm text-slate-600">
          Step count, names, dwell time, cadence and delivery mode are yours to shape. Belonging first,
          self-understanding before deployment, and deployment last are enforced by the database — a
          save that breaks one of those is refused with the reason below, not silently accepted.
        </p>
      </div>

      {!initial.validation.isValid ? (
        <Notice tone="warn" title="The currently-saved track does not satisfy the checkpoint rules yet">
          <ul className="list-disc pl-4">
            {initial.validation.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <Card title="Cadence and delivery">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Cadence" htmlFor="cadence">
            <select
              id="cadence"
              className={inputClass}
              value={cadence}
              onChange={(event) => setCadence(event.target.value as Cadence)}
            >
              {CADENCE_VALUES.map((value) => (
                <option key={value} value={value}>
                  {CADENCE_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Delivery mode" htmlFor="deliveryMode">
            <select
              id="deliveryMode"
              className={inputClass}
              value={deliveryMode}
              onChange={(event) => setDeliveryMode(event.target.value as DeliveryMode)}
            >
              {DELIVERY_MODES.map((value) => (
                <option key={value} value={value}>
                  {DELIVERY_MODE_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>

      <Card
        title={`Stages (${String(stages.length)})`}
        subtitle="Order here is the order on the pipeline board — use Up/Down to reorder"
      >
        <div className="space-y-4">
          {stages.map((stage, index) => (
            <div key={stage.reactKey} className="rounded-md border border-slate-200 p-3">
              <div className="flex flex-wrap items-start gap-3">
                <div className="flex shrink-0 flex-col gap-1 pt-1">
                  <button
                    type="button"
                    disabled={index === 0}
                    onClick={() => move(stage.reactKey, -1)}
                    className={`${secondaryButtonClass} px-2 py-0.5 text-xs disabled:opacity-30`}
                    aria-label={`Move ${stage.name || "this stage"} up`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={index === stages.length - 1}
                    onClick={() => move(stage.reactKey, 1)}
                    className={`${secondaryButtonClass} px-2 py-0.5 text-xs disabled:opacity-30`}
                    aria-label={`Move ${stage.name || "this stage"} down`}
                  >
                    ↓
                  </button>
                </div>

                <div className="grid flex-1 gap-3 sm:grid-cols-2">
                  <Field label="Name" htmlFor={`name-${stage.reactKey}`}>
                    <input
                      id={`name-${stage.reactKey}`}
                      className={inputClass}
                      value={stage.name}
                      onChange={(event) => updateStage(stage.reactKey, { name: event.target.value })}
                    />
                  </Field>
                  <Field label="Checkpoint" htmlFor={`checkpoint-${stage.reactKey}`}>
                    <select
                      id={`checkpoint-${stage.reactKey}`}
                      className={inputClass}
                      value={stage.checkpointKind ?? ""}
                      onChange={(event) =>
                        updateStage(stage.reactKey, {
                          checkpointKind: (event.target.value || null) as CheckpointKind | null,
                        })
                      }
                    >
                      <option value="">Not a checkpoint</option>
                      {CHECKPOINT_KINDS.map((value) => (
                        <option key={value} value={value}>
                          {CHECKPOINT_LABELS[value]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    label="Expected dwell (days)"
                    htmlFor={`dwell-${stage.reactKey}`}
                    hint="Leave blank for a terminal stage — nobody is ever overdue at the end of the track"
                  >
                    <input
                      id={`dwell-${stage.reactKey}`}
                      type="number"
                      min={1}
                      className={inputClass}
                      value={stage.expectedDwellDays ?? ""}
                      onChange={(event) =>
                        updateStage(stage.reactKey, {
                          expectedDwellDays: event.target.value ? Number(event.target.value) : null,
                        })
                      }
                    />
                  </Field>
                  <Field label="Description (optional)" htmlFor={`desc-${stage.reactKey}`}>
                    <input
                      id={`desc-${stage.reactKey}`}
                      className={inputClass}
                      value={stage.description}
                      onChange={(event) => updateStage(stage.reactKey, { description: event.target.value })}
                    />
                  </Field>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-2">
                  {stage.peopleCount > 0 ? <Badge tone="info">{stage.peopleCount} people here</Badge> : null}
                  <label className="flex items-center gap-1 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={stage.isTerminal}
                      onChange={(event) => updateStage(stage.reactKey, { isTerminal: event.target.checked })}
                    />
                    Terminal stage
                  </label>
                  <button
                    type="button"
                    onClick={() => removeStage(stage.reactKey)}
                    className="text-xs font-medium text-rose-600 hover:underline"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        <button type="button" onClick={addStage} className={`${secondaryButtonClass} mt-4`}>
          + Add a stage
        </button>
      </Card>

      <div className="flex items-center gap-3">
        <button type="button" disabled={pending} onClick={onSave} className={buttonClass}>
          {pending ? "Saving…" : "Save track configuration"}
        </button>
        {outcome ? (
          <p
            role="status"
            className={`text-sm font-medium ${outcome.tone === "ok" ? "text-emerald-700" : "text-rose-600"}`}
          >
            {outcome.text}
            {outcome.errors ? (
              <ul className="mt-1 list-disc pl-4 font-normal">
                {outcome.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            ) : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}
