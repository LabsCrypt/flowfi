#867 [Testing] Add unit tests for TopUpModal (precision-filtered input, validation, new-total preview)
Repo Avatar
LabsCrypt/flowfi
Telegram (ask questions / claim the issue here first): https://t.me/+DOylgFv1jyJlNzM0

Why this matters
frontend/src/components/stream-creation/TopUpModal.tsx has untested behavior: the onChange regex/precision filter that rejects non-numeric and >7-decimal input, validateAmountInput + hasValidPrecision in validate(), the newTotal = currentDeposited + parsedAmount preview, and Enter-to-confirm. No test file references TopUpModal.

Acceptance criteria
 Test that non-numeric and over-precision keystrokes are rejected by the input
 Test that Confirm is blocked and an error shows for empty/invalid/over-precision amounts
 Test that the new-total preview only appears for a positive amount and equals currentDeposited + amount
 Test that onConfirm is called with (streamId, amount) on confirm/Enter
Files to touch
frontend/src/components/stream-creation/TopUpModal.tsx
Out of scope
Soroban top-up transaction wiring


#866 [Testing] Add unit tests for ScheduleStep rate calculation and preview rendering
Repo Avatar
LabsCrypt/flowfi
Telegram (ask questions / claim the issue here first): https://t.me/+DOylgFv1jyJlNzM0

Why this matters
frontend/src/components/stream-creation/ScheduleStep.tsx has untested logic: totalSeconds via SECONDS_PER_UNIT, ratePerSecond = amount/totalSeconds, the formattedRate sec/min/hr buckets, and the ratePerDayPreview currency formatting. components.test.tsx covers RecipientStep/AmountStep/CancelConfirmModal but ScheduleStep has no test.

Acceptance criteria
 Test ratePerSecond/total-seconds for at least seconds, days, and months units
 Test that EURC uses a Euro symbol (not $) and XLM uses the token suffix in the rate/day preview
 Test that zero/empty amount or duration renders no rate preview
 Test the sec vs /min vs /hr formatting threshold branches
Files to touch
frontend/src/components/stream-creation/ScheduleStep.tsx
Out of scope
Full StreamCreationWizard integration test

#864 [Frontend] StreamDetailsModal & CancelConfirmModal render raw token amounts; remaining uses float subtraction
Repo Avatar
LabsCrypt/flowfi
Telegram (ask questions / claim the issue here first): https://t.me/+DOylgFv1jyJlNzM0

Why this matters
frontend/src/components/dashboard/StreamDetailsModal.tsx:30,94-95,106,138 renders {stream.withdrawn}/{stream.deposited}/{remaining} with no formatter, and remaining = stream.deposited - stream.withdrawn is plain JS float subtraction (artifacts like 99.99999999). CancelConfirmModal.tsx:39,106-110,118 has the identical raw-render. The stream-detail page uses formatAmount for the same values.

Acceptance criteria
 deposited/withdrawn/remaining are rendered through a shared amount formatter (consistent decimals)
 remaining is computed without producing floating-point display artifacts
 StreamDetailsModal and CancelConfirmModal match the formatting used on the stream-detail page
Files to touch
frontend/src/components/dashboard/StreamDetailsModal.tsx
frontend/src/components/stream-creation/CancelConfirmModal.tsx
Out of scope
Changing the Stream data model

#865 [Frontend] Settings Display Preferences (Default Token / Amount Format / Decimal Places) are a no-op - never consumed anywhere
Repo Avatar
LabsCrypt/flowfi
Telegram (ask questions / claim the issue here first): https://t.me/+DOylgFv1jyJlNzM0

Why this matters
frontend/src/app/settings/page.tsx:244-307 lets users pick Default Token, Amount Format, and Decimal Places and persists them to localStorage, and useSettings exports formatAmountWithPreference/getDecimalPlaces/getAmountFormat/getDisplayCurrency. A repo-wide grep shows these helpers and useSettings have ZERO consumers - every amount uses hardcoded formatters. The settings controls produce no visible effect.

Acceptance criteria
 Amount rendering reads the user's decimalPlaces/amountFormat preference in the main amount displays, or
 If the preference feature is not ready, the non-functional controls are removed/marked clearly
 Changing Decimal Places visibly changes displayed amounts on at least the dashboard and stream detail views
Files to touch
frontend/src/app/settings/page.tsx
frontend/src/hooks/useSettings.ts
Out of scope
Theme toggle (which does work)
Currency conversion / price feeds