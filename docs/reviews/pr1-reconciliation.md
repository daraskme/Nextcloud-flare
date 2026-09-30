# PR #1 reconciliation

PR #1 was developed in parallel from the repository's initial design commit. The
current `main` branch subsequently replaced that implementation with the hardened
foundation, backup and recovery path, mutation admission, route contract coverage,
read-only public shares, and budgeted public content delivery.

A direct merge is unsafe:

- 58 paths have independent add/add histories.
- The legacy tree would remove 419 files that now belong to the current
  implementation.
- It would reintroduce 202 files built around the superseded routing, migration,
  frontend, authentication, and test layouts.

The conflict resolution therefore keeps the current `main` tree and retires the
parallel implementation instead of combining incompatible storage and authority
models. The historical commits remain available through PR #1 for reference.

Features described by the old PR are not treated as delivered merely because they
exist in its historical branch. Password-protected shares, upload-only and internal
shares, shared DAV, ZIP, Gallery, Bookshelf, Audio, and the remaining release gates
must be implemented and verified as focused changes on the current architecture.
