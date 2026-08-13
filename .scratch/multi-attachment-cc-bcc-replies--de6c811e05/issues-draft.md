# Proposed vertical slices

1. Relay contract and attachment boundary — AFK — Blocked by: None — Covers user stories 1,2,8,9
2. Send persistence and Reply All privacy — AFK — Blocked by: 1 — Covers user stories 3,4,5,6,7,9
3. Compose and Reply All UI — AFK — Blocked by: 2 — Covers user stories 1,3,4,5,9
4. End-to-end verification and release manifest — AFK — Blocked by: 3 — Covers user stories 8,9,10

All slices are narrow vertical slices and can be implemented non-interactively in dependency order. The relay repository and skill update is a release prerequisite captured within slice 1 and must be handled through its own controlled upstream flow before final deployment.
