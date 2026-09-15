# Testing AI-Powered PDF Parsing

## Quick Start (30 seconds)

### 1. Start the server
```bash
npm run dev:api
# Server runs on http://localhost:3000
```

### 2. Check quota status
```bash
curl http://localhost:3000/api/v1/household/subscription \
  -H "x-household-id: household_1"
```
**Expected response:**
```json
{
  "tier": "free",
  "remaining": 3,
  "canImport": true,
  "reason": "under_limit"
}
```

### 3. Upload a PDF that regex can't parse

Use the provided test PDF (or create your own with an unusual format):

```bash
curl -X POST http://localhost:3000/api/v1/imports/bank-statement \
  -H "x-household-id: household_1" \
  -F "file=@test-statement.pdf"
```

**If regex succeeds** (found transactions):
```json
{
  "extracted": 42,
  "currency": "USD",
  "items": [...]
}
```

**If regex fails but AI succeeds** (0 rows → AI fallback → quota used):
```json
{
  "extracted": 35,
  "currency": "USD",
  "items": [...]
}
```

**Check quota again — should be 2 remaining:**
```bash
curl http://localhost:3000/api/v1/household/subscription \
  -H "x-household-id: household_1"
```
```json
{
  "tier": "free",
  "remaining": 2,
  "canImport": true,
  "reason": "under_limit"
}
```

---

## What Triggers AI Fallback?

The regex parser fails (returns 0 rows) when the bank statement has:
- Non-standard date formats (not MM/DD/YYYY, DD/MM/YYYY, or Month Day format)
- Merged columns (amount and balance squished together with no space)
- Unusual merchant name placement
- Non-English headers
- Vertical-oriented table layout
- CSV-style format without typical banking headers

---

## Test Scenarios

### Scenario 1: Free Tier (3 PDFs/month)
```bash
# PDF 1 - quota check
curl http://localhost:3000/api/v1/household/subscription \
  -H "x-household-id: household_1"
# → remaining: 3

# Upload PDF that needs AI
curl -X POST http://localhost:3000/api/v1/imports/bank-statement \
  -H "x-household-id: household_1" \
  -F "file=@weird-statement.pdf"
# → extracted: N rows

# PDF 2 - check again
curl http://localhost:3000/api/v1/household/subscription \
  -H "x-household-id: household_1"
# → remaining: 2

# PDF 3
curl -X POST http://localhost:3000/api/v1/imports/bank-statement \
  -H "x-household-id: household_1" \
  -F "file=@another-weird.pdf"
# → remaining: 1

# PDF 4 - should fail with 429
curl -X POST http://localhost:3000/api/v1/imports/bank-statement \
  -H "x-household-id: household_1" \
  -F "file=@fourth.pdf"
# → HTTP 429
# {
#   "error": "PDF import quota exceeded. Remaining: 0/3. Upgrade to paid plan for unlimited imports.",
#   "remaining": 0,
#   "tier": "free",
#   "reason": "quota_exceeded"
# }
```

### Scenario 2: Upgrade to Paid
```bash
# Upgrade household to paid
curl -X PATCH http://localhost:3000/api/v1/household/subscription \
  -H "x-household-id: household_1" \
  -H "Content-Type: application/json" \
  -d '{"tier":"paid","expiresAt":"2027-03-01"}'

# Now quota check shows unlimited
curl http://localhost:3000/api/v1/household/subscription \
  -H "x-household-id: household_1"
# → remaining: -1 (unlimited)
# → tier: paid

# Upload unlimited PDFs — no 429 errors
for i in {1..10}; do
  curl -X POST http://localhost:3000/api/v1/imports/bank-statement \
    -H "x-household-id: household_1" \
    -F "file=@test.pdf"
done
# → all succeed
```

### Scenario 3: Subscription Expires
```bash
# Set expiration to past date
curl -X PATCH http://localhost:3000/api/v1/household/subscription \
  -H "x-household-id: household_1" \
  -H "Content-Type: application/json" \
  -d '{"tier":"paid","expiresAt":"2020-01-01"}'

# Try to upload — should fail with 429
curl -X POST http://localhost:3000/api/v1/imports/bank-statement \
  -H "x-household-id: household_1" \
  -F "file=@test.pdf"
# → HTTP 429
# {
#   "error": "PDF import quota exceeded. Remaining: 0/3. Upgrade to paid plan for unlimited imports.",
#   "remaining": 0,
#   "tier": "paid",
#   "reason": "subscription_expired"
# }
```

---

## Creating a Test PDF

### Option 1: Use an Existing Unusual Bank Statement
Find a real bank statement from an uncommon bank and upload it.

### Option 2: Create Test PDF Text
Save this as `test-statement.txt`, then convert to PDF:

```
ALTERNATIVE BANK STATEMENT
Account Holder: Test User
Account #: 1234567890

TRANSACTIONS THIS PERIOD:

Date       | Description              | Withdrawal | Deposit | Balance
2026-03-05 | Salary Deposit           |            | 5000.00 | 5000.00
2026-03-06 | Grocery Store            | 125.43     |         | 4874.57
2026-03-07 | Electric Company         | 89.21      |         | 4785.36
2026-03-10 | Refund                   |            | 50.00   | 4835.36
2026-03-12 | Restaurant               | 42.87      |         | 4792.49
```

Convert to PDF:
```bash
# On Mac/Linux
enscript -B -p test-statement.pdf test-statement.txt

# Or use any PDF tool (Word, Google Docs, Mac Preview, etc.)
```

### Option 3: Download a Real PDF
- Download a PDF from your own bank account
- Or search "sample bank statement PDF" online

---

## Observing AI Parsing in Logs

When the server runs, watch for these logs:

```
[RAF bank import] regex found 0 rows, checking PDF import quota...
[RAF bank import] quota available, attempting AI fallback...
[RAF bank import] AI fallback succeeded, parsed 35 rows
[RAF bank import] failed to record quota usage: ...
```

---

## What Happens Without ANTHROPIC_API_KEY?

If the key is not set or empty:

```bash
# Upload PDF
curl -X POST http://localhost:3000/api/v1/imports/bank-statement \
  -H "x-household-id: household_1" \
  -F "file=@weird-statement.pdf"

# Response: HTTP 422 (same as before AI was added)
# {
#   "error": "statement_parse_failed",
#   "message": "Extracted text was found, but no valid transaction rows were parsed.",
#   "matched_rows_count": 0,
#   ...
# }
```
→ No quota charged, user just gets "parsing failed" error.

---

## Monitoring Quota in Database

```sql
-- See quota usage
SELECT householdId, yearMonth, count FROM pdfImportQuotas;

-- See subscription tiers
SELECT id, pdfImportQuotaTier, pdfImportQuotaExpiresAt FROM households;

-- Reset a household's quota for current month (give them free pass)
DELETE FROM pdfImportQuotas 
WHERE householdId = 'household_1' 
  AND yearMonth = '2026-03';
```

---

## Success Criteria

✅ Regex parses 99% of common bank statements (BMO, TD, Chase, etc.) → **No cost**

✅ Unusual formats trigger AI → **Claude parses** → **~$0.01 cost** → **quota -1**

✅ After 3 AI parses on free tier → **HTTP 429** → User sees quota message

✅ Upgrade to paid → **unlimited parses** → No more 429 errors

✅ Logs show AI attempts and results → Debug-friendly

🎉 Stripe integration ready (just update PATCH endpoint to call Stripe)
