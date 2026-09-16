import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Badge, Card, Field, Notice, buttonClass, inputClass, secondaryButtonClass } from "~/components/ui";
import { getConnectCardReadiness, submitConnectCard, type ConnectCardResult } from "~/server/connect";

export const Route = createFileRoute("/connect")({
  loader: async () => await getConnectCardReadiness(),
  component: ConnectCardPage,
});

type FormState = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  addressLine1: string;
  city: string;
  region: string;
  postalCode: string;
  visitReport: "first_time" | "returning" | "unsure";
  householdMembers: string;
  children: string;
  howHeard: string;
  prayerRequest: string;
  website: string;
};

const EMPTY: FormState = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  addressLine1: "",
  city: "",
  region: "",
  postalCode: "",
  visitReport: "first_time",
  householdMembers: "",
  children: "",
  howHeard: "",
  prayerRequest: "",
  website: "",
};

function ConnectCardPage() {
  const readiness = Route.useLoaderData();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ConnectCardResult | null>(null);
  const [pending, setPending] = useState(false);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setErrors({});
    try {
      const response = await submitConnectCard({ data: { ...form } });
      if (response.state === "invalid") {
        setErrors(response.errors);
        setResult(null);
      } else {
        setResult(response);
      }
    } finally {
      setPending(false);
    }
  }

  if (result && result.state === "ok") {
    return (
      <main className="mx-auto w-full max-w-2xl px-6 py-12">
        <Card>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="ok">
              {result.visitNumber === 1 ? "First visit recorded" : `Visit #${String(result.visitNumber)} recorded`}
            </Badge>
            {result.isSecondVisit ? <Badge tone="info">Second visit — strongest signal</Badge> : null}
            {result.personCreated ? (
              <Badge tone="neutral">New record created</Badge>
            ) : (
              <Badge tone="neutral">Matched an existing record</Badge>
            )}
          </div>

          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-slate-900">
            Thank you, {result.fullName.split(" ")[0]}.
          </h1>

          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Your next step</p>
            <p className="mt-1 text-base font-semibold text-slate-900">{result.nextStep.title}</p>
            <p className="mt-1 text-sm text-slate-600">{result.nextStep.detail}</p>
            {result.currentStageName ? (
              <p className="mt-3 text-xs text-slate-500">
                You are on the track at: <span className="font-medium">{result.currentStageName}</span>
              </p>
            ) : null}
          </div>

          {result.reviewFlag ? (
            <p className="mt-4 text-xs text-amber-700">
              A staff member will confirm a detail on your record before it is followed up.
            </p>
          ) : null}

          <div className="mt-6">
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={() => {
                setForm(EMPTY);
                setResult(null);
              }}
            >
              Submit another card
            </button>
          </div>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Connect Card</h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-600">
        Welcome — we would love to know you. If you have been before, use the same name and phone
        number you gave us last time and this lands on your existing record as a returning visit.
      </p>

      {!readiness.ready ? (
        <div className="mt-6">
          <Notice tone="warn" title="This card cannot save anything yet">
            {readiness.message} A staff member needs to finish setup before submissions are stored —
            nothing you type will be kept.
          </Notice>
        </div>
      ) : null}

      {result && result.state !== "ok" ? (
        <div className="mt-6">
          <Notice tone="bad" title={result.state === "invalid" ? "Please check the form" : "That did not save"}>
            {result.state === "invalid"
              ? Object.values(result.errors)[0]
              : result.state === "setup-required"
                ? result.message
                : result.message}
          </Notice>
        </div>
      ) : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-6">
        <Card title="You">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="First name" htmlFor="firstName" error={errors.firstName}>
              <input
                id="firstName"
                className={inputClass}
                value={form.firstName}
                onChange={(e) => update("firstName", e.target.value)}
                autoComplete="given-name"
              />
            </Field>
            <Field label="Last name" htmlFor="lastName" error={errors.lastName}>
              <input
                id="lastName"
                className={inputClass}
                value={form.lastName}
                onChange={(e) => update("lastName", e.target.value)}
                autoComplete="family-name"
              />
            </Field>
            <Field
              label="Email"
              htmlFor="email"
              error={errors.email}
              hint="An email or a phone number is required — it is how we keep your record straight."
            >
              <input
                id="email"
                type="email"
                className={inputClass}
                value={form.email}
                onChange={(e) => update("email", e.target.value)}
                autoComplete="email"
              />
            </Field>
            <Field label="Phone" htmlFor="phone" error={errors.phone}>
              <input
                id="phone"
                type="tel"
                className={inputClass}
                value={form.phone}
                onChange={(e) => update("phone", e.target.value)}
                autoComplete="tel"
              />
            </Field>
          </div>
        </Card>

        <Card title="Address" subtitle="Optional, but it is what tells two people with the same name apart.">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field label="Street address" htmlFor="addressLine1">
                <input
                  id="addressLine1"
                  className={inputClass}
                  value={form.addressLine1}
                  onChange={(e) => update("addressLine1", e.target.value)}
                  autoComplete="address-line1"
                />
              </Field>
            </div>
            <Field label="City" htmlFor="city">
              <input
                id="city"
                className={inputClass}
                value={form.city}
                onChange={(e) => update("city", e.target.value)}
                autoComplete="address-level2"
              />
            </Field>
            <Field label="State / region" htmlFor="region">
              <input
                id="region"
                className={inputClass}
                value={form.region}
                onChange={(e) => update("region", e.target.value)}
                autoComplete="address-level1"
              />
            </Field>
            <Field label="Postal code" htmlFor="postalCode">
              <input
                id="postalCode"
                className={inputClass}
                value={form.postalCode}
                onChange={(e) => update("postalCode", e.target.value)}
                autoComplete="postal-code"
              />
            </Field>
          </div>
        </Card>

        <Card title="Your visit">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-slate-700">Is this your first time with us?</legend>
            {(
              [
                ["first_time", "This is my first time"],
                ["returning", "I have been before"],
                ["unsure", "I am not sure"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="radio"
                  name="visitReport"
                  value={value}
                  checked={form.visitReport === value}
                  onChange={() => update("visitReport", value)}
                />
                {label}
              </label>
            ))}
          </fieldset>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Who else is in your household?" htmlFor="householdMembers">
              <input
                id="householdMembers"
                className={inputClass}
                value={form.householdMembers}
                onChange={(e) => update("householdMembers", e.target.value)}
                placeholder="Names and ages"
              />
            </Field>
            <Field label="Kids coming with you" htmlFor="children">
              <input
                id="children"
                className={inputClass}
                value={form.children}
                onChange={(e) => update("children", e.target.value)}
                placeholder="Names and ages"
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label="How did you hear about us?" htmlFor="howHeard">
                <input
                  id="howHeard"
                  className={inputClass}
                  value={form.howHeard}
                  onChange={(e) => update("howHeard", e.target.value)}
                  placeholder="A friend, an event, online…"
                />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label="Anything we can pray about with you?" htmlFor="prayerRequest">
                <textarea
                  id="prayerRequest"
                  rows={3}
                  className={inputClass}
                  value={form.prayerRequest}
                  onChange={(e) => update("prayerRequest", e.target.value)}
                />
              </Field>
            </div>
          </div>
        </Card>

        {/* Honeypot — a real person never sees or fills this. */}
        <div className="hidden" aria-hidden="true">
          <label htmlFor="website">Website</label>
          <input
            id="website"
            tabIndex={-1}
            autoComplete="off"
            value={form.website}
            onChange={(e) => update("website", e.target.value)}
          />
        </div>

        <div className="flex items-center gap-3">
          <button type="submit" className={buttonClass} disabled={pending}>
            {pending ? "Sending…" : "Submit connect card"}
          </button>
          <span className="text-xs text-slate-500">
            We keep one record per person — submitting again adds a visit, never a duplicate.
          </span>
        </div>
      </form>
    </main>
  );
}
