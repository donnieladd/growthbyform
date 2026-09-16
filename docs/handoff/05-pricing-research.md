# Task 05 — Pricing research: what comparable church software actually charges

**Backlog id:** `05271c23-f643-4e6c-a83f-d991b3b0dca2`
**Status:** Not started. Needs web access; can run as a read-only delegation.

## Goal

Produce the input to our first pricing model: what comparable church software charges per church and
what that price includes, with sources. This is research only — no pricing decision gets made without
the owner.

## Targets

Planning Center, Church Community Builder, Breeze, Rock, Tithe.ly — and add any comparable that
surfaces (e.g. Subsplash, Pushpay, Exponential Track, ChurchTrac).

## What to capture per competitor

1. Pricing model: flat per-church, per-person tiers, modules à la carte, free tier?
2. Actual numbers per tier, and what gates each tier.
3. What's included: people/pipeline management, automation, messaging (SMS/email — ours is in-house
   and metered; theirs may be add-ons), groups, giving, check-in.
4. Contract shape: monthly vs annual, setup fees, discounts.
5. Which of the five daily users (coach, group leader, ministry lead, discipleship pastor, member)
   each product actually serves.

## Output

A single markdown file at `/home/team/shared/handoff/pricing-research.md` — a comparison table plus
source links, and a short "what this implies for us" section (clearly labeled as the researcher's
observation, not a decision). Note where vendors hide pricing behind "talk to sales".

## Feed into

Our own tier design folds in real cost inputs: one subscription covers the whole app including
messaging on our own multi-tenant infrastructure, metered per church — send volume is a cost input.
Pricing itself is the owner's decision (see task 06).
