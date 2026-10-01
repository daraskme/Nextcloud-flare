# Internal Share Reshare

Internal resharing is explicit delegation of an existing direct-user or group share. Ordinary
`read` or `download` access never implies delegation authority. The source owner must attach an
enabled reshare policy to the original share.

## Authority model

The owner policy fixes:

- the actions descendants may receive;
- the maximum delegation depth, from 1 through 4;
- the maximum active fan-out per source share, from 1 through 20;
- an optional policy expiry.

Every descendant stores immutable authority lineage: source share and version, policy share and
version, delegating user, group membership and version when applicable, depth, and root ancestry.
A downstream root must be the source root or one of its descendants. Its actions and expiry must
be subsets of both the current source share and the pinned owner policy.

Only the original owner may create or change a policy. Descendants cannot define a new policy or
expand the original policy. A delegating recipient may narrow a current descendant's actions or
revoke it while the pinned source authority remains current.

## Current authority

`current_internal_shares` is the common liveness boundary for API reads, DAV resolution,
authorization, budgets, tickets, content acceptance, content sessions, and BudgetDO validation.
Delegated rows additionally require a valid `share_delegation_status` row.

D1 triggers invalidate the affected descendant closure when any pinned authority changes:

- source version, disable state, root, expiry, or actions;
- owner policy version, enable state, actions, bounds, or expiry;
- direct recipient grant;
- group membership removal or membership-version change;
- owner, delegator, or recipient disablement;
- deletion, ownership change, or parent change for a node in the captured ancestry.

Re-adding a group member creates a new membership version and does not reactivate old descendants.
Renames do not alter node identity or ancestry, so stable share mount names remain valid.

## Mutation fencing and recovery

Create, update, and revoke use the source owner's account-mutation admission. The committed D1
batch rechecks epoch, maintenance, credential, source version, recipient or membership version,
policy version, root ancestry, depth, fan-out, and authorization proof.

Downstream create requires `Idempotency-Key`. Its identity binds user, current access credential,
and key; its canonical digest binds source, root, space, recipient, actions, and expiry. The share,
lineage, ancestry, validity row, and request receipt commit atomically. A repeated identical
request returns the persisted share after rechecking current source authority. Reusing the key
with different input returns a conflict. If the D1 response is lost after commit, the receipt
allows the caller to converge on the committed result without creating another share.

Lifecycle invalidation also revokes descendant content sessions and active budgets. Ticket,
content-session, and budget assertions recheck `current_internal_shares`, so stale credentials or
previously issued content authority cannot restore an invalid descendant.

## API

Owner policy is accepted as `resharePolicy` on internal-share creation or PATCH:

```json
{
  "enabled": true,
  "actions": ["read", "download"],
  "maxDepth": 2,
  "maxFanout": 5,
  "ttlDays": 30
}
```

A downstream internal-share POST supplies `sourceShareId` and an `Idempotency-Key` header. It may
target one internal user or one owner-managed internal group, using the same recipient fields as
an original internal share.

## Bounds

Ancestry walks stop at 64 nodes and reject cycles. Delegation depth, policy fan-out, the existing
active-share limit, group membership limits, and exact-recipient checks remain independently
enforced. Invalidated descendants do not consume reusable fan-out capacity, but their immutable
lineage and request receipts remain for audit and idempotency conflict detection.
