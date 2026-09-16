# Task 03 — Publish the MVP and verify the live public URL

**Backlog id:** `c68082ab-50d0-4305-a43f-dcfce37e5257`
**Status:** Blocked on task 01 (publish gate = finished end-to-end verification).

## Goal

The MVP is live on the public site and the owner can send the URL to a prospective pilot church:
a guest enters on the connect card → lands in the pipeline → is moved stage by stage → a decision is
logged → the overdue task list built itself.

## How

1. **Prerequisite:** task 01 complete. Also decide whether to reseed first (`bun run db:seed --reset`)
   so the live site starts from clean demo data — note this wipes the TEST-Veronica test person and
   any test moves; it rebuilds the same 11 demo people.
2. **Publish is a lead action:** the `publish_site` tool (or the SITE tab's Publish button). Members
   never run `publish.sh`. Takes a minute or two; success swaps the live copy, failure returns the
   build error.
3. **Verify the live URL end to end** in a real browser against the *published* environment, not
   localhost: submit a guest on the public `/connect`, sign in as staff, find them on the board, move
   them, log a contact, check `/staff/tasks`, open their record. (`DATABASE_URL` reaches the
   published site automatically.)
4. Tell the owner the live URL and what was verified.

## Known environment facts

- Working site (preview): https://8d6b4312d2b255442c72233f7e04107a-dev.ctonew.app
- Live site (public): https://8d6b4312d2b255442c72233f7e04107a.ctonew.app — until first publish it
  just mirrors the working site.
- The owner can see both environments on the SITE tab (Preview/Published toggle).

## Definition of done

`publish_site` succeeded; every step of the flow clicked and observed on the public URL; owner told
what is live and what was verified.
