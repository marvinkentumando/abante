# Firestore Security Specification — QueueLine (Shared Facility Queue Model)

## 1. Data Invariants

1. **Default Deny Catch-All**: Every path not explicitly matched is denied (`allow read, write: if false;`).
2. **Shared Facility Queue (`facilityId == 'main-counter'`)**:
   - **Public Kiosk & Display Read Access**: Customers and display screens can `get` and `list` documents in `queue_customers` and `queue_activities` ONLY when `resource.data.facilityId == 'main-counter'`.
   - **Public Kiosk Self-Check-In (`create`)**: Unauthenticated customers at the kiosk can create a new `queue_customers` ticket ONLY with `status == 'Waiting'`, `facilityId == 'main-counter'`, no `calledAt`/`completedAt` fields, valid field lengths/patterns, and server timestamps (`createdAt == request.time && updatedAt == request.time`).
   - **Atomic Sequence Counter (`/queue_counters/main-counter`)**: Public check-in transactions may increment `lastSequenceNumber` by exactly `+1` (`incoming().lastSequenceNumber == existing().lastSequenceNumber + 1`). Only authorized staff (`isAdmin()`) may reset `lastSequenceNumber` to an arbitrary valid integer.
3. **Authorized Staff Role Enforcement (`update` / `delete`)**:
   - Calling the next customer, changing ticket statuses (`Waiting`, `Serving`, `Served`, `Skipped`), and deleting/clearing tickets are strictly restricted to `isAdmin()` (verified Google-authenticated staff via bootstrapped admin email or `/admins/{uid}`).
   - Even for authorized staff, `Served` and `Skipped` tickets cannot be updated directly to `Serving` unless through an explicit re-queue to `Waiting` first.

## 2. The "Dirty Dozen" Adversarial Payloads

1. **Payload 1 (Unauthenticated Status Tampering)**: Public kiosk user attempts to `update` a `queue_customers` ticket status to `'Serving'`.
2. **Payload 2 (Kiosk Self-Insert as Serving)**: Public kiosk user attempts to `create` a `queue_customers` ticket with `status: 'Serving'` instead of `'Waiting'`.
3. **Payload 3 (Shadow Field Injection)**: Create `queue_customers` with an undeclared field `"isPriority": true`.
4. **Payload 4 (Path ID Poisoning)**: Create `queue_customers/invalid$id!@#` violating `^[a-zA-Z0-9_\-]+$`.
5. **Payload 5 (Denial-of-Wallet Oversized String)**: Create `queue_customers` with `name` of length 5,000 characters (`maxLength: 80`).
6. **Payload 6 (Invalid Status Enum)**: Staff attempts to update `queue_customers` with `status: "HackedStatus"`.
7. **Payload 7 (Forged Client Timestamp)**: Create `queue_customers` with a forged `createdAt` not equal to `request.time`.
8. **Payload 8 (Immutable Field Tampering)**: Staff attempts to update `queueCode` or `sequenceNumber` on an existing ticket.
9. **Payload 9 (Unscoped List Query)**: Client queries `queue_customers` without `facilityId == 'main-counter'`.
10. **Payload 10 (Counter Jump Attack)**: Unauthenticated kiosk user attempts to update `/queue_counters/main-counter` by jumping `lastSequenceNumber` by `+500` instead of `+1`.
11. **Payload 11 (Activity Log Mutation)**: Attempt to `update` an immutable `queue_activities` audit record.
12. **Payload 12 (Unverified Email Staff Escalation)**: User with `email_verified: false` attempts to create `/admins/{uid}` or update queue statuses.
