# Phase 1 — Storefront Contract Audit

## Verified issue

`GET /api/storefront/discover` accepts a `category` query parameter, but the Prisma `where.businessProfile` filter must apply `category` directly to the business profile relation. A nested `businessProfile` relation inside that relation is incorrect and prevents the category filter from matching the intended field.

## Required invariant

For `GET /api/storefront/discover?category=X`, every returned storefront must have `businessProfile.category === X` while retaining the existing published, non-suspended, non-paused constraints.

## Frontend compatibility

The Flutter client already sends `category` through the storefront discovery service. The backend must therefore enforce the filter at the database query boundary rather than relying on client-side filtering.

## Scope

This audit deliberately does not redesign the storefront schema. It records the smallest verified contract correction before category-specific marketplace work begins.
