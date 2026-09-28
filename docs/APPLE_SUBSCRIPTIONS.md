# Apple personal subscription rollout

Status (2026-09-29): preparation only. No StoreKit SDK, purchase endpoint,
verified Apple entitlement, store product registration or paid native release
is implemented by the catalog. The submitted 1.0.0 binary is unchanged.

## Approved direction

- Start with one-person monthly subscriptions, not 5/10/20-seat packs.
- Keep existing Team and Business feature tiers. The draft product IDs are in
  `mobile/release/apple-subscriptions.json`; do not register them until reviewed.
- Web seat prices are not approved Apple storefront prices. Both Apple prices
  remain null until the owner confirms them and App Store Connect pricing is read.
- Domestic web uses Payple. Do not onboard PayPal for this request.
- iOS digital subscriptions use StoreKit In-App Purchase, not Apple Pay. Do not
  add a Korean external-purchase link without its separate entitlement review.

## Entitlement design for implementation

The first catalog applies to one workspace with one active editor (its owner).
Viewers keep their existing permissions. Buying one seat must never set an
unlimited-editor workspace plan. Multi-editor teams continue using the existing
web seat subscription until a separately approved native team product exists.

Bind an opaque server-created UUID appAccountToken to the authenticated purchaser
and the selected workspace before purchase. Keep the original transaction ID
unique across OKRI accounts and workspaces. Restore can recover that same
entitlement, never silently move it or grant it to every workspace. Existing
Payple/PayPal subscriptions block overlapping Apple checkout.

Enforce the one-editor cap atomically at invitation acceptance, role promotion,
reactivation and ownership changes, including web, MCP, Slack and native writes.
Never downgrade an existing team's other editors as a side effect of purchase.

Use Apple's server library for signed transaction verification and notification
V2 validation: certificate chain, bundle/app ID, environment, product allowlist,
account token, revocation and expiration. Client success and unverified decoded
JWS are never entitlement evidence. Notifications may repeat or arrive out of
order; reconcile current Apple status before changing access. Sandbox purchases
must not grant production entitlements. Preserve paid-through access after
auto-renew is disabled; handle refunds, revocation and billing grace explicitly.

## Release blockers and evidence

1. Owner-approved prices, paid-app agreement, tax and bank setup, store products.
2. Additive server schema and isolated Apple purchase/notification handlers.
3. StoreKit purchase, cancellation, pending/Ask to Buy, restore and management UI.
   Display localized prices from StoreKit, not currency conversion in the app.
4. Mocked provider/DB tests for identity, duplicate delivery, concurrency, renewal,
   downgrade/upgrade, refunds, expired/offline responses and cross-workspace abuse.
5. Sandbox StoreKit tests on the exact signed physical-device build; localized
   renewal terms, privacy/terms links and restore controls verified.
6. New store binary and first-subscription review. Do not cancel the currently
   submitted binary or alter its commerce declarations without explicit approval.

Until these gates pass, purchaseEnabled stays false. A draft catalog is not a
payment implementation and is not a production entitlement source.

## Official references

- https://developer.apple.com/app-store/subscriptions/
- https://developer.apple.com/documentation/appstoreserverapi/appaccounttoken
- https://developer.apple.com/documentation/appstoreservernotifications
- https://developer.apple.com/support/storekit-external-entitlement-kr/
