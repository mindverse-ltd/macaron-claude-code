#!/usr/bin/env node
// mcx (standalone package) — published so `npx mcx@…` resolves bin name =
// package name (npx/npm exec pick the bin by package name and would otherwise
// fall back to `mcc`'s default bin). It ships no logic of its own: it re-runs
// mcc's own `mcx` launcher, which boots mcc's prebuilt server with the Codex
// SPA. Single source of truth — the launcher lives once, in the `mcc` package.
// (mcc has no `exports` field, so this subpath import is allowed.)
import 'mcc/bin/mcx.mjs';
